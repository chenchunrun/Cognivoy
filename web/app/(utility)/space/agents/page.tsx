"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Bot,
  FolderSync,
  Plus,
  RefreshCw,
  Settings2,
  Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { PageHeader } from "@/components/shell/PageHeader";
import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  DialogFooter,
  DialogTitle,
  EmptyState,
  Input,
  Select,
  Skeleton,
  Toggle,
  useToast,
} from "@/components/ui";
import {
  buildSelectGroups,
  filterRefsByScope,
  importRefsIncrementally,
  pickAndScan,
  recommendedInitialScope,
  scanDirectory,
  selectionUnit,
  SOURCE_LABEL,
  type AgentScope,
  type ScanResult,
  type SessionRef,
} from "@/lib/chat-import";
import {
  assignSessionsToAgents,
  groupServerImportedAgents,
} from "@/lib/chat-import/attribution";
import {
  deleteAgent,
  ensureReadPermission,
  getAgents,
  newAgentId,
  saveAgent,
  type ImportAgent,
} from "@/lib/chat-import/agent-store";
import { importChatHistory, listImportedSessions } from "@/lib/imports-api";
import type { SessionSummary } from "@/lib/session-api";
import {
  connectSubagent,
  detectSubagents,
  disconnectSubagent,
  listKimiHistory,
  listOpenCodeHistory,
  listSubagentConnections,
  parseKimiHistory,
  parseOpenCodeHistory,
  type KimiHistorySession,
  type OpenCodeHistorySession,
  type SubagentBackendInfo,
  type SubagentConnection,
} from "@/lib/subagents-api";

type ScopeMode = "all" | "groups" | "sessions";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function initialScopeMode(agent?: ImportAgent | null): ScopeMode {
  if (!agent || agent.scope.kind === "all") return "all";
  return agent.scope.kind === "sessions" ? "sessions" : "groups";
}

function initialSelection(agent?: ImportAgent | null): Set<string> {
  if (!agent) return new Set();
  if (agent.scope.kind === "projects") return new Set(agent.scope.cwds);
  if (agent.scope.kind === "dates") return new Set(agent.scope.days);
  if (agent.scope.kind === "sessions") return new Set(agent.scope.externalIds);
  return new Set();
}

function refsFor(scan: ScanResult): SessionRef[] {
  return scan.projects
    .flatMap((project) => project.sessions)
    .sort((a, b) => b.lastModified - a.lastModified);
}

function ImportAgentDialog({
  open,
  agent,
  onClose,
  onSaved,
}: {
  open: boolean;
  agent?: ImportAgent | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [scan, setScan] = React.useState<ScanResult | null>(null);
  const [name, setName] = React.useState(() => agent?.name ?? "");
  const [scopeMode, setScopeMode] = React.useState<ScopeMode>(() =>
    initialScopeMode(agent),
  );
  const [selected, setSelected] = React.useState<Set<string>>(() =>
    initialSelection(agent),
  );
  const [busy, setBusy] = React.useState(false);
  const [progress, setProgress] = React.useState("");

  const choose = async () => {
    setBusy(true);
    try {
      const next = agent
        ? await (async () => {
            if (!(await ensureReadPermission(agent.handle))) {
              throw new Error(t("Folder permission was not granted"));
            }
            return scanDirectory(agent.handle);
          })()
        : await pickAndScan();
      setScan(next);
      if (!agent) {
        const scope = recommendedInitialScope(next);
        setScopeMode("groups");
        setSelected(
          new Set(scope.kind === "projects" ? scope.cwds : scope.kind === "dates" ? scope.days : []),
        );
      }
      setName((current) => current || SOURCE_LABEL[next.source]);
    } catch (reason) {
      const code = (reason as { code?: string }).code;
      if (code !== "aborted") {
        const description =
          code === "not_recognized"
            ? t("Choose the .claude or .codex folder itself. On macOS press Command+Shift+. to show hidden folders.")
            : code === "unsupported_browser"
              ? t("This browser cannot read local folders. Use Chrome or Edge to import history.")
              : code === "picker_failed"
                ? t("The selected folder could not be opened. Check its permission and try again.")
                : reason instanceof Error
                  ? reason.message
                  : String(reason);
        toast({
          title: t("Couldn't scan agent history"),
          description,
          variant: "destructive",
        });
      }
    } finally {
      setBusy(false);
    }
  };

  const groups = React.useMemo(
    () => (scan ? buildSelectGroups(scan) : []),
    [scan],
  );
  const refs = React.useMemo(() => (scan ? refsFor(scan) : []), [scan]);
  const choices = scopeMode === "sessions" ? refs : groups;
  const selectedCount =
    scopeMode === "all" ? refs.length : selected.size;
  const selectedRefs = React.useMemo(() => {
    if (!scan) return [];
    if (scopeMode === "all") return refs;
    if (scopeMode === "sessions") {
      return refs.filter((ref) => selected.has(ref.externalId));
    }
    const selectedGroups = new Set(selected);
    return groups.flatMap((group) =>
      selectedGroups.has(group.key) ? group.sessions : [],
    );
  }, [groups, refs, scan, scopeMode, selected]);
  const selectedBytes = React.useMemo(
    () => selectedRefs.reduce((total, ref) => total + ref.sizeBytes, 0),
    [selectedRefs],
  );

  const changeMode = (mode: ScopeMode) => {
    setScopeMode(mode);
    if (mode === "all") return;
    const keys =
      mode === "sessions"
        ? refs.slice(0, 10).map((ref) => ref.externalId)
        : groups.slice(0, 1).map((group) => group.key);
    setSelected(new Set(keys));
  };

  const save = async () => {
    if (!scan || !name.trim() || selectedCount === 0) return;
    setBusy(true);
    try {
      const unit = selectionUnit(scan.source);
      const scope: AgentScope =
        scopeMode === "all"
          ? { kind: "all" }
          : scopeMode === "sessions"
            ? { kind: "sessions", externalIds: [...selected] }
            : unit === "projects"
              ? { kind: "projects", cwds: [...selected] }
              : { kind: "dates", days: [...selected] };
      const scopedRefs = filterRefsByScope(refs, scope);
      const nextAgent: ImportAgent = {
        id: agent?.id ?? newAgentId(scan.source),
        name: name.trim(),
        source: scan.source,
        folderName: scan.handle.name,
        handle: scan.handle,
        scope,
        createdAt: agent?.createdAt ?? Date.now(),
        lastSyncAt: Date.now(),
      };
      const result = await importRefsIncrementally(
        scan.source,
        scopedRefs,
        (sessions) =>
          importChatHistory(scan.source, sessions, {
            id: nextAgent.id,
            name: nextAgent.name,
          }),
        (done, total) =>
          setProgress(
            t("Importing {{done}} of {{total}} conversations", { done, total }),
          ),
      );
      if (result.imported + result.skipped === 0) {
        throw new Error(t("No readable conversations were found in the selected scope."));
      }
      await saveAgent(nextAgent);
      toast({
        title: t("Agent imported"),
        description: result.unreadable
          ? t("Added {{count}} conversations; skipped {{skipped}} unreadable files", {
              count: result.imported,
              skipped: result.unreadable,
            })
          : t("Added {{count}} conversations", {
              count: result.imported,
            }),
        variant: "success",
      });
      onSaved();
      onClose();
    } catch (reason) {
      toast({
        title: t("Import failed"),
        description: reason instanceof Error ? reason.message : String(reason),
        variant: "destructive",
      });
    } finally {
      setBusy(false);
      setProgress("");
    }
  };

  return (
    <Dialog open={open} onClose={onClose} className="max-w-2xl">
      <DialogTitle>
        {agent ? t("Edit agent scope") : t("Import agent history")}
      </DialogTitle>
      {!scan ? (
        <div className="py-8 text-center">
          <FolderSync size={36} className="mx-auto text-muted-foreground" />
          <p className="mx-auto mt-3 max-w-md text-sm text-muted-foreground">
            {t(
              "Choose a .claude or .codex home folder. Files are parsed locally in your browser.",
            )}
          </p>
          <Button className="mt-5" onClick={() => void choose()} loading={busy}>
            {agent ? t("Load saved folder") : t("Choose folder")}
          </Button>
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          <label className="block text-sm text-foreground">
            <span className="mb-1 block text-xs text-muted-foreground">
              {t("Agent name")}
            </span>
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <div>
            <span className="mb-2 block text-xs font-medium text-muted-foreground">
              {t("Conversation scope")}
            </span>
            <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label={t("Conversation scope")}>
              {([
                ["all", "All conversations"],
                ["groups", selectionUnit(scan.source) === "projects" ? "Selected projects" : "Selected dates"],
                ["sessions", "Selected conversations"],
              ] as const).map(([mode, label]) => (
                <Button
                  key={mode}
                  type="button"
                  size="sm"
                  variant={scopeMode === mode ? "primary" : "outline"}
                  onClick={() => changeMode(mode)}
                >
                  {t(label)}
                </Button>
              ))}
            </div>
            {scopeMode === "all" ? (
              <div className="rounded-xl border border-border bg-muted-subtle p-4 text-sm text-muted-foreground">
                {t("All current and future conversations in this folder will stay in sync.")}
              </div>
            ) : (
              <>
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">
                    {t("{{selected}} of {{total}} selected", {
                      selected: selected.size,
                      total: choices.length,
                    })}
                  </span>
                  <button
                    type="button"
                    className="text-xs text-primary"
                    onClick={() =>
                      setSelected(
                        selected.size === choices.length
                          ? new Set()
                          : new Set(
                              scopeMode === "sessions"
                                ? refs.map((ref) => ref.externalId)
                                : groups.map((group) => group.key),
                            ),
                      )
                    }
                  >
                    {selected.size === choices.length ? t("Clear all") : t("Select all")}
                  </button>
                </div>
                <div className="max-h-72 space-y-1 overflow-y-auto rounded-xl border border-border p-2">
                  {scopeMode === "sessions"
                    ? refs.map((ref) => (
                        <ScopeChoice
                          key={ref.externalId}
                          choiceKey={ref.externalId}
                          label={ref.provisionalTitle || t("Untitled conversation")}
                          sublabel={`${ref.date} · ${ref.cwd}`}
                          selected={selected}
                          setSelected={setSelected}
                        />
                      ))
                    : groups.map((group) => (
                        <ScopeChoice
                          key={group.key}
                          choiceKey={group.key}
                          label={group.label}
                          sublabel={group.sublabel}
                          count={group.sessions.length}
                          selected={selected}
                          setSelected={setSelected}
                        />
                      ))}
                </div>
              </>
            )}
            <p className="mt-2 text-xs text-muted-foreground">
              {t("{{count}} conversations · {{size}} of source data", {
                count: selectedRefs.length,
                size: formatBytes(selectedBytes),
              })}
            </p>
            {selectedBytes > 512 * 1024 * 1024 ? (
              <p className="mt-2 rounded-lg border border-warning-border bg-warning-muted p-3 text-xs text-foreground">
                {t("This is a large import. It will be saved in small batches and may take several minutes.")}
              </p>
            ) : null}
          </div>
          {progress ? (
            <p role="status" className="text-xs text-muted-foreground">
              {progress}
            </p>
          ) : null}
        </div>
      )}
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          {t("Cancel")}
        </Button>
        {scan ? (
          <Button
            onClick={() => void save()}
            loading={busy}
            disabled={!name.trim() || selectedCount === 0}
          >
            {t("Import and save")}
          </Button>
        ) : null}
      </DialogFooter>
    </Dialog>
  );
}

function ScopeChoice({
  choiceKey,
  label,
  sublabel,
  count,
  selected,
  setSelected,
}: {
  choiceKey: string;
  label: string;
  sublabel?: string;
  count?: number;
  selected: Set<string>;
  setSelected: React.Dispatch<React.SetStateAction<Set<string>>>;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-3 rounded-lg p-2 hover:bg-muted">
      <Toggle
        checked={selected.has(choiceKey)}
        onCheckedChange={(checked) =>
          setSelected((current) => {
            const next = new Set(current);
            if (checked) next.add(choiceKey);
            else next.delete(choiceKey);
            return next;
          })
        }
        aria-label={label}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-foreground">{label}</span>
        {sublabel ? (
          <span className="block truncate text-xs text-muted-foreground">
            {sublabel}
          </span>
        ) : null}
      </span>
      {count !== undefined ? <Badge variant="outline">{count}</Badge> : null}
    </label>
  );
}

function ConnectCliDialog({
  open,
  backends,
  onClose,
  onConnected,
}: {
  open: boolean;
  backends: SubagentBackendInfo[];
  onClose: () => void;
  onConnected: () => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const available = React.useMemo(
    () => backends.filter((backend) => backend.available),
    [backends],
  );
  const [kind, setKind] = React.useState(() => available[0]?.kind ?? "");
  const [name, setName] = React.useState(() => available[0]?.display_name ?? "");
  const [cwd, setCwd] = React.useState("");
  const [agentProfile, setAgentProfile] = React.useState("");
  const [kimiSessions, setKimiSessions] = React.useState<KimiHistorySession[]>([]);
  const [kimiProfiles, setKimiProfiles] = React.useState<string[]>([]);
  const [selectedKimiSessions, setSelectedKimiSessions] = React.useState<Set<string>>(new Set());
  const [scanningKimi, setScanningKimi] = React.useState(false);
  const [openCodeSessions, setOpenCodeSessions] = React.useState<OpenCodeHistorySession[]>([]);
  const [selectedOpenCodeSessions, setSelectedOpenCodeSessions] = React.useState<Set<string>>(new Set());
  const [scanningOpenCode, setScanningOpenCode] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  const scanKimi = React.useCallback(async (targetCwd = "") => {
    setScanningKimi(true);
    try {
      const result = await listKimiHistory(targetCwd.trim());
      setKimiSessions(result.sessions);
      setKimiProfiles(result.profiles);
    } catch (reason) {
      toast({
        title: t("Couldn't scan Kimi history"),
        description: reason instanceof Error ? reason.message : String(reason),
        variant: "destructive",
      });
    } finally {
      setScanningKimi(false);
    }
  }, [t, toast]);

  React.useEffect(() => {
    if (open && kind === "kimi") queueMicrotask(() => void scanKimi(""));
  }, [open, kind, scanKimi]);

  const scanOpenCode = React.useCallback(async () => {
    setScanningOpenCode(true);
    try {
      setOpenCodeSessions(await listOpenCodeHistory());
    } catch (reason) {
      toast({ title: t("Couldn't scan OpenCode history"), description: reason instanceof Error ? reason.message : String(reason), variant: "destructive" });
    } finally {
      setScanningOpenCode(false);
    }
  }, [t, toast]);

  React.useEffect(() => {
    if (open && kind === "opencode") queueMicrotask(() => void scanOpenCode());
  }, [open, kind, scanOpenCode]);

  const changeKind = (nextKind: string) => {
    setKind(nextKind);
    const backend = available.find((item) => item.kind === nextKind);
    setName(backend?.display_name ?? nextKind);
    setAgentProfile("");
    setSelectedKimiSessions(new Set());
    setSelectedOpenCodeSessions(new Set());
  };

  const connect = async () => {
    if (!kind || !name.trim()) return;
    setSaving(true);
    let connectionCreated = false;
    try {
      await connectSubagent({
        name: name.trim(),
        agent_kind: kind,
        cwd: cwd.trim(),
        agent_profile: kind === "kimi" ? agentProfile.trim() : "",
      });
      connectionCreated = true;
      if (kind === "kimi" && selectedKimiSessions.size) {
        const sessions = await parseKimiHistory([...selectedKimiSessions]);
        if (!sessions.length) throw new Error(t("No readable Kimi conversations were selected"));
        await importChatHistory("kimi", sessions, {
          id: `connected:kimi:${name.trim()}`,
          name: name.trim(),
        });
      }
      if (kind === "opencode" && selectedOpenCodeSessions.size) {
        const sessions = await parseOpenCodeHistory([...selectedOpenCodeSessions]);
        if (!sessions.length) throw new Error(t("No readable OpenCode conversations were selected"));
        await importChatHistory("opencode", sessions, {
          id: `connected:opencode:${name.trim()}`,
          name: name.trim(),
        });
      }
      toast({ title: t("Agent connected"), variant: "success" });
      onConnected();
      onClose();
    } catch (reason) {
      if (connectionCreated) {
        try {
          await disconnectSubagent(name.trim());
        } catch {
          // Keep the original import/parse error as the actionable failure.
        }
      }
      toast({
        title: t("Connection failed"),
        description: reason instanceof Error ? reason.message : String(reason),
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} className="max-w-lg">
      <DialogTitle>{t("Connect CLI agent")}</DialogTitle>
      {available.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">
          {t("No supported agent CLI is installed on this server.")}
        </p>
      ) : (
        <div className="mt-4 space-y-4">
          <label className="block text-sm text-foreground">
            <span className="mb-1 block text-xs text-muted-foreground">
              {t("Agent CLI")}
            </span>
            <Select value={kind} onChange={(event) => changeKind(event.target.value)}>
              {available.map((backend) => (
                <option key={backend.kind} value={backend.kind}>
                  {backend.display_name}{backend.version ? ` · ${backend.version}` : ""}
                </option>
              ))}
            </Select>
          </label>
          {kind === "kimi" ? (
            <div className="space-y-3 rounded-xl border border-border bg-muted-subtle p-3">
              <label className="block text-sm text-foreground">
                <span className="mb-1 block text-xs text-muted-foreground">
                  {t("Kimi Agent Profile")}
                </span>
                <Input
                  value={agentProfile}
                  onChange={(event) => setAgentProfile(event.target.value)}
                  placeholder={t("Leave blank to use Kimi's default agent")}
                  list="kimi-agent-profiles"
                />
                <datalist id="kimi-agent-profiles">
                  {kimiProfiles.map((profile) => <option key={profile} value={profile} />)}
                </datalist>
              </label>
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs font-medium text-muted-foreground">
                  {t("Existing Kimi conversations")}
                </span>
                <Button size="sm" variant="ghost" loading={scanningKimi} onClick={() => void scanKimi(cwd)}>
                  <RefreshCw size={13} />
                  {t("Scan")}
                </Button>
              </div>
              {kimiSessions.length ? (
                <div className="max-h-48 space-y-1 overflow-y-auto">
                  {kimiSessions.map((session) => (
                    <ScopeChoice
                      key={session.id}
                      choiceKey={session.id}
                      label={session.title || t("Untitled conversation")}
                      sublabel={`${session.profile || t("Default agent")} · ${session.cwd || t("Default workspace")}`}
                      count={session.message_count}
                      selected={selectedKimiSessions}
                      setSelected={setSelectedKimiSessions}
                    />
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {scanningKimi ? t("Scanning Kimi history…") : t("No Kimi conversations found for this scope.")}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                {t("Selected conversations are copied into Cognivoy; Kimi's original files stay unchanged.")}
              </p>
            </div>
          ) : null}
          {kind === "opencode" ? (
            <div className="space-y-3 rounded-xl border border-border bg-muted-subtle p-3" data-testid="opencode-history-import">
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs font-medium text-muted-foreground">{t("Existing OpenCode conversations")}</span>
                <Button size="sm" variant="ghost" loading={scanningOpenCode} onClick={() => void scanOpenCode()}>
                  <RefreshCw size={13} />{t("Scan")}
                </Button>
              </div>
              {openCodeSessions.length ? (
                <div className="max-h-48 space-y-1 overflow-y-auto">
                  {openCodeSessions.map((session) => (
                    <ScopeChoice
                      key={session.id}
                      choiceKey={session.id}
                      label={session.title || t("Untitled conversation")}
                      sublabel={`${session.cwd || t("Default workspace")} · ${t("{{count}} messages", { count: session.message_count })}`}
                      selected={selectedOpenCodeSessions}
                      setSelected={setSelectedOpenCodeSessions}
                    />
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">{scanningOpenCode ? t("Scanning OpenCode history…") : t("No OpenCode conversations found on this server.")}</p>
              )}
              <p className="text-xs text-muted-foreground">{t("Selected conversations are copied into Cognivoy; OpenCode's database stays unchanged.")}</p>
            </div>
          ) : null}
          <label className="block text-sm text-foreground">
            <span className="mb-1 block text-xs text-muted-foreground">
              {t("Connection name")}
            </span>
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="block text-sm text-foreground">
            <span className="mb-1 block text-xs text-muted-foreground">
              {t("Working directory")}
            </span>
            <Input
              value={cwd}
              onChange={(event) => setCwd(event.target.value)}
              placeholder={t("Leave blank to use the server default")}
            />
          </label>
          <p className="text-xs text-muted-foreground">
            {t("Cognivoy uses this CLI's existing local login and configuration. No credentials are copied.")}
          </p>
        </div>
      )}
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>{t("Cancel")}</Button>
        <Button
          onClick={() => void connect()}
          loading={saving}
          disabled={available.length === 0 || !kind || !name.trim()}
        >
          {t("Connect")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

export default function AgentsPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const { toast } = useToast();
  const [agents, setAgents] = React.useState<ImportAgent[] | null>(null);
  const [sessions, setSessions] = React.useState<SessionSummary[]>([]);
  const [connections, setConnections] = React.useState<SubagentConnection[] | null>(null);
  const [backends, setBackends] = React.useState<SubagentBackendInfo[]>([]);
  const [loadErrors, setLoadErrors] = React.useState<string[]>([]);
  const [dialogAgent, setDialogAgent] = React.useState<ImportAgent | null | undefined>(undefined);
  const [deleteTarget, setDeleteTarget] = React.useState<ImportAgent | null>(null);
  const [refreshing, setRefreshing] = React.useState("");
  const [connectOpen, setConnectOpen] = React.useState(false);
  const [disconnectTarget, setDisconnectTarget] = React.useState<SubagentConnection | null>(null);

  const load = React.useCallback(async () => {
    setLoadErrors([]);
    const results = await Promise.allSettled([
      getAgents(),
      listImportedSessions(200, 0, { force: true }),
      listSubagentConnections(),
      detectSubagents(),
    ]);
    const errors: string[] = [];
    if (results[0].status === "fulfilled") setAgents(results[0].value);
    else {
      setAgents([]);
      errors.push(t("Imported agent registry"));
    }
    if (results[1].status === "fulfilled") setSessions(results[1].value);
    else errors.push(t("Imported conversations"));
    if (results[2].status === "fulfilled") setConnections(results[2].value);
    else {
      setConnections([]);
      errors.push(t("Connected agents"));
    }
    if (results[3].status === "fulfilled") setBackends(results[3].value);
    else errors.push(t("Agent backends"));
    setLoadErrors(errors);
  }, [t]);

  React.useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);

  const owners = React.useMemo(
    () => assignSessionsToAgents(sessions, agents ?? []),
    [agents, sessions],
  );
  const counts = React.useMemo(() => {
    const result = new Map<string, number>();
    for (const owner of owners.values()) {
      if (owner) result.set(owner, (result.get(owner) ?? 0) + 1);
    }
    return result;
  }, [owners]);
  const serverImportedAgents = React.useMemo(
    () => groupServerImportedAgents(sessions, (agents ?? []).map((agent) => agent.id)),
    [agents, sessions],
  );
  const countFor = (id: string) => counts.get(id) ?? 0;

  const refresh = async (agent: ImportAgent) => {
    setRefreshing(agent.id);
    try {
      if (!(await ensureReadPermission(agent.handle))) {
        throw new Error(t("Folder permission was not granted"));
      }
      const scan = await scanDirectory(agent.handle);
      const refs = filterRefsByScope(refsFor(scan), agent.scope);
      const result = await importRefsIncrementally(
        scan.source,
        refs,
        (parsed) =>
          importChatHistory(scan.source, parsed, {
            id: agent.id,
            name: agent.name,
          }),
      );
      if (result.imported + result.skipped === 0) {
        throw new Error(t("No readable conversations were found in the selected scope."));
      }
      await saveAgent({ ...agent, lastSyncAt: Date.now() });
      toast({
        title: result.imported
          ? t("Added {{count}} new conversations", { count: result.imported })
          : t("Already up to date"),
        variant: "success",
      });
      await load();
    } catch (reason) {
      toast({
        title: t("Refresh failed"),
        description: reason instanceof Error ? reason.message : String(reason),
        variant: "destructive",
      });
    } finally {
      setRefreshing("");
    }
  };

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <PageHeader
        title={t("My Agents")}
        description={t("Imported coding histories and connected agent CLIs in one place.")}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setDialogAgent(null)}>
              <FolderSync size={15} />
              {t("Import history")}
            </Button>
            <Button onClick={() => setConnectOpen(true)}>
              <Plus size={15} />
              {t("Connect CLI agent")}
            </Button>
          </div>
        }
      />

      {loadErrors.length ? (
        <div role="alert" className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-destructive bg-destructive-muted p-3 text-sm text-foreground">
          <AlertTriangle size={17} className="text-destructive" />
          <span className="min-w-0 flex-1">
            {t("Some agent data could not be loaded: {{sources}}", {
              sources: loadErrors.join(", "),
            })}
          </span>
          <Button size="sm" variant="outline" onClick={() => void load()}>
            <RefreshCw size={13} />
            {t("Retry")}
          </Button>
        </div>
      ) : null}

      <section>
        <h2 className="display mb-3 text-base font-semibold text-foreground">
          {t("Imported agents")}
        </h2>
        {agents === null ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Skeleton className="h-32" />
            <Skeleton className="h-32" />
          </div>
        ) : agents.length === 0 && serverImportedAgents.length === 0 ? (
          <EmptyState
            icon={Bot}
            title={t("No imported agents yet")}
            description={t("Import Claude Code or Codex histories and choose the projects, dates, or conversations each agent owns.")}
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {agents.map((agent) => (
              <article key={agent.id} className="surface p-4">
                <div className="flex items-start gap-3">
                  <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary-muted text-accent-foreground">
                    <Bot size={18} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate text-sm font-medium text-foreground">{agent.name}</h3>
                    <p className="text-xs text-muted-foreground">
                      {SOURCE_LABEL[agent.source]} · {t("{{count}} conversations", { count: countFor(agent.id) })}
                    </p>
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      const first = sessions.find((session) => owners.get(session.session_id) === agent.id);
                      if (first) router.push(`/home/${first.session_id}`);
                    }}
                    disabled={countFor(agent.id) === 0}
                  >
                    {t("Open chats")}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void refresh(agent)} loading={refreshing === agent.id}>
                    <RefreshCw size={13} />
                    {t("Refresh")}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setDialogAgent(agent)}>
                    <Settings2 size={13} />
                    {t("Scope")}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setDeleteTarget(agent)} aria-label={t("Delete agent")}>
                    <Trash2 size={13} />
                  </Button>
                </div>
              </article>
            ))}
            {serverImportedAgents.map((agent) => (
              <article key={agent.id} className="surface p-4">
                <div className="flex items-start gap-3">
                  <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary-muted text-accent-foreground">
                    <Bot size={18} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate text-sm font-medium text-foreground">
                      {agent.name}
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      {agent.source === "opencode" ? "OpenCode" : agent.source} · {t("{{count}} conversations", { count: agent.sessionIds.length })}
                    </p>
                  </div>
                  <Badge variant="outline">{t("Server import")}</Badge>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => router.push(`/home/${agent.sessionIds[0]}`)}
                  >
                    {t("Open chats")}
                  </Button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="mt-9">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="display text-base font-semibold text-foreground">{t("Connected agents")}</h2>
          <Link href="/settings/agents" className="text-xs text-primary hover:underline">{t("Agent settings")}</Link>
        </div>
        <div
          className="grid gap-3 sm:grid-cols-2"
          aria-busy={connections === null}
          aria-live="polite"
        >
          {connections === null ? (
            <>
              <div role="status" className="sr-only">
                {t("Loading connected agents…")}
              </div>
              <Skeleton className="h-24" />
              <Skeleton className="h-24" />
            </>
          ) : connections.map((connection) => (
            <article key={connection.name} className="surface p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-medium text-foreground">{connection.name}</h3>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {connection.agent_kind} · {connection.cwd || t("Default workspace")}
                    {connection.agent_profile ? ` · ${connection.agent_profile}` : ""}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setDisconnectTarget(connection)}
                  aria-label={t("Disconnect {{name}}", { name: connection.name })}
                >
                  <Trash2 size={13} />
                </Button>
              </div>
              {(() => {
                const imported = sessions.filter(
                  (session) =>
                    session.preferences?.import?.source === connection.agent_kind &&
                    session.preferences?.import?.agent_name === connection.name,
                );
                if (!imported.length) return null;
                return (
                  <Button
                    className="mt-3"
                    size="sm"
                    variant="outline"
                    onClick={() => router.push(`/home/${imported[0].session_id}`)}
                  >
                    {t("Open chats")} · {imported.length}
                  </Button>
                );
              })()}
            </article>
          ))}
          {connections !== null && connections.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("No connected agents. Configure an installed backend to start using one.")}</p>
          ) : null}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {backends.map((backend) => (
            <Link key={backend.kind} href={`/settings/agents/${backend.kind}`}>
              <Badge variant={backend.available ? "success" : "outline"}>
                {backend.display_name} · {backend.available ? t("Installed") : t("Not installed")}
              </Badge>
            </Link>
          ))}
        </div>
        <AgentCapabilityMatrix backends={backends} />
      </section>

      <ImportAgentDialog
        key={dialogAgent === undefined ? "closed" : dialogAgent?.id ?? "new"}
        open={dialogAgent !== undefined}
        agent={dialogAgent}
        onClose={() => setDialogAgent(undefined)}
        onSaved={() => void load()}
      />
      {connectOpen ? (
        <ConnectCliDialog
          open
          backends={backends}
          onClose={() => setConnectOpen(false)}
          onConnected={() => void load()}
        />
      ) : null}
      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (!deleteTarget) return;
          void deleteAgent(deleteTarget.id).then(load);
          setDeleteTarget(null);
        }}
        title={t("Delete agent")}
        description={t("Remove this agent definition? Imported conversations will be kept.")}
        confirmText={t("Delete")}
        cancelText={t("Cancel")}
        destructive
      />
      <ConfirmDialog
        open={disconnectTarget !== null}
        onClose={() => setDisconnectTarget(null)}
        onConfirm={() => {
          if (!disconnectTarget) return;
          const name = disconnectTarget.name;
          void disconnectSubagent(name)
            .then(load)
            .catch((reason) => toast({
              title: t("Disconnect failed"),
              description: reason instanceof Error ? reason.message : String(reason),
              variant: "destructive",
            }));
          setDisconnectTarget(null);
        }}
        title={t("Disconnect agent")}
        description={t("Disconnect this CLI agent? Its local files and CLI sessions will not be deleted.")}
        confirmText={t("Disconnect")}
        cancelText={t("Cancel")}
        destructive
      />
    </div>
  );
}

const AGENT_CAPABILITIES: Record<string, { importHistory: string; resume: boolean }> = {
  claude_code: { importHistory: "Browser folder", resume: true },
  codex: { importHistory: "Browser folder", resume: true },
  gemini: { importHistory: "Not supported", resume: true },
  kimi: { importHistory: "Server history", resume: true },
  opencode: { importHistory: "Server history", resume: true },
  mimo: { importHistory: "Not supported", resume: true },
};

function AgentCapabilityMatrix({ backends }: { backends: SubagentBackendInfo[] }) {
  const { t } = useTranslation();
  return (
    <div
      className="mt-6 overflow-x-auto rounded-xl border border-border"
      data-testid="agent-capability-matrix"
      role="region"
      aria-label={t("Agent capability matrix")}
      tabIndex={0}
    >
      <div className="border-b border-border bg-muted-subtle px-4 py-3">
        <h3 className="text-sm font-medium text-foreground">{t("Agent capability matrix")}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{t("Connected agents can run new tasks. Imported agents are read-only copies of past conversations.")}</p>
      </div>
      <table className="w-full min-w-[680px] text-left text-xs">
        <thead className="text-muted-foreground"><tr>{["Agent", "Installed", "Connect and run", "Import history", "Resume session", "Cancel run"].map((label) => <th key={label} className="px-4 py-2 font-medium">{t(label)}</th>)}</tr></thead>
        <tbody>
          {backends.map((backend) => {
            const capability = AGENT_CAPABILITIES[backend.kind] ?? { importHistory: "Not supported", resume: false };
            return (
              <tr key={backend.kind} className="border-t border-border">
                <td className="px-4 py-3 font-medium text-foreground">{backend.display_name}</td>
                <td className="px-4 py-3">{t(backend.available ? "Yes" : "No")}</td>
                <td className="px-4 py-3">{t("Supported")}</td>
                <td className="px-4 py-3">{t(capability.importHistory)}</td>
                <td className="px-4 py-3">{t(capability.resume ? "Supported" : "Not supported")}</td>
                <td className="px-4 py-3">{t("Supported")}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

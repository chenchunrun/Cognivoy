"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  Check,
  FolderOpen,
  FolderSearch,
  Link2,
  Plus,
  Server,
} from "lucide-react";
import {
  Button,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  Input,
  Select,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import {
  getEnginePreflight,
  probeLightRagServer,
  probeIma,
  probeLinkedFolder,
  type EnginePreflight,
  type KnowledgeUploadPolicy,
  type LightRagServerProbe,
  type ImaProbe,
  type LinkedFolderProbe,
  type RagProviderSummary,
} from "@/lib/knowledge-api";
import { validateFiles } from "@/lib/knowledge-helpers";
import {
  enginePreflightReady,
  failedRequiredPreflightChecks,
} from "@/lib/knowledge-readiness";
import { FileDropZone } from "./file-drop-zone";

// Mirrors SUPPORTED_EXTENSIONS in the backend pageindex pipeline (PageIndex POST /doc/).
const PAGEINDEX_FORMATS = [
  ".pdf",
  ".md",
  ".markdown",
  ".txt",
  ".docx",
  ".doc",
  ".pptx",
  ".ppt",
  ".xlsx",
  ".xls",
  ".csv",
];
const OBSIDIAN_SOURCE = "obsidian";
const LIGHTRAG_SERVER_PROVIDER = "lightrag-server";
const IMA_PROVIDER = "ima";
const EXAMPLE_INDEX_PATH = "/Users/you/knowledge_bases/my-kb";
const EXAMPLE_VAULT_PATH = "/Users/you/Documents/MyVault";
const EXAMPLE_SERVER_URL = "http://localhost:9621";

type Mode = "new" | "link";

export interface CreateKbDialogProps {
  open: boolean;
  onClose: () => void;
  providers: RagProviderSummary[];
  initialProvider?: string | null;
  uploadPolicy: KnowledgeUploadPolicy;
  onCreate: (params: {
    name: string;
    provider: string;
    files: File[];
  }) => Promise<void>;
  /** Link a pre-built engine index folder in place (no copy, no re-index). */
  onConnectLinkedFolder: (params: {
    name: string;
    folderPath: string;
    provider: string;
  }) => Promise<void>;
  /** Connect a live Obsidian vault (no index). */
  onConnectObsidian: (params: {
    name: string;
    vaultPath: string;
  }) => Promise<void>;
  /** Connect an external LightRAG server (retrieval only, no local index). */
  onConnectLightRagServer: (params: {
    name: string;
    serverUrl: string;
    apiKey?: string;
    mode?: string;
  }) => Promise<void>;
  onConnectIma: (params: {
    name: string;
    clientId: string;
    apiKey: string;
    knowledgeBaseId: string;
  }) => Promise<void>;
}

export function CreateKbDialog({
  open,
  onClose,
  providers,
  initialProvider,
  uploadPolicy,
  onCreate,
  onConnectLinkedFolder,
  onConnectObsidian,
  onConnectLightRagServer,
  onConnectIma,
}: CreateKbDialogProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>("new");
  const [name, setName] = useState("");
  const [provider, setProvider] = useState("llamaindex");
  const [files, setFiles] = useState<File[]>([]);
  // Link mode: the source is either an engine id or the Obsidian sentinel.
  const [linkSource, setLinkSource] = useState(OBSIDIAN_SOURCE);
  const [folderPath, setFolderPath] = useState("");
  const [probe, setProbe] = useState<LinkedFolderProbe | null>(null);
  const [probing, setProbing] = useState(false);
  // LightRAG Server engine (new mode): a connection instead of an upload.
  const [serverUrl, setServerUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [serverMode, setServerMode] = useState("");
  const [serverProbe, setServerProbe] = useState<LightRagServerProbe | null>(
    null,
  );
  const [serverProbing, setServerProbing] = useState(false);
  const [imaClientId, setImaClientId] = useState("");
  const [imaApiKey, setImaApiKey] = useState("");
  const [imaKnowledgeBaseId, setImaKnowledgeBaseId] = useState("");
  const [imaProbe, setImaProbe] = useState<ImaProbe | null>(null);
  const [imaProbing, setImaProbing] = useState(false);
  // Environment preflight for the selected engine (required checks gate use).
  const [preflight, setPreflight] = useState<EnginePreflight | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const firstLinkable = providers.find((p) => p.linkable)?.id;

  // Reset the form only on the closed → open transition. While the dialog is
  // open, background indexing polls replace `providers` every few seconds,
  // and a data refresh must never wipe user input.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    const justOpened = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    if (!justOpened) return;
    setMode("new");
    setName("");
    setFiles([]);
    setError(null);
    setProvider(
      providers.some((item) => item.id === initialProvider)
        ? initialProvider!
        : providers[0]?.id || "llamaindex",
    );
    setLinkSource(firstLinkable || OBSIDIAN_SOURCE);
    setFolderPath("");
    setProbe(null);
    setProbing(false);
    setServerUrl("");
    setApiKey("");
    setServerMode("");
    setServerProbe(null);
    setServerProbing(false);
    setImaClientId("");
    setImaApiKey("");
    setImaKnowledgeBaseId("");
    setImaProbe(null);
    setImaProbing(false);
    setPreflight(null);
    setPreflightLoading(false);
    setPreflightError(null);
  }, [open, providers, firstLinkable, initialProvider]);

  // A fresh path / source invalidates a stale probe verdict.
  useEffect(() => {
    setProbe(null);
  }, [folderPath, linkSource]);

  // A fresh URL / key invalidates a stale server connection test.
  useEffect(() => {
    setServerProbe(null);
  }, [serverUrl, apiKey]);

  useEffect(() => {
    setImaProbe(null);
  }, [imaClientId, imaApiKey, imaKnowledgeBaseId]);

  // Run the engine environment preflight when the selection changes; failing
  // required checks are surfaced under the engine grid.
  useEffect(() => {
    if (!open || mode !== "new" || provider === LIGHTRAG_SERVER_PROVIDER || provider === IMA_PROVIDER) {
      setPreflight(null);
      setPreflightLoading(false);
      setPreflightError(null);
      return;
    }
    let cancelled = false;
    setPreflight(null);
    setPreflightLoading(true);
    setPreflightError(null);
    getEnginePreflight(provider)
      .then((result) => {
        if (!cancelled) {
          setPreflight(result);
          setPreflightLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setPreflight(null);
          setPreflightLoading(false);
          setPreflightError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, mode, provider]);

  // ---- New mode (build a fresh index) ----------------------------------
  const activeProvider = providers.find((p) => p.id === provider);
  const providerNeedsKey =
    !!activeProvider?.requires_api_key && activeProvider?.configured === false;
  const providerUnavailable = activeProvider?.configured === false;
  const isPageIndex = provider === "pageindex";
  const isLightRagServer = provider === LIGHTRAG_SERVER_PROVIDER;
  const isIma = provider === IMA_PROVIDER;
  const serverModeOptions = activeProvider?.modes ?? [];
  const effectiveServerMode =
    serverMode || activeProvider?.default_mode || serverModeOptions[0] || "";

  const policyForProvider: KnowledgeUploadPolicy = isPageIndex
    ? {
        ...uploadPolicy,
        extensions: PAGEINDEX_FORMATS,
        accept: PAGEINDEX_FORMATS.join(","),
      }
    : uploadPolicy;

  const selection = validateFiles(files, policyForProvider, t);
  const failedRequiredChecks = failedRequiredPreflightChecks(preflight);
  const selectedEngineReady = enginePreflightReady(
    preflight,
    preflightLoading,
    preflightError,
  );

  // ---- Link mode (mount an existing folder) ----------------------------
  const linkIsObsidian = linkSource === OBSIDIAN_SOURCE;
  const trimmed = name.trim();
  const trimmedPath = folderPath.trim();
  const trimmedServerUrl = serverUrl.trim();

  const canSubmit = (() => {
    if (submitting) return false;
    if (!trimmed) return false;
    if (mode === "new") {
      if (isLightRagServer) {
        // The connection must pass the test before a KB is bound to it.
        return !!trimmedServerUrl && !!serverProbe?.ok;
      }
      if (isIma) {
        return !!imaProbe?.ok;
      }
      return (
        !providerUnavailable &&
        selectedEngineReady &&
        selection.validFiles.length > 0
      );
    }
    if (!trimmedPath) return false;
    if (linkIsObsidian) return true;
    // An engine index must pass the probe before it can be linked.
    return !!probe?.ok;
  })();

  const handleProbe = async () => {
    if (!trimmedPath || linkIsObsidian || probing) return;
    setProbing(true);
    setError(null);
    try {
      const result = await probeLinkedFolder({
        folderPath: trimmedPath,
        provider: linkSource,
      });
      setProbe(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setProbing(false);
    }
  };

  const handleTestServer = async () => {
    if (!trimmedServerUrl || serverProbing) return;
    setServerProbing(true);
    setError(null);
    try {
      const result = await probeLightRagServer({
        serverUrl: trimmedServerUrl,
        apiKey: apiKey.trim(),
      });
      setServerProbe(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setServerProbing(false);
    }
  };

  const handleTestIma = async () => {
    if (!imaClientId.trim() || !imaApiKey.trim() || !imaKnowledgeBaseId.trim() || imaProbing) return;
    setImaProbing(true);
    setError(null);
    try {
      setImaProbe(await probeIma({
        clientId: imaClientId.trim(),
        apiKey: imaApiKey.trim(),
        knowledgeBaseId: imaKnowledgeBaseId.trim(),
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setImaProbing(false);
    }
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      if (mode === "new") {
        if (isLightRagServer) {
          await onConnectLightRagServer({
            name: trimmed,
            serverUrl: trimmedServerUrl,
            apiKey: apiKey.trim(),
            mode: effectiveServerMode,
          });
        } else if (isIma) {
          await onConnectIma({
            name: trimmed,
            clientId: imaClientId.trim(),
            apiKey: imaApiKey.trim(),
            knowledgeBaseId: imaKnowledgeBaseId.trim(),
          });
        } else {
          await onCreate({
            name: trimmed,
            provider,
            files: selection.validFiles,
          });
        }
      } else if (linkIsObsidian) {
        await onConnectObsidian({ name: trimmed, vaultPath: trimmedPath });
      } else {
        await onConnectLinkedFolder({
          name: trimmed,
          folderPath: trimmedPath,
          provider: linkSource,
        });
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const submitLabel =
    mode === "new"
      ? isLightRagServer
        ? t("Connect")
        : isIma
          ? t("Connect")
        : t("Create")
      : linkIsObsidian
        ? t("Connect")
        : t("Link");

  const preflightSettingsPath = failedRequiredChecks.some(
    (check) => check.key === "embedding",
  )
    ? "/settings/embedding"
    : failedRequiredChecks.some((check) => check.key === "chat")
      ? "/settings/llm"
      : null;

  return (
    <Dialog
      open={open}
      onClose={submitting ? () => {} : onClose}
      className="max-w-lg"
    >
      <DialogTitle>{t("Create knowledge base")}</DialogTitle>
      <DialogDescription>
        {t("Upload documents to index, or link a source you already have.")}
      </DialogDescription>

      <div className="mt-5 max-h-[60vh] space-y-4 overflow-y-auto pr-1">
        {/* New vs. link existing */}
        <div className="grid grid-cols-2 gap-2">
          {(
            [
              {
                id: "new" as Mode,
                label: t("Create new"),
                hint: t("Upload documents and build a fresh index."),
                icon: Plus,
              },
              {
                id: "link" as Mode,
                label: t("Link existing"),
                hint: t(
                  "Reuse an index you already built — read in place, no upload or re-index.",
                ),
                icon: Link2,
              },
            ]
          ).map((opt) => {
            const selected = mode === opt.id;
            const Icon = opt.icon;
            return (
              <button
                key={opt.id}
                type="button"
                disabled={submitting}
                onClick={() => setMode(opt.id)}
                className={cn(
                  "flex flex-col gap-1 rounded-xl border p-3 text-left transition-colors duration-150 disabled:opacity-50",
                  selected
                    ? "border-primary bg-primary-muted"
                    : "border-border hover:bg-muted",
                )}
              >
                <span className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
                  <Icon size={13} aria-hidden="true" />
                  {opt.label}
                </span>
                <span className="text-[11px] leading-snug text-muted-foreground">
                  {opt.hint}
                </span>
              </button>
            );
          })}
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("Knowledge base name")}
          </label>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoFocus
            disabled={submitting}
            placeholder={t("e.g. project-papers")}
          />
        </div>

        {mode === "new" ? (
          <>
            <details className="rounded-xl border border-border bg-muted-subtle px-3 py-2">
              <summary className="cursor-pointer text-sm font-medium text-foreground">
                {t("Advanced engine selection")}
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {t("Recommended: general PDFs, handouts, and notes")}
                </span>
              </summary>
            <div className="pt-3">
              <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t("Index engine")}
              </label>
              <div className="grid gap-2 sm:grid-cols-2">
                {providers.map((p) => {
                  const selected = provider === p.id;
                  const needsKey =
                    !!p.requires_api_key && p.configured === false;
                  const unavailable =
                    p.configured === false && !p.requires_api_key;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      disabled={submitting}
                      onClick={() => setProvider(p.id)}
                      className={cn(
                        "flex flex-col gap-1 rounded-xl border p-3 text-left transition-colors duration-150 disabled:opacity-50",
                        selected
                          ? "border-primary bg-primary-muted"
                          : "border-border hover:bg-muted",
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[13px] font-medium text-foreground">
                          {p.name}
                        </span>
                        {needsKey ? (
                          <span className="rounded-full bg-warning px-1.5 py-0.5 text-[10px] font-medium text-warning-foreground">
                            {t("Needs key")}
                          </span>
                        ) : unavailable ? (
                          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                            {t("Not installed")}
                          </span>
                        ) : selected ? (
                          <Check size={13} className="text-primary" />
                        ) : null}
                      </div>
                      <span className="text-[11.5px] leading-snug text-muted-foreground">
                        {t(p.description)}
                      </span>
                    </button>
                  );
                })}
              </div>
              {providerUnavailable && (
                <div className="mt-2 flex items-center gap-1.5 rounded-lg border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
                  <AlertTriangle size={13} className="shrink-0" />
                  {providerNeedsKey
                    ? t(
                        "This engine needs an API key. Configure it under Settings before creating.",
                      )
                    : t(
                        "This engine isn't installed on the server. Install it before creating.",
                      )}
                </div>
              )}
            </div>
            </details>

            {!isLightRagServer && !isIma && (
              <div
                className={cn(
                  "rounded-lg border px-3 py-2.5 text-xs",
                  preflightLoading
                    ? "border-border bg-muted text-muted-foreground"
                    : failedRequiredChecks.length > 0 || preflightError
                      ? "border-destructive bg-card text-destructive"
                      : "border-border bg-muted text-muted-foreground",
                )}
                role={failedRequiredChecks.length > 0 || preflightError ? "alert" : "status"}
              >
                {preflightLoading ? (
                  <span>{t("Checking whether the selected engine is ready...")}</span>
                ) : preflightError ? (
                  <div className="flex items-start gap-1.5">
                    <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                    <span>
                      {t("Engine readiness could not be verified. Creation is disabled until the check succeeds.")}
                    </span>
                  </div>
                ) : failedRequiredChecks.length > 0 ? (
                  <div className="space-y-2">
                    <div className="flex items-start gap-1.5 font-medium">
                      <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                      <span>{t("Complete the required setup before creating this knowledge base.")}</span>
                    </div>
                    <ul className="space-y-1 text-muted-foreground">
                      {failedRequiredChecks.map((check) => (
                        <li key={check.key}>
                          <span className="font-medium text-foreground">{t(check.label)}:</span>{" "}
                          {t(check.detail)}
                        </li>
                      ))}
                    </ul>
                    {preflightSettingsPath && (
                      <Link
                        href={preflightSettingsPath}
                        className="inline-flex min-h-8 items-center rounded-lg border border-border bg-background px-3 font-medium text-foreground hover:bg-muted"
                      >
                        {preflightSettingsPath.endsWith("embedding")
                          ? t("Open embedding settings")
                          : t("Open LLM settings")}
                      </Link>
                    )}
                  </div>
                ) : preflight?.ok ? (
                  <span className="flex items-center gap-1.5 text-success">
                    <Check size={13} aria-hidden="true" />
                    {t("Selected engine is ready for indexing.")}
                  </span>
                ) : null}
              </div>
            )}

            {isLightRagServer ? (
              <div className="space-y-3">
                <div>
                  <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {t("Server URL")}
                  </label>
                  <div className="flex gap-2">
                    <Input
                      value={serverUrl}
                      onChange={(event) => setServerUrl(event.target.value)}
                      disabled={submitting}
                      placeholder={EXAMPLE_SERVER_URL}
                      className="font-mono text-[12.5px]"
                    />
                    <Button
                      variant="outline"
                      size="md"
                      className="shrink-0"
                      loading={serverProbing}
                      disabled={submitting || trimmedServerUrl.length === 0}
                      onClick={() => void handleTestServer()}
                    >
                      {!serverProbing && <Server size={14} aria-hidden="true" />}
                      {t("Test connection")}
                    </Button>
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {t(
                      "The base URL of your running LightRAG server. Documents are indexed there — nothing is uploaded or copied.",
                    )}
                  </p>
                </div>

                <div>
                  <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {t("API key")}
                    <span className="ml-2 normal-case tracking-normal">
                      · {t("optional")}
                    </span>
                  </label>
                  <Input
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    disabled={submitting}
                    type="password"
                    autoComplete="off"
                    placeholder={t("Only if your server requires one")}
                  />
                </div>

                {serverModeOptions.length > 0 && (
                  <div>
                    <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      {t("Retrieval mode")}
                    </label>
                    <Select
                      value={effectiveServerMode}
                      onChange={(event) => setServerMode(event.target.value)}
                      disabled={submitting}
                    >
                      {serverModeOptions.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </Select>
                  </div>
                )}

                {serverProbe && <ServerProbeVerdict probe={serverProbe} />}
              </div>
            ) : isIma ? (
              <div className="space-y-3">
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {t("Connect an existing Tencent IMA knowledge base. Documents remain in IMA and are retrieved through its OpenAPI.")}
                </p>
                <label className="block text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t("Client ID")}
                  <Input className="mt-1 normal-case" value={imaClientId} onChange={(event) => setImaClientId(event.target.value)} disabled={submitting} autoComplete="off" />
                </label>
                <label className="block text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t("API key")}
                  <Input className="mt-1 normal-case" type="password" value={imaApiKey} onChange={(event) => setImaApiKey(event.target.value)} disabled={submitting} autoComplete="off" />
                </label>
                <label className="block text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t("Knowledge base ID")}
                  <div className="mt-1 flex gap-2">
                    <Input className="font-mono normal-case" value={imaKnowledgeBaseId} onChange={(event) => setImaKnowledgeBaseId(event.target.value)} disabled={submitting} />
                    <Button variant="outline" loading={imaProbing} disabled={submitting || !imaClientId.trim() || !imaApiKey.trim() || !imaKnowledgeBaseId.trim()} onClick={() => void handleTestIma()}>
                      {t("Test connection")}
                    </Button>
                  </div>
                </label>
                {imaProbe ? (
                  <div className="rounded-lg border border-border bg-muted p-3 text-xs text-muted-foreground">
                    {imaProbe.ok
                      ? t("Connected to {{name}}", { name: imaProbe.knowledge_base_name || imaProbe.knowledge_base_id })
                      : imaProbe.error || t("Connection failed")}
                  </div>
                ) : null}
              </div>
            ) : (
              <div>
                <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t("Initial documents")}
                  {isPageIndex && (
                    <span className="ml-2 normal-case tracking-normal">
                      · {t("PDF, Office, text and Markdown")}
                    </span>
                  )}
                </label>
                <FileDropZone
                  files={files}
                  onChange={setFiles}
                  uploadPolicy={policyForProvider}
                  disabled={submitting}
                />
              </div>
            )}
          </>
        ) : (
          <>
            <div>
              <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t("Source")}
              </label>
              <div className="grid gap-2 sm:grid-cols-2">
                {providers.map((p) => {
                  const selected = !linkIsObsidian && linkSource === p.id;
                  const disabled = submitting || !p.linkable;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      disabled={disabled}
                      onClick={() => setLinkSource(p.id)}
                      title={
                        !p.linkable
                          ? t(
                              "This engine's index lives in the cloud and can't be linked.",
                            )
                          : undefined
                      }
                      className={cn(
                        "flex flex-col gap-1 rounded-xl border p-3 text-left transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50",
                        selected
                          ? "border-primary bg-primary-muted"
                          : "border-border hover:bg-muted",
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[13px] font-medium text-foreground">
                          {p.name}
                        </span>
                        {!p.linkable ? (
                          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                            {t("Cloud index")}
                          </span>
                        ) : selected ? (
                          <Check size={13} className="text-primary" />
                        ) : null}
                      </div>
                      <span className="text-[11.5px] leading-snug text-muted-foreground">
                        {t(p.description)}
                      </span>
                    </button>
                  );
                })}

                {/* Obsidian — a live vault, no index. */}
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => setLinkSource(OBSIDIAN_SOURCE)}
                  className={cn(
                    "flex flex-col gap-1 rounded-xl border p-3 text-left transition-colors duration-150 disabled:opacity-50",
                    linkIsObsidian
                      ? "border-primary bg-primary-muted"
                      : "border-border hover:bg-muted",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
                      <FolderOpen size={13} aria-hidden="true" />
                      {t("Obsidian")}
                    </span>
                    {linkIsObsidian && (
                      <Check size={13} className="text-primary" />
                    )}
                  </div>
                  <span className="text-[11.5px] leading-snug text-muted-foreground">
                    {t(
                      "A live Obsidian vault — browsed and edited in place, no index.",
                    )}
                  </span>
                </button>
              </div>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {linkIsObsidian ? t("Vault path") : t("Folder path")}
              </label>
              <div className="flex gap-2">
                <Input
                  value={folderPath}
                  onChange={(event) => setFolderPath(event.target.value)}
                  disabled={submitting}
                  placeholder={
                    linkIsObsidian ? EXAMPLE_VAULT_PATH : EXAMPLE_INDEX_PATH
                  }
                  className="font-mono text-[12.5px]"
                />
                {!linkIsObsidian && (
                  <Button
                    variant="outline"
                    size="md"
                    className="shrink-0"
                    loading={probing}
                    disabled={submitting || trimmedPath.length === 0}
                    onClick={() => void handleProbe()}
                  >
                    {!probing && <FolderSearch size={14} aria-hidden="true" />}
                    {t("Check folder")}
                  </Button>
                )}
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {linkIsObsidian
                  ? t("The absolute path to the vault folder on this machine.")
                  : t(
                      "The absolute path to a knowledge base folder on this machine — nothing is copied.",
                    )}
              </p>
            </div>

            {!linkIsObsidian && probe && <ProbeVerdict probe={probe} />}
          </>
        )}

        {error && (
          <div className="rounded-lg border border-destructive bg-card px-3 py-2 text-xs text-destructive">
            <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">
              {error}
            </pre>
          </div>
        )}
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={submitting}>
          {t("Cancel")}
        </Button>
        <Button
          onClick={() => void handleSubmit()}
          disabled={!canSubmit}
          loading={submitting}
        >
          {submitLabel}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function ProbeVerdict({ probe }: { probe: LinkedFolderProbe }) {
  const { t } = useTranslation();
  if (!probe.ok) {
    return (
      <div className="rounded-lg border border-destructive bg-card px-3 py-2 text-xs text-destructive">
        <span className="flex items-center gap-1.5 font-medium">
          <AlertTriangle size={13} className="shrink-0" />
          {t("This folder can't be linked")}
        </span>
        {probe.error && <p className="mt-1 leading-relaxed">{probe.error}</p>}
      </div>
    );
  }

  const compatible = probe.embedding.compatible;
  return (
    <div className="space-y-2 rounded-lg border border-border bg-muted px-3 py-2.5 text-xs">
      <div className="flex items-center gap-1.5 font-medium text-success">
        <Check size={13} className="shrink-0" />
        {t("Ready index found")}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground">
        {probe.version && <span className="font-mono">{probe.version}</span>}
        {probe.doc_count != null && (
          <span>{t("{{count}} documents", { count: probe.doc_count })}</span>
        )}
        {compatible === true && (
          <span className="inline-flex items-center gap-1 text-success">
            <Check size={12} />
            {t("Embedding model matches")}
          </span>
        )}
      </div>
      {probe.warnings.map((warning, index) => (
        <p
          key={index}
          className="flex items-start gap-1.5 leading-relaxed text-muted-foreground"
        >
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span>{warning}</span>
        </p>
      ))}
    </div>
  );
}

function ServerProbeVerdict({ probe }: { probe: LightRagServerProbe }) {
  const { t } = useTranslation();
  if (!probe.ok) {
    return (
      <div className="rounded-lg border border-destructive bg-card px-3 py-2 text-xs text-destructive">
        <span className="flex items-center gap-1.5 font-medium">
          <AlertTriangle size={13} className="shrink-0" />
          {t("Could not connect")}
        </span>
        {probe.error && <p className="mt-1 leading-relaxed">{probe.error}</p>}
      </div>
    );
  }
  return (
    <div className="space-y-1 rounded-lg border border-border bg-muted px-3 py-2.5 text-xs">
      <div className="flex items-center gap-1.5 font-medium text-success">
        <Check size={13} className="shrink-0" />
        {t("Connected to LightRAG server")}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground">
        {probe.core_version && (
          <span>{t("Core {{version}}", { version: probe.core_version })}</span>
        )}
        <span>
          {probe.auth_required ? t("API key accepted") : t("Open access")}
        </span>
      </div>
    </div>
  );
}

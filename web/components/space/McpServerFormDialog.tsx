"use client";

import * as React from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2 } from "lucide-react";
import {
  Button,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  Input,
  Select,
  Textarea,
} from "@/components/ui";
import {
  arrayToLines,
  buildMcpServerConfig,
  dictToPairs,
  emptyMcpServerConfig,
  isValidMcpServerName,
  linesToArray,
  resolveMcpTransport,
  type McpKvPair,
  type McpServerConfig,
  type McpTransport,
} from "@/lib/mcp-api";

export interface McpServerFormResult {
  name: string;
  config: McpServerConfig;
}

export interface McpServerFormDialogProps {
  open: boolean;
  onClose: () => void;
  /** Server name being edited; null creates a new one. */
  editing: string | null;
  /** Existing config when editing. */
  initial?: McpServerConfig | null;
  onSubmit: (result: McpServerFormResult) => Promise<void>;
  /** Deployment administrators may configure host stdio commands. */
  allowStdio?: boolean;
}

type TypeChoice = "auto" | McpTransport;

/**
 * Add/edit one of the caller's own MCP servers. Remote transports only — stdio
 * commands run on the host and stay in the admin registry by design.
 */
export function McpServerFormDialog({
  open,
  onClose,
  editing,
  initial,
  onSubmit,
  allowStdio = false,
}: McpServerFormDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = React.useState("");
  const [typeChoice, setTypeChoice] = React.useState<TypeChoice>("auto");
  const [url, setUrl] = React.useState("");
  const [command, setCommand] = React.useState("");
  const [argsText, setArgsText] = React.useState("");
  const [cwd, setCwd] = React.useState("");
  const [envPairs, setEnvPairs] = React.useState<McpKvPair[]>([]);
  const [headerPairs, setHeaderPairs] = React.useState<McpKvPair[]>([]);
  const [toolTimeout, setToolTimeout] = React.useState("30");
  const [enabledToolsText, setEnabledToolsText] = React.useState("*");
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    const cfg = initial ?? emptyMcpServerConfig();
    setName(editing ?? "");
    setTypeChoice(cfg.type ?? "auto");
    setUrl(cfg.url);
    setCommand(cfg.command);
    setArgsText(arrayToLines(cfg.args));
    setCwd(cfg.cwd);
    setEnvPairs(dictToPairs(cfg.env));
    setHeaderPairs(dictToPairs(cfg.headers));
    setToolTimeout(String(cfg.tool_timeout));
    setEnabledToolsText(arrayToLines(cfg.enabled_tools));
    setSaving(false);
  }, [open, editing, initial]);

  const nameTrimmed = name.trim();
  const nameValid = editing !== null || isValidMcpServerName(nameTrimmed);
  const timeout = Number(toolTimeout);
  const timeoutValid = Number.isFinite(timeout) && timeout > 0;

  const previewTransport = resolveMcpTransport({
    ...(initial ?? emptyMcpServerConfig()),
    type: typeChoice === "auto" ? null : typeChoice,
    command: command.trim(),
    url: url.trim(),
  });
  const endpointValid = previewTransport === "stdio"
    ? allowStdio && command.trim().length > 0
    : (previewTransport === "sse" || previewTransport === "streamableHttp") && url.trim().length > 0;
  const canSubmit = nameValid && endpointValid && timeoutValid && !saving;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    try {
      const base = initial ?? emptyMcpServerConfig();
      const config = buildMcpServerConfig(
        {
          type: typeChoice === "auto" ? null : typeChoice,
          command,
          argsText,
          envPairs,
          cwd,
          url,
          headerPairs,
          toolTimeout: timeout,
          enabledToolsText:
            linesToArray(enabledToolsText).length > 0 ? enabledToolsText : "*",
        },
        base,
      );
      await onSubmit({ name: editing ?? nameTrimmed, config });
      onClose();
    } catch {
      // The page reports the error via toast; keep the dialog open.
    } finally {
      setSaving(false);
    }
  };

  const setPair = (index: number, patch: Partial<McpKvPair>) =>
    setHeaderPairs((prev) =>
      prev.map((pair, i) => (i === index ? { ...pair, ...patch } : pair)),
    );

  return (
    <Dialog open={open} onClose={onClose} className="max-w-lg">
      <DialogTitle>
        {editing !== null ? t("Edit MCP server") : t("Add MCP server")}
      </DialogTitle>
      <DialogDescription>
        {t(
          allowStdio
            ? "Connect a deployment MCP server over HTTP or a host stdio command."
            : "Connect a hosted MCP server over HTTP. Its tools become available in chat.",
        )}
      </DialogDescription>

      <div className="mt-4 space-y-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            {t("Name")}
          </label>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="my-server"
            disabled={editing !== null}
          />
          {!nameValid && (
            <p className="mt-1 text-xs text-destructive">
              {t(
                "Letters, digits, dashes, and underscores only; must start with a letter or digit.",
              )}
            </p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              {t("Transport")}
            </label>
            <Select
              value={typeChoice}
              onChange={(event) =>
                setTypeChoice(event.target.value as TypeChoice)
              }
            >
              <option value="auto">{t("Auto-detect")}</option>
              {allowStdio && <option value="stdio">{t("stdio")}</option>}
              <option value="sse">SSE</option>
              <option value="streamableHttp">Streamable HTTP</option>
            </Select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              {t("Tool timeout (seconds)")}
            </label>
            <Input
              value={toolTimeout}
              onChange={(event) => setToolTimeout(event.target.value)}
              inputMode="numeric"
            />
          </div>
        </div>

        {previewTransport === "stdio" ? (
          <div className="space-y-3 rounded-lg border border-warning-border bg-warning-muted p-3">
            <p className="text-xs text-warning">{t("Stdio commands run on the Cognivoy host. Only configure trusted executables.")}</p>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">{t("Command")}</label>
              <Input value={command} onChange={(event) => setCommand(event.target.value)} placeholder={t("npx")} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">{t("Arguments")}</label>
              <Textarea value={argsText} onChange={(event) => setArgsText(event.target.value)} placeholder={t("One argument per line")} className="min-h-[72px] font-mono text-xs" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">{t("Working directory")}</label>
              <Input value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder={t("/workspace")} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">{t("Environment variables")}</label>
              <div className="space-y-2">
                {envPairs.map((pair, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <Input value={pair.key} onChange={(event) => setEnvPairs((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, key: event.target.value } : item))} placeholder={t("API_KEY")} className="flex-1" />
                    <Input type="password" value={pair.value} onChange={(event) => setEnvPairs((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, value: event.target.value } : item))} placeholder={t("Value")} className="flex-1" />
                    <Button variant="ghost" size="icon" aria-label={t("Remove environment variable")} onClick={() => setEnvPairs((current) => current.filter((_, itemIndex) => itemIndex !== index))}><Trash2 size={13} /></Button>
                  </div>
                ))}
                <Button variant="outline" size="sm" onClick={() => setEnvPairs((current) => [...current, { key: "", value: "" }])}><Plus size={13} />{t("Add environment variable")}</Button>
              </div>
            </div>
          </div>
        ) : <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            {t("URL")}
          </label>
          <Input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://example.com/mcp"
          />
          {url.trim() && typeChoice === "auto" && previewTransport && (
            <p className="mt-1 text-xs text-muted-foreground">
              {t("Detected transport: {{transport}}", {
                transport:
                  previewTransport === "sse" ? "SSE" : "Streamable HTTP",
              })}
            </p>
          )}
        </div>}

        {previewTransport !== "stdio" && <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            {t("Headers")}
          </label>
          <div className="space-y-2">
            {headerPairs.map((pair, index) => (
              <div key={index} className="flex items-center gap-2">
                <Input
                  value={pair.key}
                  onChange={(event) =>
                    setPair(index, { key: event.target.value })
                  }
                  placeholder="Authorization"
                  className="flex-1"
                />
                <Input
                  value={pair.value}
                  onChange={(event) =>
                    setPair(index, { value: event.target.value })
                  }
                  placeholder={t("Value")}
                  type={
                    /token|key|secret|authorization/i.test(pair.key)
                      ? "password"
                      : "text"
                    }
                  className="flex-1"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("Remove header")}
                  onClick={() =>
                    setHeaderPairs((prev) => prev.filter((_, i) => i !== index))
                  }
                >
                  <Trash2 size={13} aria-hidden="true" />
                </Button>
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setHeaderPairs((prev) => [...prev, { key: "", value: "" }])
              }
            >
              <Plus size={13} aria-hidden="true" />
              {t("Add header")}
            </Button>
          </div>
        </div>}

        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            {t("Enabled tools")}
          </label>
          <Textarea
            value={enabledToolsText}
            onChange={(event) => setEnabledToolsText(event.target.value)}
            placeholder="*"
            className="min-h-[56px] font-mono text-xs"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            {t("One tool name per line, or * for all tools.")}
          </p>
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={saving}>
          {t("Cancel")}
        </Button>
        <Button
          onClick={() => void handleSubmit()}
          disabled={!canSubmit}
          loading={saving}
        >
          {editing !== null ? t("Save") : t("Add server")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

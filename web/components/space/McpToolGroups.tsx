"use client";

import * as React from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Wrench } from "lucide-react";
import { Badge, Button, EmptyState, useToast } from "@/components/ui";
import { describeMcpError } from "@/lib/mcp-store";
import {
  groupProviderTools,
  groupSelection,
  setGroupSelected,
  toggleToolName,
} from "@/lib/mcp-tool-groups";
import {
  mcpRowStatus,
  putSpaceMcpServer,
  MCP_SPACE_BASE_PATH,
  type McpStatusRow,
  type McpStoreState,
  type McpTool,
} from "@/lib/mcp-api";

export interface McpToolGroupsProps {
  state: McpStoreState;
  onSaved: (state: McpStoreState) => void;
}

interface ToolRow extends McpTool {
  server: string;
}

/**
 * Per-server tool whitelist editor. A server's `enabled_tools` is a flat list
 * ("*" means all); the grouping here is purely presentational.
 */
export function McpToolGroups({ state, onSaved }: McpToolGroupsProps) {
  const { t } = useTranslation();

  const rows: ToolRow[] = React.useMemo(
    () =>
      state.status
        .filter((row) => row.name in state.servers)
        .flatMap((row) =>
          row.tools.map((tool) => ({ ...tool, server: row.name })),
        ),
    [state],
  );
  const groups = React.useMemo(() => groupProviderTools(rows), [rows]);

  if (groups.length === 0) {
    return (
      <div className="surface">
        <EmptyState
          icon={Wrench}
          title={t("No tools discovered yet")}
          description={t(
            "Once one of your MCP servers connects, its tools appear here.",
          )}
        />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {groups.map((group) => (
        <ServerToolGroup
          key={group.id}
          serverName={group.id}
          tools={group.tools}
          state={state}
          onSaved={onSaved}
        />
      ))}
    </div>
  );
}

function ServerToolGroup({
  serverName,
  tools,
  state,
  onSaved,
}: {
  serverName: string;
  tools: ToolRow[];
  state: McpStoreState;
  onSaved: (state: McpStoreState) => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [open, setOpen] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  const cfg = state.servers[serverName];
  const row: McpStatusRow | undefined = state.status.find(
    (r) => r.name === serverName,
  );
  const status = cfg ? mcpRowStatus(cfg, row) : "disabled";

  const allNames = React.useMemo(() => tools.map((tool) => tool.name), [tools]);
  const savedSelected: string[] = React.useMemo(() => {
    if (!cfg) return [];
    if (cfg.enabled_tools.includes("*")) return allNames;
    return cfg.enabled_tools;
  }, [cfg, allNames]);

  const [selected, setSelected] = React.useState<string[]>(savedSelected);
  React.useEffect(() => setSelected(savedSelected), [savedSelected]);

  const dirty =
    selected.length !== savedSelected.length ||
    selected.some((name) => !savedSelected.includes(name));
  const selection = groupSelection(tools, selected);

  const save = async () => {
    if (!cfg || saving) return;
    setSaving(true);
    try {
      const enabledTools =
        selected.length >= allNames.length ? ["*"] : selected;
      const next = await putSpaceMcpServer(MCP_SPACE_BASE_PATH, serverName, {
        ...cfg,
        enabled_tools: enabledTools,
      });
      toast({ variant: "success", title: t("Tool selection saved") });
      onSaved(next);
    } catch (error) {
      toast({
        variant: "destructive",
        title: t("Failed to save tool selection"),
        description: describeMcpError(error, t),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="surface">
      <div className="flex items-center gap-3 px-4 py-3">
        <input
          type="checkbox"
          aria-label={t("Toggle all tools from {{name}}", { name: serverName })}
          checked={selection === "all"}
          ref={(el) => {
            if (el) el.indeterminate = selection === "partial";
          }}
          onChange={(event) =>
            setSelected((prev) =>
              setGroupSelected(prev, tools, event.target.checked),
            )
          }
          className="h-4 w-4 accent-primary"
        />
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span className="truncate text-sm font-medium text-foreground">
            {serverName}
          </span>
          <Badge variant={status === "connected" ? "success" : "outline"}>
            {t(status)}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {t("{{hits}} of {{total}} tools", {
              hits: selection === "all" ? tools.length : selected.filter((n) => allNames.includes(n)).length,
              total: tools.length,
            })}
          </span>
          <ChevronDown
            size={14}
            aria-hidden="true"
            className={`ml-auto shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
          />
        </button>
        {dirty && (
          <Button size="sm" onClick={() => void save()} loading={saving}>
            {t("Save")}
          </Button>
        )}
      </div>
      {open && (
        <ul className="divide-y divide-border border-t border-border">
          {tools.map((tool) => (
            <li key={tool.name} className="flex items-start gap-3 px-4 py-2.5">
              <input
                type="checkbox"
                aria-label={tool.name}
                checked={selected.includes(tool.name)}
                onChange={() =>
                  setSelected((prev) => toggleToolName(prev, tool.name))
                }
                className="mt-0.5 h-4 w-4 accent-primary"
              />
              <div className="min-w-0">
                <div className="font-mono text-xs text-foreground">
                  {tool.name}
                </div>
                {tool.description && (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {tool.description}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

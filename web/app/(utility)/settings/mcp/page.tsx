"use client";

import * as React from "react";
import { Pencil, Plug, Plus, Trash2, Unplug } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  SettingsLinkCard,
  SettingsPageHeader,
} from "@/components/settings/shared";
import { Badge, Button, ConfirmDialog, EmptyState, Skeleton, Toggle, useToast } from "@/components/ui";
import { McpServerFormDialog, type McpServerFormResult } from "@/components/space/McpServerFormDialog";
import {
  deleteAdminMcpServer,
  getMcpSettings,
  mcpRowStatus,
  putAdminMcpServer,
  testAdminMcpServer,
  MCP_ADMIN_BASE_PATH,
  type McpServerConfig,
  type McpSettings,
  type McpServerStatus,
} from "@/lib/mcp-api";

const STATUS_VARIANT: Record<McpServerStatus, "success" | "default" | "destructive" | "warning" | "outline"> = {
  connected: "success",
  connecting: "default",
  error: "destructive",
  needs_auth: "warning",
  disabled: "outline",
};

export default function McpSettingsPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [state, setState] = React.useState<McpSettings | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [adminUnavailable, setAdminUnavailable] = React.useState(false);
  const [formOpen, setFormOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<string | null>(null);
  const [testing, setTesting] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void getMcpSettings(MCP_ADMIN_BASE_PATH)
      .then((next) => {
        if (cancelled) return;
        setState(next);
        setAdminUnavailable(false);
      })
      .catch(() => {
        if (!cancelled) setAdminUnavailable(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const save = async ({ name, config }: McpServerFormResult) => {
    try {
      setState(await putAdminMcpServer(MCP_ADMIN_BASE_PATH, name, config));
      toast({ variant: "success", title: editing ? t("Server updated") : t("Server added") });
    } catch (error) {
      toast({ variant: "destructive", title: t("Failed to update server"), description: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  };

  const toggle = async (name: string, config: McpServerConfig) => {
    try { setState(await putAdminMcpServer(MCP_ADMIN_BASE_PATH, name, { ...config, enabled: !config.enabled })); }
    catch (error) { toast({ variant: "destructive", title: t("Failed to update server"), description: error instanceof Error ? error.message : String(error) }); }
  };

  const test = async (name: string, config: McpServerConfig) => {
    setTesting(name);
    try {
      const result = await testAdminMcpServer(MCP_ADMIN_BASE_PATH, name, config);
      toast({ variant: result.ok ? "success" : "destructive", title: result.ok ? t("Connection successful") : t("Connection failed"), description: result.ok ? t("{{count}} tools discovered", { count: result.tools.length }) : result.error });
    } finally { setTesting(null); }
  };

  const remove = async () => {
    if (!deleteTarget) return;
    try { setState(await deleteAdminMcpServer(MCP_ADMIN_BASE_PATH, deleteTarget)); setDeleteTarget(null); }
    catch (error) { toast({ variant: "destructive", title: t("Failed to delete server"), description: error instanceof Error ? error.message : String(error) }); }
  };

  const names = state ? Object.keys(state.servers).sort() : [];
  return (
    <div>
      <SettingsPageHeader
        title={t("MCP")}
        description={t(
          "Manage deployment MCP servers or open your account-level remote servers.",
        )}
        action={!adminUnavailable && !loading ? <Button size="sm" onClick={() => { setEditing(null); setFormOpen(true); }}><Plus size={14} />{t("Add deployment server")}</Button> : undefined}
      />
      <SettingsLinkCard
        href="/space/mcp"
        icon={Plug}
        title={t("Open MCP servers")}
        description={t(
          "Connect, configure, and inspect MCP servers in the Learning Space store.",
        )}
        actionLabel={t("Go to MCP")}
      />

      <section className="mt-6" aria-labelledby="deployment-mcp-title">
        <div className="mb-3">
          <h2 id="deployment-mcp-title" className="display text-lg text-foreground">{t("Deployment registry")}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{t("Administrator-only servers shared by this Cognivoy deployment. Stdio commands run on the host.")}</p>
        </div>
        {loading ? <div className="space-y-2"><Skeleton className="h-16" /><Skeleton className="h-16" /></div> : adminUnavailable ? (
          <div className="surface"><EmptyState icon={Unplug} title={t("Administrator access required")} description={t("Your account-level MCP servers remain available from Learning Space.")} /></div>
        ) : names.length === 0 ? (
          <div className="surface"><EmptyState icon={Plug} title={t("No deployment MCP servers")} description={t("Add a trusted remote endpoint or host stdio command.")} action={<Button size="sm" onClick={() => { setEditing(null); setFormOpen(true); }}><Plus size={14} />{t("Add deployment server")}</Button>} /></div>
        ) : (
          <div className="space-y-2">{names.map((name) => {
            const config = state!.servers[name];
            const row = state!.status.find((item) => item.name === name);
            const status = mcpRowStatus(config, row);
            return <div key={name} className="surface flex items-center gap-3 px-4 py-3">
              <Toggle checked={config.enabled} onCheckedChange={() => void toggle(name, config)} aria-label={t("Enable {{name}}", { name })} />
              <div className="min-w-0 flex-1"><div className="flex items-center gap-2"><span className="truncate text-sm font-medium text-foreground">{name}</span><Badge variant={STATUS_VARIANT[status]}>{t(status)}</Badge><Badge variant="outline">{config.type || (config.command ? "stdio" : "HTTP")}</Badge></div><p className="mt-1 truncate text-xs text-muted-foreground">{row?.error || (row ? t("{{count}} tools", { count: row.tools.length }) : config.command || config.url)}</p></div>
              <Button variant="outline" size="sm" loading={testing === name} onClick={() => void test(name, config)}>{t("Test")}</Button>
              <Button variant="ghost" size="icon" aria-label={t("Edit {{name}}", { name })} onClick={() => { setEditing(name); setFormOpen(true); }}><Pencil size={14} /></Button>
              <Button variant="ghost" size="icon" aria-label={t("Delete {{name}}", { name })} onClick={() => setDeleteTarget(name)}><Trash2 size={14} /></Button>
            </div>;
          })}</div>
        )}
      </section>

      <McpServerFormDialog open={formOpen} onClose={() => setFormOpen(false)} editing={editing} initial={editing && state ? state.servers[editing] : null} onSubmit={save} allowStdio />
      <ConfirmDialog open={Boolean(deleteTarget)} onClose={() => setDeleteTarget(null)} onConfirm={() => void remove()} title={t("Delete MCP server")} description={t('Remove "{{name}}" from the deployment registry?', { name: deleteTarget ?? "" })} confirmText={t("Delete")} destructive />
    </div>
  );
}

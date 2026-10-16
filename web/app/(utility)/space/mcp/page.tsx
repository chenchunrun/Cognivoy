"use client";

import * as React from "react";
import { useTranslation } from "react-i18next";
import {
  KeyRound,
  Pencil,
  Plug,
  Plus,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Toggle,
  useToast,
  type BadgeVariant,
} from "@/components/ui";
import { SpaceHeader } from "@/components/space/SpaceHeader";
import {
  McpServerFormDialog,
  type McpServerFormResult,
} from "@/components/space/McpServerFormDialog";
import { McpCatalogBrowser } from "@/components/space/McpCatalogBrowser";
import { McpToolGroups } from "@/components/space/McpToolGroups";
import { describeMcpError } from "@/lib/mcp-store";
import {
  authorizeSpaceMcpServer,
  deleteSpaceMcpServer,
  getSpaceMcpState,
  mcpRowStatus,
  putSpaceMcpServer,
  MCP_SPACE_BASE_PATH,
  type McpServerConfig,
  type McpServerStatus,
  type McpStoreState,
} from "@/lib/mcp-api";

const STATUS_VARIANT: Record<McpServerStatus, BadgeVariant> = {
  connected: "success",
  connecting: "default",
  error: "destructive",
  needs_auth: "warning",
  disabled: "outline",
};

export default function SpaceMcpPage() {
  const { t } = useTranslation();
  const { toast } = useToast();

  const [tab, setTab] = React.useState("servers");
  const [state, setState] = React.useState<McpStoreState | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [formOpen, setFormOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      setState(await getSpaceMcpState(MCP_SPACE_BASE_PATH));
    } catch (error) {
      toast({
        variant: "destructive",
        title: t("Failed to load MCP servers"),
        description: describeMcpError(error, t),
      });
    } finally {
      setLoading(false);
    }
  }, [t, toast]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const handleSubmit = async ({ name, config }: McpServerFormResult) => {
    try {
      setState(await putSpaceMcpServer(MCP_SPACE_BASE_PATH, name, config));
      toast({
        variant: "success",
        title: editing ? t("Server updated") : t("Server added"),
      });
    } catch (error) {
      toast({
        variant: "destructive",
        title: editing
          ? t("Failed to update server")
          : t("Failed to add server"),
        description: describeMcpError(error, t),
      });
      throw error;
    }
  };

  const handleToggle = async (name: string, cfg: McpServerConfig) => {
    try {
      setState(
        await putSpaceMcpServer(MCP_SPACE_BASE_PATH, name, {
          ...cfg,
          enabled: !cfg.enabled,
        }),
      );
    } catch (error) {
      toast({
        variant: "destructive",
        title: t("Failed to update server"),
        description: describeMcpError(error, t),
      });
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      setState(await deleteSpaceMcpServer(MCP_SPACE_BASE_PATH, deleteTarget));
      toast({ variant: "success", title: t("Server deleted") });
      setDeleteTarget(null);
    } catch (error) {
      toast({
        variant: "destructive",
        title: t("Failed to delete server"),
        description: describeMcpError(error, t),
      });
    } finally {
      setDeleting(false);
    }
  };

  const handleAuthorize = async (name: string) => {
    try {
      const url = await authorizeSpaceMcpServer(MCP_SPACE_BASE_PATH, name);
      if (url) window.location.href = url;
    } catch (error) {
      toast({
        variant: "destructive",
        title: t("Failed to start authorization"),
        description: describeMcpError(error, t),
      });
    }
  };

  const serverNames = state ? Object.keys(state.servers).sort() : [];
  const deploymentNames = state?.user?.deployment.servers ?? [];
  const rejected = state?.user?.rejected ?? [];

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <SpaceHeader
        back
        title={t("MCP Services")}
        description={t(
          "Connect hosted MCP servers and bring their tools into chat.",
        )}
        actions={
          tab === "servers" ? (
            <Button
              size="sm"
              onClick={() => {
                setEditing(null);
                setFormOpen(true);
              }}
            >
              <Plus size={14} aria-hidden="true" />
              {t("Add server")}
            </Button>
          ) : undefined
        }
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="servers">{t("My servers")}</TabsTrigger>
          <TabsTrigger value="catalog">{t("Catalog")}</TabsTrigger>
          <TabsTrigger value="tools">{t("Tool groups")}</TabsTrigger>
        </TabsList>

        <TabsContent value="servers" className="mt-4">
          {loading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : !state || serverNames.length === 0 ? (
            <div className="surface">
              <EmptyState
                icon={Plug}
                title={t("No MCP servers yet")}
                description={t(
                  "Add a server manually or install one from the catalog.",
                )}
                action={
                  <Button
                    size="sm"
                    onClick={() => {
                      setEditing(null);
                      setFormOpen(true);
                    }}
                  >
                    <Plus size={14} aria-hidden="true" />
                    {t("Add server")}
                  </Button>
                }
              />
            </div>
          ) : (
            <div className="space-y-2">
              {serverNames.map((name) => {
                const cfg = state.servers[name];
                const row = state.status.find((r) => r.name === name);
                const status = mcpRowStatus(cfg, row);
                return (
                  <div
                    key={name}
                    className="surface flex items-center gap-3 px-4 py-3"
                  >
                    <Toggle
                      checked={cfg.enabled}
                      onCheckedChange={() => void handleToggle(name, cfg)}
                      aria-label={t("Enable {{name}}", { name })}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium text-foreground">
                          {name}
                        </span>
                        <Badge variant={STATUS_VARIANT[status]}>
                          {t(status)}
                        </Badge>
                        {cfg.catalog_entry && (
                          <Badge variant="outline">{cfg.catalog_entry}</Badge>
                        )}
                      </div>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {status === "error" && row?.error
                          ? row.error
                          : row
                            ? t("{{count}} tools", {
                                count: row.tools.length,
                              })
                            : cfg.url}
                      </p>
                    </div>
                    {status === "needs_auth" && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void handleAuthorize(name)}
                      >
                        <KeyRound size={13} aria-hidden="true" />
                        {t("Authorize")}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t("Edit {{name}}", { name })}
                      onClick={() => {
                        setEditing(name);
                        setFormOpen(true);
                      }}
                    >
                      <Pencil size={14} aria-hidden="true" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t("Delete {{name}}", { name })}
                      onClick={() => setDeleteTarget(name)}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </Button>
                  </div>
                );
              })}
            </div>
          )}

          {rejected.length > 0 && (
            <div className="mt-4 space-y-2">
              {rejected.map((item) => (
                <div
                  key={item.name}
                  className="flex items-start gap-2 rounded-lg border border-border bg-muted px-3 py-2 text-xs text-muted-foreground"
                >
                  <ShieldAlert
                    size={14}
                    aria-hidden="true"
                    className="mt-0.5 shrink-0 text-warning"
                  />
                  <span>
                    <span className="font-medium text-foreground">
                      {item.name}
                    </span>
                    {" — "}
                    {item.reason}
                  </span>
                </div>
              ))}
            </div>
          )}

          {deploymentNames.length > 0 && (
            <section className="mt-8">
              <h2 className="display mb-2 text-base font-semibold text-foreground">
                {t("Provided by this deployment")}
              </h2>
              <p className="mb-3 text-xs text-muted-foreground">
                {t("These servers are managed by an administrator.")}
              </p>
              <div className="space-y-2">
                {deploymentNames.map((name) => {
                  const row = state?.user?.deployment.status.find(
                    (r) => r.name === name,
                  );
                  return (
                    <div
                      key={name}
                      className="surface flex items-center gap-3 px-4 py-3"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium text-foreground">
                            {name}
                          </span>
                          {row && (
                            <Badge variant={STATUS_VARIANT[row.status]}>
                              {t(row.status)}
                            </Badge>
                          )}
                        </div>
                        {row && (
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {t("{{count}} tools", { count: row.tools.length })}
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </TabsContent>

        <TabsContent value="catalog" className="mt-4">
          <McpCatalogBrowser onInstalled={setState} />
        </TabsContent>

        <TabsContent value="tools" className="mt-4">
          {loading || !state ? (
            <div className="space-y-2">
              {Array.from({ length: 2 }).map((_, i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : (
            <McpToolGroups state={state} onSaved={setState} />
          )}
        </TabsContent>
      </Tabs>

      <McpServerFormDialog
        open={formOpen}
        onClose={() => setFormOpen(false)}
        editing={editing}
        initial={editing && state ? state.servers[editing] : null}
        onSubmit={handleSubmit}
      />
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void handleDelete()}
        title={t("Delete MCP server")}
        description={t(
          'Remove "{{name}}" and its stored credentials? This cannot be undone.',
          { name: deleteTarget ?? "" },
        )}
        confirmText={t("Delete")}
        destructive
        loading={deleting}
      />
    </div>
  );
}

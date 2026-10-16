"use client";

import * as React from "react";
import { useTranslation } from "react-i18next";
import { Download, PackageOpen, Search } from "lucide-react";
import {
  Badge,
  Button,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  EmptyState,
  Input,
  Select,
  Skeleton,
  useToast,
} from "@/components/ui";
import {
  getMcpCatalog,
  installMcpCatalogEntry,
  MCP_SPACE_BASE_PATH,
  type McpCatalogEntry,
  type McpStoreState,
} from "@/lib/mcp-api";
import {
  appendCatalogPage,
  canInstallEntry,
  catalogCategoryChips,
  catalogInitials,
  describeMcpError,
  filledCredentials,
  localizedCatalogText,
  MCP_CATALOG_TIERS,
  type McpCatalogList,
} from "@/lib/mcp-store";

const PAGE_SIZE = 24;

export interface McpCatalogBrowserProps {
  /** Fresh store state after an install, so the servers tab stays in sync. */
  onInstalled: (state: McpStoreState) => void;
}

/** Browse the MCP catalog: search, category chips, tier filter, install. */
export function McpCatalogBrowser({ onInstalled }: McpCatalogBrowserProps) {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const lang = i18n.language ?? "en";

  const [list, setList] = React.useState<McpCatalogList | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [category, setCategory] = React.useState("");
  const [tier, setTier] = React.useState("");
  const [installTarget, setInstallTarget] =
    React.useState<McpCatalogEntry | null>(null);

  const loadFirst = React.useCallback(async () => {
    setLoading(true);
    try {
      const page = await getMcpCatalog(MCP_SPACE_BASE_PATH, {
        q: query || undefined,
        category: category || undefined,
        tier: tier || undefined,
        limit: PAGE_SIZE,
      });
      setList(appendCatalogPage(null, page));
    } catch (error) {
      toast({
        variant: "destructive",
        title: t("Failed to load the MCP catalog"),
        description: describeMcpError(error, t),
      });
      setList(null);
    } finally {
      setLoading(false);
    }
  }, [query, category, tier, t, toast]);

  React.useEffect(() => {
    void loadFirst();
  }, [loadFirst]);

  const loadMore = async () => {
    if (!list?.cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await getMcpCatalog(MCP_SPACE_BASE_PATH, {
        q: query || undefined,
        category: category || undefined,
        tier: tier || undefined,
        cursor: list.cursor,
        limit: PAGE_SIZE,
      });
      setList((prev) => appendCatalogPage(prev, page));
    } catch (error) {
      toast({
        variant: "destructive",
        title: t("Failed to load more catalog entries"),
        description: describeMcpError(error, t),
      });
    } finally {
      setLoadingMore(false);
    }
  };

  const chips = catalogCategoryChips(list?.categories ?? {});

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-52 flex-1">
          <Search
            size={14}
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("Search the catalog...")}
            className="pl-8"
            aria-label={t("Search the catalog")}
          />
        </div>
        <Select
          value={tier}
          onChange={(event) => setTier(event.target.value)}
          className="w-36"
          aria-label={t("Tier")}
        >
          <option value="">{t("All tiers")}</option>
          {MCP_CATALOG_TIERS.map((value) => (
            <option key={value} value={value}>
              {t(value)}
            </option>
          ))}
        </Select>
      </div>

      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => setCategory("")}
            className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
              category === ""
                ? "border-primary bg-primary-muted text-accent-foreground"
                : "border-border text-muted-foreground hover:text-foreground"
            }`}
          >
            {t("All")}
          </button>
          {chips.map((chip) => (
            <button
              key={chip.category}
              type="button"
              onClick={() =>
                setCategory(category === chip.category ? "" : chip.category)
              }
              className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                category === chip.category
                  ? "border-primary bg-primary-muted text-accent-foreground"
                  : "border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              {t(chip.category)} ({chip.count})
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28 w-full" />
          ))}
        </div>
      ) : !list || list.entries.length === 0 ? (
        <div className="surface">
          <EmptyState
            icon={PackageOpen}
            title={t("No catalog entries found")}
            description={t("Try a different search or filter.")}
          />
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            {list.entries.map((entry) => (
              <CatalogCard
                key={entry.id}
                entry={entry}
                lang={lang}
                onInstall={() => setInstallTarget(entry)}
              />
            ))}
          </div>
          {list.cursor && (
            <div className="flex justify-center">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void loadMore()}
                loading={loadingMore}
              >
                {t("Load more")}
              </Button>
            </div>
          )}
        </>
      )}

      <InstallDialog
        entry={installTarget}
        lang={lang}
        onClose={() => setInstallTarget(null)}
        onInstalled={(state) => {
          onInstalled(state);
          setInstallTarget(null);
          void loadFirst();
        }}
      />
    </div>
  );
}

function CatalogCard({
  entry,
  lang,
  onInstall,
}: {
  entry: McpCatalogEntry;
  lang: string;
  onInstall: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="surface flex flex-col p-4">
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-muted text-xs font-semibold text-accent-foreground"
        >
          {catalogInitials(entry.display_name)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-medium text-foreground">
              {entry.display_name}
            </h3>
            {entry.installed && (
              <Badge variant="success" className="shrink-0">
                {t("Installed")}
              </Badge>
            )}
          </div>
          <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
            {localizedCatalogText(entry.description_i18n, lang)}
          </p>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {t(entry.category)}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={onInstall}
          disabled={!entry.self_service}
        >
          <Download size={13} aria-hidden="true" />
          {entry.installed ? t("Add another") : t("Install")}
        </Button>
      </div>
    </div>
  );
}

function InstallDialog({
  entry,
  lang,
  onClose,
  onInstalled,
}: {
  entry: McpCatalogEntry | null;
  lang: string;
  onClose: () => void;
  onInstalled: (state: McpStoreState) => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [name, setName] = React.useState("");
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [installing, setInstalling] = React.useState(false);

  React.useEffect(() => {
    if (!entry) return;
    setName(entry.installed_as[0] ?? entry.id);
    setValues({});
    setInstalling(false);
  }, [entry]);

  if (!entry) return null;

  const fields = entry.fields;
  const ready = canInstallEntry(fields, values);
  const requires = localizedCatalogText(entry.requires_i18n, lang);

  const handleInstall = async () => {
    if (!ready || installing) return;
    setInstalling(true);
    try {
      const state = await installMcpCatalogEntry(MCP_SPACE_BASE_PATH, entry.id, {
        name: name.trim() || entry.id,
        secrets: filledCredentials(values),
      });
      toast({
        variant: "success",
        title: t("Server installed"),
        description: entry.display_name,
      });
      onInstalled(state);
    } catch (error) {
      toast({
        variant: "destructive",
        title: t("Failed to install server"),
        description: describeMcpError(error, t),
      });
    } finally {
      setInstalling(false);
    }
  };

  return (
    <Dialog open onClose={onClose}>
      <DialogTitle>
        {t("Install {{name}}", { name: entry.display_name })}
      </DialogTitle>
      <DialogDescription>
        {localizedCatalogText(entry.description_i18n, lang)}
      </DialogDescription>

      <div className="mt-4 space-y-3">
        {requires && (
          <p className="rounded-lg border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
            {requires}
          </p>
        )}
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            {t("Server name")}
          </label>
          <Input value={name} onChange={(event) => setName(event.target.value)} />
        </div>
        {fields.map((field) => (
          <div key={field.key}>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              {localizedCatalogText(field.label_i18n, lang) || field.key}
              {field.required && <span className="text-destructive"> *</span>}
            </label>
            <Input
              type={field.secret ? "password" : "text"}
              value={values[field.key] ?? ""}
              placeholder={field.placeholder}
              onChange={(event) =>
                setValues((prev) => ({ ...prev, [field.key]: event.target.value }))
              }
            />
          </div>
        ))}
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={installing}>
          {t("Cancel")}
        </Button>
        <Button
          onClick={() => void handleInstall()}
          disabled={!ready || installing}
          loading={installing}
        >
          {t("Install")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

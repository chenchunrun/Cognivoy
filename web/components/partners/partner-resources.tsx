"use client";

import * as React from "react";
import { BookOpen, Database, NotebookPen, Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  addPartnerAssets,
  getPartnerAssets,
  removePartnerAsset,
  type PartnerAssets,
} from "@/lib/partners-api";
import {
  partnerAssetDeleteType,
  type PartnerAssetCollection,
} from "@/lib/partner-detail";
import { Button, EmptyState, Input, Skeleton, useToast } from "@/components/ui";

const EMPTY_ASSETS: PartnerAssets = {
  knowledge_bases: [],
  skills: [],
  notebooks: [],
};

const GROUPS = [
  {
    key: "knowledge_bases",
    title: "Knowledge bases",
    description: "Ground answers in a private copy of a knowledge base.",
    placeholder: "Knowledge base name",
    icon: Database,
  },
  {
    key: "skills",
    title: "Skills",
    description: "Give this partner reusable instructions and workflows.",
    placeholder: "Skill name",
    icon: BookOpen,
  },
  {
    key: "notebooks",
    title: "Notebooks",
    description: "Attach a notebook by its ID so the partner can use its records.",
    placeholder: "Notebook ID",
    icon: NotebookPen,
  },
] as const satisfies ReadonlyArray<{
  key: PartnerAssetCollection;
  title: string;
  description: string;
  placeholder: string;
  icon: typeof Database;
}>;

export function PartnerResources({ partnerId }: { partnerId: string }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [assets, setAssets] = React.useState<PartnerAssets | null>(null);
  const [drafts, setDrafts] = React.useState<Record<PartnerAssetCollection, string>>({
    knowledge_bases: "",
    skills: "",
    notebooks: "",
  });
  const [busy, setBusy] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void getPartnerAssets(partnerId)
      .then((response) => {
        if (!cancelled) setAssets(response);
      })
      .catch((error) => {
        if (!cancelled) {
          setAssets(EMPTY_ASSETS);
          toast({
            title:
              error instanceof Error
                ? error.message
                : t("Failed to load resources"),
            variant: "destructive",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [partnerId, t, toast]);

  const add = async (collection: PartnerAssetCollection) => {
    const value = drafts[collection].trim();
    if (!value) return;
    setBusy(`add:${collection}`);
    try {
      const response = await addPartnerAssets(partnerId, { [collection]: [value] });
      setAssets(response.assets);
      setDrafts((current) => ({ ...current, [collection]: "" }));
      if (response.errors.length > 0) {
        toast({ title: response.errors[0].error, variant: "destructive" });
      } else {
        toast({ title: t("Resource attached"), variant: "success" });
      }
    } catch (error) {
      toast({
        title: error instanceof Error ? error.message : t("Failed to attach resource"),
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  };

  const remove = async (
    collection: PartnerAssetCollection,
    id: string,
  ) => {
    setBusy(`remove:${collection}:${id}`);
    try {
      const response = await removePartnerAsset(
        partnerId,
        partnerAssetDeleteType(collection),
        id,
      );
      setAssets(response.assets);
      toast({ title: t("Resource detached"), variant: "success" });
    } catch (error) {
      toast({
        title: error instanceof Error ? error.message : t("Failed to detach resource"),
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  };

  if (!assets) {
    return (
      <div className="space-y-3">
        {[0, 1, 2].map((item) => (
          <Skeleton key={item} className="h-36 w-full" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {GROUPS.map((group) => {
        const rows = assets[group.key];
        return (
          <section key={group.key} className="surface p-5">
            <div className="mb-4 flex items-start gap-3">
              <div className="rounded-lg bg-primary-muted p-2 text-primary">
                <group.icon className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-medium text-foreground">{t(group.title)}</h3>
                <p className="mt-0.5 text-xs text-muted-foreground">{t(group.description)}</p>
              </div>
              <span className="text-xs text-muted-foreground">{rows.length}</span>
            </div>

            {rows.length === 0 ? (
              <EmptyState
                icon={group.icon}
                title={t("No resources attached")}
                description={t("Attach one below; provisioning errors will remain visible.")}
                className="min-h-24 py-3"
              />
            ) : (
              <div className="mb-4 divide-y divide-border rounded-lg border border-border">
                {rows.map((row) => {
                  const id = "id" in row ? row.id : row.name;
                  const metadata =
                    "documents" in row
                      ? t("{{count}} documents", { count: row.documents ?? 0 })
                      : "record_count" in row
                        ? t("{{count}} records", { count: row.record_count ?? 0 })
                        : t("Skill");
                  return (
                    <div key={id} className="flex items-center gap-3 px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-foreground">{row.name || id}</p>
                        <p className="text-xs text-muted-foreground">{metadata}</p>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={busy === `remove:${group.key}:${id}`}
                        aria-label={t("Detach {{name}}", { name: row.name || id })}
                        title={t("Detach resource")}
                        onClick={() => void remove(group.key, id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="flex gap-2">
              <Input
                value={drafts[group.key]}
                placeholder={t(group.placeholder)}
                onChange={(event) =>
                  setDrafts((current) => ({
                    ...current,
                    [group.key]: event.target.value,
                  }))
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter") void add(group.key);
                }}
              />
              <Button
                variant="outline"
                disabled={!drafts[group.key].trim()}
                loading={busy === `add:${group.key}`}
                onClick={() => void add(group.key)}
              >
                <Plus className="h-3.5 w-3.5" />
                {t("Attach")}
              </Button>
            </div>
          </section>
        );
      })}
    </div>
  );
}

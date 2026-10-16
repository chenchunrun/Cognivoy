"use client";

import * as React from "react";
import { useTranslation } from "react-i18next";
import { PackageOpen, Pencil, Plus, Search, Trash2, Wand2 } from "lucide-react";
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  Input,
  Skeleton,
  useToast,
} from "@/components/ui";
import { SpaceHeader } from "@/components/space/SpaceHeader";
import {
  SkillFormDialog,
  type SkillFormValues,
} from "@/components/space/SkillFormDialog";
import { SkillDetailDialog } from "@/components/space/SkillDetailDialog";
import { EduHubImportDialog } from "@/components/space/EduHubImportDialog";
import {
  createSkill,
  deleteSkill,
  getSkill,
  listSkills,
  updateSkill,
  type SkillDetail,
  type SkillInfo,
} from "@/lib/skills-api";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const SOURCE_ORDER: Record<string, number> = { user: 0, admin: 1, builtin: 2 };

export default function SpaceSkillsPage() {
  const { t } = useTranslation();
  const { toast } = useToast();

  const [skills, setSkills] = React.useState<SkillInfo[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [query, setQuery] = React.useState("");
  const [tagFilter, setTagFilter] = React.useState<string | null>(null);

  const [detailTarget, setDetailTarget] = React.useState<SkillInfo | null>(null);
  const [formOpen, setFormOpen] = React.useState(false);
  const [formTarget, setFormTarget] = React.useState<SkillDetail | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<SkillInfo | null>(null);
  const [deleting, setDeleting] = React.useState(false);
  const [importOpen, setImportOpen] = React.useState(false);

  const load = React.useCallback(
    async (force = false) => {
      setLoading(true);
      try {
        setSkills(await listSkills({ force }));
      } catch (error) {
        toast({
          variant: "destructive",
          title: t("Failed to load skills"),
          description: errorMessage(error),
        });
      } finally {
        setLoading(false);
      }
    },
    [t, toast],
  );

  React.useEffect(() => {
    void load();
  }, [load]);

  const allTags = React.useMemo(() => {
    const tags = new Set<string>();
    for (const skill of skills) for (const tag of skill.tags) tags.add(tag);
    return [...tags].sort();
  }, [skills]);

  const filtered = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    return skills
      .filter((skill) => {
        if (tagFilter && !skill.tags.includes(tagFilter)) return false;
        if (!needle) return true;
        return [skill.name, skill.description]
          .filter(Boolean)
          .some((value) => value.toLowerCase().includes(needle));
      })
      .sort(
        (a, b) =>
          (SOURCE_ORDER[a.source ?? "user"] ?? 0) -
            (SOURCE_ORDER[b.source ?? "user"] ?? 0) || a.name.localeCompare(b.name),
      );
  }, [skills, query, tagFilter]);

  const openEditor = async (skill: SkillInfo) => {
    try {
      setFormTarget(await getSkill(skill.name));
      setFormOpen(true);
    } catch (error) {
      toast({
        variant: "destructive",
        title: t("Failed to load skill"),
        description: errorMessage(error),
      });
    }
  };

  const handleSubmit = async (values: SkillFormValues) => {
    try {
      if (formTarget) {
        await updateSkill(formTarget.name, {
          description: values.description,
          content: values.content,
          tags: values.tags,
          ...(values.name !== formTarget.name
            ? { rename_to: values.name }
            : {}),
        });
        toast({ variant: "success", title: t("Skill updated") });
      } else {
        await createSkill(values);
        toast({ variant: "success", title: t("Skill created") });
      }
      await load(true);
    } catch (error) {
      toast({
        variant: "destructive",
        title: formTarget
          ? t("Failed to update skill")
          : t("Failed to create skill"),
        description: errorMessage(error),
      });
      throw error;
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteSkill(deleteTarget.name);
      toast({ variant: "success", title: t("Skill deleted") });
      setDeleteTarget(null);
      await load(true);
    } catch (error) {
      toast({
        variant: "destructive",
        title: t("Failed to delete skill"),
        description: errorMessage(error),
      });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <SpaceHeader
        back
        title={t("Skills")}
        description={t(
          "Capability playbooks the model reads on demand — yours, plus the built-in set.",
        )}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
              <PackageOpen size={14} aria-hidden="true" />
              {t("Import from EduHub")}
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setFormTarget(null);
                setFormOpen(true);
              }}
            >
              <Plus size={14} aria-hidden="true" />
              {t("New skill")}
            </Button>
          </>
        }
      />

      <div className="mb-4 space-y-3">
        <div className="relative max-w-sm">
          <Search
            size={14}
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("Search skills...")}
            className="pl-8"
            aria-label={t("Search skills")}
          />
        </div>
        {allTags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setTagFilter(null)}
              className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                tagFilter === null
                  ? "border-primary bg-primary-muted text-accent-foreground"
                  : "border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              {t("All")}
            </button>
            {allTags.map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() => setTagFilter(tagFilter === tag ? null : tag)}
                className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                  tagFilter === tag
                    ? "border-primary bg-primary-muted text-accent-foreground"
                    : "border-border text-muted-foreground hover:text-foreground"
                }`}
              >
                {tag}
              </button>
            ))}
          </div>
        )}
      </div>

      {loading ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="surface">
          <EmptyState
            icon={Wand2}
            title={query || tagFilter ? t("No matching skills") : t("No skills yet")}
            description={
              query || tagFilter
                ? t("Try a different search or tag.")
                : t("Create a skill or import one from EduHub.")
            }
          />
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {filtered.map((skill) => (
            <div key={skill.name} className="surface flex flex-col p-4">
              <button
                type="button"
                onClick={() => setDetailTarget(skill)}
                className="min-w-0 flex-1 text-left"
              >
                <div className="flex items-center gap-2">
                  <h3 className="truncate text-sm font-medium text-foreground">
                    {skill.name}
                  </h3>
                  {skill.source && skill.source !== "user" && (
                    <Badge variant="outline" className="shrink-0">
                      {t(skill.source)}
                    </Badge>
                  )}
                </div>
                <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                  {skill.description || t("No description")}
                </p>
                {skill.tags.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {skill.tags.map((tag) => (
                      <Badge key={tag}>{tag}</Badge>
                    ))}
                  </div>
                )}
              </button>
              <div className="mt-3 flex items-center justify-end gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDetailTarget(skill)}
                >
                  {t("View")}
                </Button>
                {!skill.read_only && (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void openEditor(skill)}
                    >
                      <Pencil size={13} aria-hidden="true" />
                      {t("Edit")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setDeleteTarget(skill)}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 size={13} aria-hidden="true" />
                      {t("Delete")}
                    </Button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <SkillDetailDialog
        open={Boolean(detailTarget)}
        onClose={() => setDetailTarget(null)}
        skill={detailTarget}
      />
      <SkillFormDialog
        open={formOpen}
        onClose={() => setFormOpen(false)}
        skill={formTarget}
        onSubmit={handleSubmit}
      />
      <EduHubImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onInstalled={() => void load(true)}
      />
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void handleDelete()}
        title={t("Delete skill")}
        description={t('Delete the skill "{{name}}"? This cannot be undone.', {
          name: deleteTarget?.name ?? "",
        })}
        confirmText={t("Delete")}
        destructive
        loading={deleting}
      />
    </div>
  );
}

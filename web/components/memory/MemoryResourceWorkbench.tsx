"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Database, Download, Link2, Merge, Pause, Pencil, Play, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { PageHeader } from "@/components/shell/PageHeader";
import { fetchLearningProjects, type LearningProject } from "@/lib/learning-project-api";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  EmptyState,
  Input,
  Select,
  Skeleton,
  Textarea,
  useToast,
} from "@/components/ui";
import {
  deleteMemoryResource,
  exportMemoryResources,
  listMemoryResources,
  mergeMemoryResources,
  restoreDeletedMemoryEntry,
  updateMemoryResource,
  updateMemoryResourceProjects,
  updateMemoryResourceState,
  type MemoryLayer,
  type MemoryResource,
} from "./api";
import { MemorySubNav } from "./MemorySubNav";

type LayerFilter = "all" | MemoryLayer;
type StatusFilter = "active" | "deleted" | "all";

export function MemoryResourceWorkbench() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [items, setItems] = useState<MemoryResource[]>([]);
  const [total, setTotal] = useState(0);
  const [layer, setLayer] = useState<LayerFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("active");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<MemoryResource | null>(null);
  const [editText, setEditText] = useState("");
  const [editSection, setEditSection] = useState("");
  const [deleting, setDeleting] = useState<MemoryResource | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [projects, setProjects] = useState<LearningProject[]>([]);
  const [assigning, setAssigning] = useState<MemoryResource | null>(null);
  const [assignedProjectIds, setAssignedProjectIds] = useState<Set<string>>(new Set());

  const resourceKey = (item: MemoryResource) => `${item.layer}:${item.key}:${item.id}`;
  const selectedItems = useMemo(
    () => items.filter((item) => selected.has(resourceKey(item))),
    [items, selected],
  );
  const canMerge = selectedItems.length >= 2
    && selectedItems.every((item) => item.layer === selectedItems[0]?.layer && item.key === selectedItems[0]?.key);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await listMemoryResources({
        layer: layer === "all" ? undefined : layer,
        status,
      });
      setItems(result.items);
      setTotal(result.total);
    } catch (error) {
      toast({
        variant: "destructive",
        title: t("Failed to load memories"),
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setLoading(false);
    }
  }, [layer, status, t, toast]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    let active = true;
    void fetchLearningProjects()
      .then((result) => {
        if (active) setProjects(result.filter((project) => project.status === "active"));
      })
      .catch(() => {
        if (active) setProjects([]);
      });
    return () => { active = false; };
  }, []);

  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id, project.title])),
    [projects],
  );

  const visible = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return items;
    return items.filter((item) =>
      [item.text, item.section, item.key, ...item.refs]
        .join(" ")
        .toLocaleLowerCase()
        .includes(normalized),
    );
  }, [items, query]);

  const handleExport = async () => {
    setBusy("export");
    try {
      const payload = await exportMemoryResources(status !== "active");
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "cognivoy-memory.json";
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      toast({ title: t("Memories exported") });
    } catch (error) {
      toast({
        variant: "destructive",
        title: t("Failed to export memories"),
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto max-w-7xl px-6 py-8">
      <PageHeader
        title={t("Memory details")}
        description={t("Inspect what Cognivoy remembers, where it came from, why it is retained, and which learning features it can influence.")}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => void load()} loading={loading}>
              {!loading && <RefreshCw size={14} />}
              {t("Refresh")}
            </Button>
            <Button variant="outline" size="sm" onClick={() => void handleExport()} loading={busy === "export"} data-testid="memory-export">
              {busy !== "export" && <Download size={14} />}
              {t("Export memories")}
            </Button>
            <Button variant="outline" size="sm" disabled={!canMerge} loading={busy === "merge"} data-testid="memory-merge" onClick={async () => {
              if (!canMerge) return;
              setBusy("merge");
              try {
                await mergeMemoryResources(selectedItems);
                setSelected(new Set());
                await load();
                toast({ title: t("Duplicate memories merged") });
              } catch (error) {
                toast({ variant: "destructive", title: t("Failed to merge memories"), description: error instanceof Error ? error.message : String(error) });
                await load();
              } finally { setBusy(null); }
            }}>
              {busy !== "merge" && <Merge size={14} />}{t("Merge selected")}
            </Button>
          </>
        }
      />
      <div className="mb-6"><MemorySubNav /></div>

      <div className="mb-5 grid gap-3 sm:grid-cols-[12rem_12rem_1fr]">
        <Select value={layer} onChange={(event) => {
          setLoading(true);
          setLayer(event.target.value as LayerFilter);
        }} aria-label={t("Memory layer")}>
          <option value="all">{t("All memory layers")}</option>
          <option value="L2">{t("L2 · Learning facts")}</option>
          <option value="L3">{t("L3 · Long-term understanding")}</option>
        </Select>
        <Select value={status} onChange={(event) => {
          setLoading(true);
          setStatus(event.target.value as StatusFilter);
        }} aria-label={t("Memory status")}>
          <option value="active">{t("Active memories")}</option>
          <option value="deleted">{t("Recently deleted")}</option>
          <option value="all">{t("All statuses")}</option>
        </Select>
        <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("Search memory text, source, or section")} />
      </div>

      <p className="mb-3 text-xs text-muted-foreground">
        {t("Showing {{visible}} of {{total}} memories", { visible: visible.length, total })}
      </p>
      {loading && items.length === 0 ? (
        <div className="space-y-3">{[0, 1, 2].map((index) => <Skeleton key={index} className="h-48 w-full rounded-xl" />)}</div>
      ) : visible.length === 0 ? (
        <EmptyState icon={Database} title={t("No memories match these filters")} description={t("Memory facts appear after learning activity is consolidated.")} />
      ) : (
        <div className="space-y-3" data-testid="memory-resource-list">
          {visible.map((item) => (
            <Card key={`${item.layer}:${item.key}:${item.id}:${item.status}`} className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                {item.status === "active" && (
                  <input
                    type="checkbox"
                    className="mt-1 h-4 w-4 accent-primary"
                    aria-label={t("Select memory for merging")}
                    checked={selected.has(resourceKey(item))}
                    onChange={(event) => setSelected((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.add(resourceKey(item)); else next.delete(resourceKey(item));
                      return next;
                    })}
                  />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">{item.layer} · {item.key}</Badge>
                    <Badge variant={item.status === "active" ? "success" : "outline"}>{t(item.status === "active" ? "Active" : "Deleted")}</Badge>
                    {item.paused && <Badge variant="outline">{t("Paused")}</Badge>}
                    {item.flagged_incorrect && <Badge variant="warning">{t("Marked incorrect")}</Badge>}
                    <span className="text-xs text-muted-foreground">{item.section}</span>
                  </div>
                  <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-foreground">{item.text}</p>
                </div>
                <div className="flex w-full max-w-full flex-wrap items-center gap-1 sm:w-auto sm:shrink-0">
                  {item.status === "active" ? (
                    <>
                      <Button variant="ghost" size="sm" data-testid={`memory-edit-${item.id}`} onClick={() => { setEditing(item); setEditText(item.text); setEditSection(item.section); }}>
                        <Pencil size={13} />{t("Edit")}
                      </Button>
                      <Button variant="ghost" size="sm" loading={busy === `state:${item.id}`} data-testid={`memory-pause-${item.id}`} onClick={async () => {
                        setBusy(`state:${item.id}`);
                        try {
                          await updateMemoryResourceState(item, { paused: !item.paused, reason: item.paused ? "learner_resumed" : "learner_paused" });
                          await load();
                          toast({ title: t(item.paused ? "Memory resumed" : "Memory paused") });
                        } catch (error) {
                          toast({ variant: "destructive", title: t("Failed to update memory state"), description: error instanceof Error ? error.message : String(error) });
                        } finally { setBusy(null); }
                      }}>
                        {item.paused ? <Play size={13} /> : <Pause size={13} />}{t(item.paused ? "Resume" : "Pause")}
                      </Button>
                      <Button variant="ghost" size="sm" loading={busy === `incorrect:${item.id}`} data-testid={`memory-incorrect-${item.id}`} onClick={async () => {
                        setBusy(`incorrect:${item.id}`);
                        try {
                          await updateMemoryResourceState(item, { flagged_incorrect: !item.flagged_incorrect, paused: !item.flagged_incorrect, reason: item.flagged_incorrect ? "learner_cleared_incorrect" : "learner_marked_incorrect" });
                          await load();
                          toast({ title: t(item.flagged_incorrect ? "Incorrect mark cleared" : "Memory marked incorrect and paused") });
                        } catch (error) {
                          toast({ variant: "destructive", title: t("Failed to update memory state"), description: error instanceof Error ? error.message : String(error) });
                        } finally { setBusy(null); }
                      }}>
                        <AlertTriangle size={13} />{t(item.flagged_incorrect ? "Clear incorrect mark" : "Mark incorrect")}
                      </Button>
                      <Button variant="ghost" size="sm" data-testid={`memory-projects-${item.id}`} onClick={() => {
                        setAssigning(item);
                        setAssignedProjectIds(new Set(item.project_ids));
                      }}>
                        <Link2 size={13} />{t("Learning plans")}
                      </Button>
                      <Button variant="ghost" size="sm" className="text-destructive" data-testid={`memory-delete-${item.id}`} onClick={() => setDeleting(item)}>
                        <Trash2 size={13} />{t("Delete")}
                      </Button>
                    </>
                  ) : (
                    <Button variant="ghost" size="sm" loading={busy === item.id} onClick={async () => {
                      setBusy(item.id);
                      try {
                        await restoreDeletedMemoryEntry(item.layer, item.key, item.id);
                        await load();
                        toast({ title: t("Memory restored") });
                      } catch (error) {
                        toast({
                          variant: "destructive",
                          title: t("Failed to restore memory"),
                          description: error instanceof Error ? error.message : String(error),
                        });
                      }
                      finally { setBusy(null); }
                    }} data-testid={`memory-restore-${item.id}`}>
                      <RotateCcw size={13} />{t("Restore")}
                    </Button>
                  )}
                </div>
              </div>
              <dl className="mt-4 grid gap-3 border-t border-border pt-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
                <MemoryFact label={t("Source")} value={item.refs.length ? item.refs.join(", ") : t("No source evidence recorded")} />
                <MemoryFact label={t("Evidence confidence")} value={`${Math.round(item.confidence * 100)}%`} />
                <MemoryFact label={t("Last updated")} value={item.updated_at ? new Date(item.updated_at).toLocaleString() : t("Not recorded")} />
                <MemoryFact label={t("Last used")} value={item.last_used_at ? new Date(item.last_used_at).toLocaleString() : t("Not used yet")} />
                <MemoryFact label={t("Influences")} value={t(item.layer === "L3" ? "Tutor personalization and learning plans" : "Surface summaries and long-term synthesis")} />
                <MemoryFact label={t("Why retained")} value={t(item.refs.length ? "Kept because it has source evidence" : "Kept until the learner reviews or deletes it")} />
                <MemoryFact
                  label={t("Learning plans")}
                  value={item.project_ids.length
                    ? item.project_ids.map((projectId) => projectNames.get(projectId) || projectId).join(", ")
                    : t("Not assigned to a learning plan")}
                />
                <MemoryFact label={t("Created")} value={item.created_at ? new Date(item.created_at).toLocaleString() : t("Not recorded")} />
                {item.reason && <MemoryFact label={t("Deletion reason")} value={item.reason} />}
                {item.state_reason && <MemoryFact label={t("Learner control")} value={item.state_reason} />}
              </dl>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={Boolean(editing)} onClose={() => setEditing(null)}>
        <DialogTitle>{t("Edit memory")}</DialogTitle>
        <DialogDescription>{t("Edits use optimistic version checks so a newer memory is never overwritten silently.")}</DialogDescription>
        <div className="mt-4 space-y-3">
          <Input value={editSection} onChange={(event) => setEditSection(event.target.value)} aria-label={t("Section")} />
          <Textarea value={editText} onChange={(event) => setEditText(event.target.value)} rows={6} aria-label={t("Memory text")} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setEditing(null)}>{t("Cancel")}</Button>
          <Button data-testid="memory-edit-save" loading={busy === editing?.id} disabled={!editText.trim()} onClick={async () => {
            if (!editing) return;
            setBusy(editing.id);
            try {
              await updateMemoryResource(editing, editText.trim(), editSection.trim() || editing.section);
              setEditing(null);
              await load();
              toast({ title: t("Memory updated") });
            } catch (error) {
              toast({
                variant: "destructive",
                title: t("Memory changed or could not be updated"),
                description: error instanceof Error ? error.message : String(error),
              });
              await load();
            }
            finally { setBusy(null); }
          }}>{t("Save")}</Button>
        </DialogFooter>
      </Dialog>

      <Dialog open={Boolean(assigning)} onClose={() => setAssigning(null)}>
        <DialogTitle>{t("Assign memory to learning plans")}</DialogTitle>
        <DialogDescription>{t("Only projects you explicitly select can use this memory as project evidence.")}</DialogDescription>
        <div className="mt-4 max-h-72 space-y-2 overflow-y-auto" data-testid="memory-project-picker">
          {projects.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("No active learning plans")}</p>
          ) : projects.map((project) => (
            <label key={project.id} className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 hover:bg-muted-subtle">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 accent-primary"
                checked={assignedProjectIds.has(project.id)}
                onChange={(event) => setAssignedProjectIds((current) => {
                  const next = new Set(current);
                  if (event.target.checked) next.add(project.id); else next.delete(project.id);
                  return next;
                })}
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-foreground">{project.title}</span>
                <span className="block text-xs text-muted-foreground">{t("Mastery {{percent}}%", { percent: Math.round(project.mastery_summary * 100) })}</span>
              </span>
            </label>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setAssigning(null)}>{t("Cancel")}</Button>
          <Button data-testid="memory-project-save" loading={busy === `projects:${assigning?.id}`} onClick={async () => {
            if (!assigning) return;
            setBusy(`projects:${assigning.id}`);
            try {
              await updateMemoryResourceProjects(assigning, [...assignedProjectIds]);
              setAssigning(null);
              await load();
              toast({ title: t("Memory project links updated") });
            } catch (error) {
              toast({
                variant: "destructive",
                title: t("Failed to update memory projects"),
                description: error instanceof Error ? error.message : String(error),
              });
            } finally { setBusy(null); }
          }}>{t("Save")}</Button>
        </DialogFooter>
      </Dialog>

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          setBusy(deleting.id);
          try {
            await deleteMemoryResource(deleting, "learner_removed");
            setDeleting(null);
            await load();
            toast({ title: t("Memory moved to Recently deleted") });
          } catch (error) {
            toast({
              variant: "destructive",
              title: t("Failed to delete memory"),
              description: error instanceof Error ? error.message : String(error),
            });
            await load();
          }
          finally { setBusy(null); }
        }}
        title={t("Delete this memory?")}
        description={t("The memory moves to Recently deleted and can be restored later.")}
        confirmText={t("Delete")}
        destructive
        loading={Boolean(deleting && busy === deleting.id)}
      />
    </div>
  );
}

function MemoryFact({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-muted-foreground">{label}</dt><dd className="mt-1 break-words text-foreground">{value}</dd></div>;
}

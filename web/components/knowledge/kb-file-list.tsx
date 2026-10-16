"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronRight,
  Eye,
  FileText,
  Folder,
  FolderInput,
  FolderPlus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import {
  Button,
  ConfirmDialog,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  Dropdown,
  DropdownItem,
  DropdownLabel,
  DropdownSeparator,
  EmptyState,
  Input,
  Skeleton,
  useToast,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import {
  createKbFolder,
  deleteKbFile,
  listKnowledgeBaseFiles,
  knowledgeBaseFilePath,
  knowledgeBaseFilePreviewTextPath,
  knowledgeBasePptxPreviewPath,
  moveKbFile,
  type KnowledgeBaseFile,
} from "@/lib/knowledge-api";
import FilePreviewDrawer from "@/components/chat/FilePreviewDrawer";
import { formatFileSize, type KnowledgeBase } from "@/lib/knowledge-helpers";
import { KbFileStatusBadge } from "./kb-badges";

interface TreeNode {
  name: string; // segment label
  path: string; // full POSIX path relative to raw/
  type: "file" | "folder";
  file?: KnowledgeBaseFile;
  children: TreeNode[];
}

function parentOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

function buildTree(entries: KnowledgeBaseFile[]): {
  root: TreeNode[];
  folderPaths: string[];
} {
  const folders = new Map<string, TreeNode>();
  const root: TreeNode[] = [];
  const folderPaths: string[] = [];

  const ensureFolder = (path: string): TreeNode => {
    const existing = folders.get(path);
    if (existing) return existing;
    const node: TreeNode = {
      name: path.slice(path.lastIndexOf("/") + 1),
      path,
      type: "folder",
      children: [],
    };
    folders.set(path, node);
    folderPaths.push(path);
    const parent = parentOf(path);
    if (parent) ensureFolder(parent).children.push(node);
    else root.push(node);
    return node;
  };

  // Folders first so a file's parent always exists, and empty folders show.
  for (const entry of entries) {
    if (entry.type === "folder") ensureFolder(entry.name);
  }
  for (const entry of entries) {
    if (entry.type === "folder") continue;
    const node: TreeNode = {
      name: entry.name.slice(entry.name.lastIndexOf("/") + 1),
      path: entry.name,
      type: "file",
      file: entry,
      children: [],
    };
    const parent = parentOf(entry.name);
    if (parent) ensureFolder(parent).children.push(node);
    else root.push(node);
  }

  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
    nodes.forEach((n) => n.children.length && sortNodes(n.children));
  };
  sortNodes(root);
  folderPaths.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  return { root, folderPaths };
}

interface KbFileListProps {
  kb: KnowledgeBase;
  /** Bump to force a refetch (e.g. after an upload task settles). */
  refreshKey: number;
}

/** Raw-document browser for a KB: folder tree, move, create folder, delete. */
export function KbFileList({ kb, refreshKey }: KbFileListProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [files, setFiles] = useState<KnowledgeBaseFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<KnowledgeBaseFile | null>(
    null,
  );
  const [deleting, setDeleting] = useState(false);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [previewTarget, setPreviewTarget] = useState<KnowledgeBaseFile | null>(null);

  const kbName = kb.name;

  const load = useCallback(
    async (force = false) => {
      setLoading(true);
      try {
        const next = await listKnowledgeBaseFiles(kbName, { force });
        setFiles(next);
        // Default-expand every folder so files are visible without digging.
        setExpanded(
          new Set(next.filter((e) => e.type === "folder").map((e) => e.name)),
        );
      } catch (err) {
        toast({
          variant: "destructive",
          title: t("Failed to load files"),
          description: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setLoading(false);
      }
    },
    [kbName, t, toast],
  );

  useEffect(() => {
    void load(refreshKey > 0);
  }, [load, refreshKey]);

  const { root, folderPaths } = useMemo(() => buildTree(files), [files]);

  const toggleFolder = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const handleCreateFolder = async () => {
    const path = newFolderName.trim().replace(/^\/+|\/+$/g, "");
    if (!path) return;
    setCreatingFolder(true);
    try {
      await createKbFolder(kbName, path);
      toast({ variant: "success", title: t("Folder created") });
      setNewFolderName("");
      setNewFolderOpen(false);
      await load(true);
    } catch (err) {
      toast({
        variant: "destructive",
        title: t("Failed to create folder"),
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setCreatingFolder(false);
    }
  };

  const handleMove = async (source: string, destFolder: string) => {
    if (parentOf(source) === destFolder) return; // already there
    setBusyPath(source);
    try {
      await moveKbFile(kbName, source, destFolder);
      toast({ variant: "success", title: t("File moved") });
      await load(true);
    } catch (err) {
      toast({
        variant: "destructive",
        title: t("Failed to move file"),
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusyPath(null);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const result = await deleteKbFile(kbName, deleteTarget.name);
      toast({
        variant: "success",
        title: t("File deleted"),
        description: result.was_indexed
          ? t("Re-index the knowledge base to purge it from retrieval.")
          : undefined,
      });
      setDeleteTarget(null);
      await load(true);
    } catch (err) {
      toast({
        variant: "destructive",
        title: t("Failed to delete file"),
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setDeleting(false);
    }
  };

  const renderNode = (node: TreeNode, depth: number): React.ReactNode => {
    if (node.type === "folder") {
      const isOpen = expanded.has(node.path);
      return (
        <li key={node.path}>
          <button
            type="button"
            onClick={() => toggleFolder(node.path)}
            className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm text-foreground transition-colors duration-150 hover:bg-muted"
            style={{ paddingLeft: `${depth * 14 + 6}px` }}
          >
            {isOpen ? (
              <ChevronDown size={13} className="shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight
                size={13}
                className="shrink-0 text-muted-foreground"
              />
            )}
            <Folder size={14} className="shrink-0 text-muted-foreground" />
            <span className="truncate">{node.name}</span>
          </button>
          {isOpen && node.children.length > 0 && (
            <ul>{node.children.map((child) => renderNode(child, depth + 1))}</ul>
          )}
        </li>
      );
    }

    const file = node.file;
    const busy = busyPath === node.path;
    return (
      <li
        key={node.path}
        className={cn(
          "group flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm transition-colors duration-150 hover:bg-muted",
          busy && "opacity-50",
        )}
        style={{ paddingLeft: `${depth * 14 + 24}px` }}
      >
        <FileText size={14} className="shrink-0 text-muted-foreground" />
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left text-foreground hover:text-primary"
          title={node.path}
          onClick={() => file && setPreviewTarget(file)}
        >
          {node.name}
        </button>
        {typeof file?.size === "number" && (
          <span className="shrink-0 text-xs text-muted-foreground">
            {formatFileSize(file.size)}
          </span>
        )}
        <KbFileStatusBadge kb={kb} />
        <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            disabled={busy}
            onClick={() => file && setPreviewTarget(file)}
            aria-label={t("Preview file")}
          >
            <Eye size={13} aria-hidden="true" />
          </Button>
          <Dropdown
            align="end"
            trigger={
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                disabled={busy}
                aria-label={t("Move to folder")}
              >
                <FolderInput size={13} aria-hidden="true" />
              </Button>
            }
          >
            <DropdownLabel>{t("Move to folder")}</DropdownLabel>
            <DropdownItem
              label={t("(root)")}
              disabled={parentOf(node.path) === ""}
              onClick={() => void handleMove(node.path, "")}
            />
            {folderPaths.length > 0 && <DropdownSeparator />}
            {folderPaths.map((folder) => (
              <DropdownItem
                key={folder}
                icon={Folder}
                label={folder}
                disabled={parentOf(node.path) === folder}
                onClick={() => void handleMove(node.path, folder)}
              />
            ))}
          </Dropdown>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            disabled={busy}
            onClick={() => file && setDeleteTarget(file)}
            aria-label={t("Delete file")}
          >
            <Trash2 size={13} aria-hidden="true" className="text-destructive" />
          </Button>
        </span>
      </li>
    );
  };

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 pb-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("Documents")}
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => void load(true)}
            aria-label={t("Refresh")}
          >
            <RefreshCw size={13} aria-hidden="true" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setNewFolderOpen(true)}
          >
            <FolderPlus size={13} aria-hidden="true" />
            {t("New folder")}
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-border bg-card p-1.5">
        {loading ? (
          <div className="space-y-1.5 p-1.5">
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} className="h-7 w-full rounded-md" />
            ))}
          </div>
        ) : root.length === 0 ? (
          <EmptyState
            icon={FileText}
            title={t("No documents yet")}
            description={t("Upload files above to start building the index.")}
            className="py-8"
          />
        ) : (
          <ul>{root.map((node) => renderNode(node, 0))}</ul>
        )}
      </div>

      <Dialog open={newFolderOpen} onClose={() => setNewFolderOpen(false)}>
        <DialogTitle>{t("New folder")}</DialogTitle>
        <DialogDescription>
          {t("Folders organize raw documents inside this knowledge base.")}
        </DialogDescription>
        <div className="mt-4">
          <Input
            value={newFolderName}
            onChange={(event) => setNewFolderName(event.target.value)}
            placeholder={t("e.g. papers/2024")}
            autoFocus
            onKeyDown={(event) => {
              if (event.key === "Enter") void handleCreateFolder();
            }}
          />
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setNewFolderOpen(false)}
            disabled={creatingFolder}
          >
            {t("Cancel")}
          </Button>
          <Button
            onClick={() => void handleCreateFolder()}
            loading={creatingFolder}
            disabled={!newFolderName.trim()}
          >
            {t("Create")}
          </Button>
        </DialogFooter>
      </Dialog>

      {previewTarget && (
        <FilePreviewDrawer
          source={{
            type: "file",
            filename: previewTarget.name,
            url: knowledgeBaseFilePath(kbName, previewTarget.name),
            text_preview_url: knowledgeBaseFilePreviewTextPath(kbName, previewTarget.name),
            slide_preview_url: knowledgeBasePptxPreviewPath(kbName, previewTarget.name),
            size_bytes: previewTarget.size,
          }}
          onClose={() => setPreviewTarget(null)}
        />
      )}

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void handleDelete()}
        title={t("Delete file")}
        description={t(
          'Delete "{{name}}" from this knowledge base? This cannot be undone.',
          { name: deleteTarget?.name ?? "" },
        )}
        confirmText={t("Delete")}
        destructive
        loading={deleting}
      />
    </div>
  );
}

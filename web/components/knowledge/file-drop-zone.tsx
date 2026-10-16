"use client";

import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileUp, X } from "lucide-react";
import { Button } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { KnowledgeUploadPolicy } from "@/lib/knowledge-api";
import {
  formatFileSize,
  mergeSelectedFiles,
  selectionFileId,
  validateFiles,
} from "@/lib/knowledge-helpers";

interface FileDropZoneProps {
  files: File[];
  onChange: (files: File[]) => void;
  uploadPolicy: KnowledgeUploadPolicy;
  disabled?: boolean;
  /** Compact copy for the detail pane (vs. the create wizard). */
  compact?: boolean;
}

/**
 * Drag-and-drop / click-to-browse file picker that validates each pick
 * against the server's supported-file-types policy and reports per-file
 * rejections inline.
 */
export function FileDropZone({
  files,
  onChange,
  uploadPolicy,
  disabled = false,
  compact = false,
}: FileDropZoneProps) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const selection = validateFiles(files, uploadPolicy, t);

  const addFiles = useCallback(
    (incoming: File[]) => {
      if (!incoming.length) return;
      onChange(mergeSelectedFiles(files, incoming));
    },
    [files, onChange],
  );

  const removeFile = useCallback(
    (id: string) => {
      onChange(files.filter((file) => selectionFileId(file) !== id));
    },
    [files, onChange],
  );

  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragOver(false);
          if (disabled) return;
          addFiles(Array.from(event.dataTransfer.files));
        }}
        className={cn(
          "flex w-full flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-border text-center transition-colors duration-150",
          compact ? "px-4 py-5" : "px-4 py-8",
          dragOver
            ? "border-primary bg-primary-muted"
            : "hover:bg-muted disabled:hover:bg-transparent",
          disabled && "cursor-not-allowed opacity-50",
        )}
      >
        <span className="rounded-full bg-muted p-2 text-muted-foreground">
          <FileUp size={compact ? 15 : 18} aria-hidden="true" />
        </span>
        <span className="text-sm font-medium text-foreground">
          {t("Drop files here, or click to browse")}
        </span>
        <span className="text-xs text-muted-foreground">
          {uploadPolicy.extensions.length > 0
            ? t("Supported: {{types}} · up to {{size}} per file", {
                types: uploadPolicy.extensions.join(" "),
                size: formatFileSize(uploadPolicy.max_file_size_bytes),
              })
            : t("Up to {{size}} per file", {
                size: formatFileSize(uploadPolicy.max_file_size_bytes),
              })}
        </span>
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        accept={uploadPolicy.accept || undefined}
        disabled={disabled}
        onChange={(event) => {
          addFiles(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />

      {selection.items.length > 0 && (
        <ul className="space-y-1">
          {selection.items.map((item) => (
            <li
              key={item.id}
              className={cn(
                "flex items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs",
                !item.valid && "border-destructive",
              )}
            >
              <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                {item.file.name}
              </span>
              <span className="shrink-0 text-muted-foreground">
                {item.sizeLabel}
              </span>
              {item.error ? (
                <span className="shrink-0 text-destructive">{item.error}</span>
              ) : (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 shrink-0"
                  disabled={disabled}
                  onClick={(event) => {
                    event.stopPropagation();
                    removeFile(item.id);
                  }}
                  aria-label={t("Remove file")}
                >
                  <X size={13} aria-hidden="true" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

"use client";

import * as React from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "./Dialog";
import { Button } from "./Button";

export interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  destructive?: boolean;
  loading?: boolean;
  confirmDisabled?: boolean;
  children?: React.ReactNode;
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmText,
  cancelText,
  destructive = false,
  loading = false,
  confirmDisabled = false,
  children,
}: ConfirmDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onClose={onClose}>
      <DialogTitle>{title}</DialogTitle>
      {description && <DialogDescription>{description}</DialogDescription>}
      {children}
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={loading}>
          {cancelText ?? t("Cancel")}
        </Button>
        <Button
          variant={destructive ? "destructive" : "primary"}
          onClick={onConfirm}
          loading={loading}
          disabled={loading || confirmDisabled}
        >
          {confirmText ?? t("Confirm")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

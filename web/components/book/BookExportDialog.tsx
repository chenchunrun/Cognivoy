"use client";

import * as React from "react";
import { useTranslation } from "react-i18next";

import {
  Button,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  Input,
  Select,
} from "@/components/ui";

import type { BookPrintOptions } from "./BookPrintDocument";

export interface BookExportDialogProps {
  open: boolean;
  onClose: () => void;
  onExport: (options: BookPrintOptions) => void;
  title: string;
}

const DEFAULT_OPTIONS: BookPrintOptions = {
  edition: "screen",
  paperSize: "A4",
  fontFamily: "serif",
  includeToc: true,
  header: "Cognivoy",
  footer: "",
};

export function BookExportDialog({ open, onClose, onExport, title }: BookExportDialogProps) {
  const { t } = useTranslation();
  const [options, setOptions] = React.useState<BookPrintOptions>(DEFAULT_OPTIONS);

  return (
    <Dialog open={open} onClose={onClose} className="max-w-lg">
      <DialogTitle>{t("PDF export settings")}</DialogTitle>
      <DialogDescription>
        {t("Choose the reading edition, typography, contents, paper, header, and footer before opening the print-to-PDF dialog.")}
      </DialogDescription>
      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <label className="text-sm font-medium text-foreground">
          {t("Edition")}
          <Select
            className="mt-1.5"
            value={options.edition}
            onChange={(event) => setOptions((current) => ({ ...current, edition: event.target.value as BookPrintOptions["edition"] }))}
          >
            <option value="screen">{t("Screen reading")}</option>
            <option value="print">{t("Print optimized")}</option>
          </Select>
        </label>
        <label className="text-sm font-medium text-foreground">
          {t("Paper size")}
          <Select
            className="mt-1.5"
            value={options.paperSize}
            onChange={(event) => setOptions((current) => ({ ...current, paperSize: event.target.value as BookPrintOptions["paperSize"] }))}
          >
            <option value="A4">{t("A4")}</option>
            <option value="Letter">{t("Letter")}</option>
          </Select>
        </label>
        <label className="text-sm font-medium text-foreground">
          {t("Body font")}
          <Select
            className="mt-1.5"
            value={options.fontFamily}
            onChange={(event) => setOptions((current) => ({ ...current, fontFamily: event.target.value as BookPrintOptions["fontFamily"] }))}
          >
            <option value="serif">{t("Serif")}</option>
            <option value="sans">{t("Sans serif")}</option>
          </Select>
        </label>
        <label className="flex items-end gap-2 pb-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={options.includeToc}
            onChange={(event) => setOptions((current) => ({ ...current, includeToc: event.target.checked }))}
            className="h-4 w-4 accent-primary"
          />
          {t("Include table of contents")}
        </label>
        <label className="text-sm font-medium text-foreground sm:col-span-2">
          {t("Page header")}
          <Input className="mt-1.5" value={options.header} maxLength={80} onChange={(event) => setOptions((current) => ({ ...current, header: event.target.value }))} />
        </label>
        <label className="text-sm font-medium text-foreground sm:col-span-2">
          {t("Page footer")}
          <Input className="mt-1.5" value={options.footer} placeholder={title} maxLength={80} onChange={(event) => setOptions((current) => ({ ...current, footer: event.target.value }))} />
        </label>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>{t("Cancel")}</Button>
        <Button onClick={() => onExport({ ...options, footer: options.footer || title })}>{t("Open print dialog")}</Button>
      </DialogFooter>
    </Dialog>
  );
}

export default BookExportDialog;

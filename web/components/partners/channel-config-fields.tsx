"use client";

/**
 * Per-channel config fields rendered from the channel's JSON schema.
 * Wraps SchemaObjectFields with secret-reveal state management, shared by
 * the creation form (one selected channel) and the Config tab (all channels).
 */

import * as React from "react";
import { useTranslation } from "react-i18next";
import type { ChannelSchemaEntry } from "@/lib/partners-api";
import { SchemaObjectFields } from "./schema-form";

export function useSecretReveal() {
  const [revealed, setRevealed] = React.useState<Set<string>>(new Set());
  const toggleSecret = React.useCallback((path: string) => {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);
  return { revealed, toggleSecret };
}

export function ChannelConfigFields({
  entry,
  value,
  onChange,
  revealed,
  toggleSecret,
}: {
  entry: ChannelSchemaEntry;
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  revealed: Set<string>;
  toggleSecret: (path: string) => void;
}) {
  const { t } = useTranslation();

  if (entry.available === false) {
    return (
      <p className="rounded-lg border border-border bg-muted-subtle px-3 py-2.5 text-sm text-muted-foreground">
        {t("This channel is unavailable on the server:")}{" "}
        {entry.unavailable_reason ?? t("missing dependency")}
      </p>
    );
  }

  if (!entry.json_schema) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("No configuration schema is available for this channel.")}
      </p>
    );
  }

  return (
    <SchemaObjectFields
      schema={entry.json_schema}
      value={value}
      onChange={onChange}
      secretFields={new Set(entry.secret_fields)}
      showSecretFor={revealed}
      toggleSecret={toggleSecret}
    />
  );
}

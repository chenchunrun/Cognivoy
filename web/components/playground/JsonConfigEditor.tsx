"use client";

/**
 * Mono JSON editor with validate-on-blur. Reports the parsed object (or null
 * while invalid) to the parent. Resets to `initialText` whenever `resetKey`
 * changes (i.e. the user picked a different tool / capability).
 */

import * as React from "react";
import { useTranslation } from "react-i18next";

import { Textarea } from "@/components/ui";
import { cn } from "@/lib/utils";

interface JsonConfigEditorProps {
  /** Changing this re-initializes the editor from `initialText`. */
  resetKey: string;
  initialText: string;
  label: string;
  disabled?: boolean;
  rows?: number;
  onParsed: (value: Record<string, unknown> | null) => void;
}

function parseObject(
  text: string,
): { value: Record<string, unknown> } | { error: string } {
  const trimmed = text.trim();
  if (!trimmed) return { value: {} };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { value: parsed as Record<string, unknown> };
    }
    return { error: "not-an-object" };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export function JsonConfigEditor({
  resetKey,
  initialText,
  label,
  disabled = false,
  rows = 8,
  onParsed,
}: JsonConfigEditorProps) {
  const { t } = useTranslation();
  const [text, setText] = React.useState(initialText);
  const [error, setError] = React.useState<string | null>(null);
  const onParsedRef = React.useRef(onParsed);

  React.useEffect(() => {
    onParsedRef.current = onParsed;
  }, [onParsed]);

  React.useEffect(() => {
    setText(initialText);
    setError(null);
    const parsed = parseObject(initialText);
    onParsedRef.current("value" in parsed ? parsed.value : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  const validate = (next: string) => {
    const parsed = parseObject(next);
    if ("value" in parsed) {
      setError(null);
      onParsedRef.current(parsed.value);
    } else {
      setError(
        parsed.error === "not-an-object"
          ? t("Config must be a JSON object.")
          : parsed.error,
      );
      onParsedRef.current(null);
    }
  };

  return (
    <div>
      <label className="mb-1.5 block text-xs font-medium text-foreground">
        {label}
      </label>
      <Textarea
        aria-label={label}
        value={text}
        disabled={disabled}
        rows={rows}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => validate(text)}
        className={cn(
          "font-mono text-xs leading-relaxed",
          error && "border-destructive focus-visible:ring-destructive",
        )}
      />
      {error ? (
        <p className="mt-1.5 text-xs text-destructive">{error}</p>
      ) : (
        <p className="mt-1.5 text-xs text-muted-foreground">
          {t("Validated on blur.")}
        </p>
      )}
    </div>
  );
}

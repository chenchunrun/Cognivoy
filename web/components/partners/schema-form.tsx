"use client";

/**
 * Schema-driven form renderer for partner channel configs.
 *
 * Renders a generic editor for ANY channel (built-in or plugin) from the
 * Pydantic JSON schema served by `GET /api/v1/partners/channels/schema`.
 * Supports string / number / boolean / enum fields, string arrays, nested
 * objects, free-form dicts (JSON textarea), required markers, and secret
 * masking with explicit reveal.
 */

import * as React from "react";
import { Eye, EyeOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Input, Select, Textarea, Toggle } from "@/components/ui";

export interface JsonSchema {
  type?: string | string[];
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  anyOf?: JsonSchema[];
}

/** Pick the first non-null variant of an `anyOf` and merge its meta. */
export function resolveSchemaVariant(s: JsonSchema): JsonSchema {
  if (!s.anyOf) return s;
  const first = s.anyOf.find((v) => v.type !== "null") ?? s.anyOf[0];
  return {
    ...first,
    title: s.title ?? first.title,
    description: s.description ?? first.description,
  };
}

/** True iff this schema's value can be `null` (e.g. `Optional[str]`). */
export function isNullable(s: JsonSchema): boolean {
  if (Array.isArray(s.type) && s.type.includes("null")) return true;
  if (s.anyOf?.some((v) => v.type === "null")) return true;
  return false;
}

/** Default value for a property when the live config doesn't set it. */
export function defaultFor(s: JsonSchema): unknown {
  if (s.default !== undefined) return s.default;
  const v = resolveSchemaVariant(s);
  switch (v.type) {
    case "boolean":
      return false;
    case "integer":
    case "number":
      return 0;
    case "array":
      return [];
    case "object":
      return {};
    case "string":
    default:
      return "";
  }
}

/** Title-case a snake_case key when no `title` is provided. */
function humaniseKey(k: string): string {
  return k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function FieldLabel({
  htmlFor,
  label,
  description,
  required,
}: {
  htmlFor?: string;
  label: string;
  description?: string;
  required?: boolean;
}) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block text-sm font-medium text-foreground">
      {label}
      {required && <span className="ml-0.5 text-destructive">*</span>}
      {description && (
        <span className="ml-1.5 font-normal text-muted-foreground">
          — {description}
        </span>
      )}
    </label>
  );
}

/** Free-form dict field (object without fixed properties) → JSON textarea. */
function JsonObjectField({
  label,
  description,
  value,
  onChange,
}: {
  label: string;
  description?: string;
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  const { t } = useTranslation();
  const fieldId = React.useId();
  const [draft, setDraft] = React.useState(() => {
    const obj =
      value && typeof value === "object"
        ? (value as Record<string, unknown>)
        : {};
    return Object.keys(obj).length ? JSON.stringify(obj, null, 2) : "";
  });
  const [invalid, setInvalid] = React.useState(false);
  return (
    <div>
      <FieldLabel
        htmlFor={fieldId}
        label={t(label)}
        description={description ? t(description) : t('JSON object, e.g. {"key": "value"}')}
      />
      <Textarea
        id={fieldId}
        value={draft}
        onChange={(e) => {
          const text = e.target.value;
          setDraft(text);
          if (!text.trim()) {
            setInvalid(false);
            onChange({});
            return;
          }
          try {
            const parsed: unknown = JSON.parse(text);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              setInvalid(false);
              onChange(parsed);
            } else {
              setInvalid(true);
            }
          } catch {
            setInvalid(true);
          }
        }}
        rows={4}
        className="font-mono text-[13px]"
      />
      {invalid && (
        <p className="mt-1 text-xs text-warning">
          {t("Invalid JSON — value not applied.")}
        </p>
      )}
    </div>
  );
}

export interface SchemaFieldProps {
  fieldKey: string;
  schema: JsonSchema;
  value: unknown;
  onChange: (next: unknown) => void;
  secretFields: Set<string>;
  path: string;
  showSecretFor: Set<string>;
  toggleSecret: (path: string) => void;
  /** Mark the label with a required asterisk. */
  required?: boolean;
}

/** Generic field renderer — recursive for nested objects. */
export function SchemaField({
  fieldKey,
  schema,
  value,
  onChange,
  secretFields,
  path,
  showSecretFor,
  toggleSecret,
  required,
}: SchemaFieldProps) {
  const { t } = useTranslation();
  const fieldId = React.useId();
  const v = resolveSchemaVariant(schema);
  const label = t(schema.title || v.title || humaniseKey(fieldKey));
  const rawDescription = schema.description || v.description;
  const description = rawDescription ? t(rawDescription) : undefined;
  const isSecret = secretFields.has(path);
  const enumValues = (v.enum ?? schema.enum) as unknown[] | undefined;

  // Boolean → toggle row (label inline).
  if (v.type === "boolean") {
    return (
      <div className="flex items-start justify-between gap-3 rounded-lg px-1 py-1">
        <span className="text-sm text-foreground">
          {label}
          {description && (
            <span className="block text-xs text-muted-foreground">
              {description}
            </span>
          )}
        </span>
        <Toggle
          checked={!!value}
          onCheckedChange={(checked) => onChange(checked)}
          aria-label={label}
        />
      </div>
    );
  }

  // Enum / Literal → select.
  if (Array.isArray(enumValues) && enumValues.length > 0) {
    return (
      <div>
        <FieldLabel htmlFor={fieldId} label={label} description={description} required={required} />
        <Select
          id={fieldId}
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
        >
          {enumValues.map((opt) => (
            <option key={String(opt)} value={String(opt)}>
              {String(opt)}
            </option>
          ))}
        </Select>
      </div>
    );
  }

  // Array of strings → textarea (one per line).
  if (v.type === "array" && (v.items?.type === "string" || !v.items)) {
    const lines = Array.isArray(value) ? (value as unknown[]).map(String) : [];
    return (
      <div>
        <FieldLabel
          htmlFor={fieldId}
          label={label}
          description={description ?? t("One value per line")}
          required={required}
        />
        <Textarea
          id={fieldId}
          value={lines.join("\n")}
          onChange={(e) =>
            onChange(
              e.target.value
                .split("\n")
                .map((s) => s.trim())
                .filter(Boolean),
            )
          }
          rows={Math.max(3, Math.min(8, lines.length + 1))}
          className="font-mono text-[13px]"
        />
      </div>
    );
  }

  // Nested object → recursive fieldset.
  if (v.type === "object" && v.properties) {
    const obj = (value && typeof value === "object" ? value : {}) as Record<
      string,
      unknown
    >;
    const childRequired = new Set(v.required ?? []);
    return (
      <fieldset className="space-y-3 rounded-lg border border-border px-3.5 py-3">
        <legend className="px-1 text-xs font-medium text-muted-foreground">
          {label}
        </legend>
        {description && (
          <p className="text-xs text-muted-foreground">{description}</p>
        )}
        {Object.entries(v.properties).map(([k, child]) => (
          <SchemaField
            key={k}
            fieldKey={k}
            schema={child}
            value={obj[k] ?? defaultFor(child)}
            onChange={(next) => onChange({ ...obj, [k]: next })}
            secretFields={secretFields}
            path={path ? `${path}.${k}` : k}
            showSecretFor={showSecretFor}
            toggleSecret={toggleSecret}
            required={childRequired.has(k)}
          />
        ))}
      </fieldset>
    );
  }

  // Free-form dict (additionalProperties only) → JSON textarea.
  if (v.type === "object") {
    return (
      <JsonObjectField
        label={label}
        description={description}
        value={value}
        onChange={onChange}
      />
    );
  }

  // Integer/number → number input.
  if (v.type === "integer" || v.type === "number") {
    return (
      <div>
        <FieldLabel htmlFor={fieldId} label={label} description={description} required={required} />
        <Input
          id={fieldId}
          type="number"
          value={typeof value === "number" ? value : ""}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === "") onChange(isNullable(schema) ? null : 0);
            else
              onChange(v.type === "integer" ? parseInt(raw, 10) : parseFloat(raw));
          }}
          className="w-44"
        />
      </div>
    );
  }

  // Default: string input (with secret reveal handling).
  const reveal = showSecretFor.has(path);
  const strVal = value == null ? "" : String(value);
  return (
    <div>
      <FieldLabel htmlFor={fieldId} label={label} description={description} required={required} />
      <div className="relative">
        <Input
          id={fieldId}
          type={isSecret && !reveal ? "password" : "text"}
          autoComplete={isSecret ? "new-password" : "off"}
          spellCheck={!isSecret}
          value={strVal}
          onChange={(e) => {
            const next = e.target.value;
            // Empty optional strings persist as null (matches Pydantic's
            // `Optional[str]` default and avoids "" sneaking past validators).
            onChange(next === "" && isNullable(schema) ? null : next);
          }}
          className={isSecret ? "pr-10 font-mono" : undefined}
        />
        {isSecret && (
          <button
            type="button"
            onClick={() => toggleSecret(path)}
            className="absolute right-1 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label={reveal ? t("Hide secret") : t("Show secret")}
            title={reveal ? t("Hide secret") : t("Show secret")}
          >
            {reveal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        )}
      </div>
    </div>
  );
}

/** Render every property of an object schema as a flat list of fields. */
export function SchemaObjectFields({
  schema,
  value,
  onChange,
  secretFields,
  showSecretFor,
  toggleSecret,
}: {
  schema: JsonSchema;
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  secretFields: Set<string>;
  showSecretFor: Set<string>;
  toggleSecret: (path: string) => void;
}) {
  const properties = schema.properties ?? {};
  const requiredKeys = new Set(schema.required ?? []);
  return (
    <div className="space-y-4">
      {Object.entries(properties).map(([key, child]) => (
        <SchemaField
          key={key}
          fieldKey={key}
          schema={child}
          value={value[key] ?? defaultFor(child)}
          onChange={(next) => onChange({ ...value, [key]: next })}
          secretFields={secretFields}
          path={key}
          showSecretFor={showSecretFor}
          toggleSecret={toggleSecret}
          required={requiredKeys.has(key)}
        />
      ))}
    </div>
  );
}

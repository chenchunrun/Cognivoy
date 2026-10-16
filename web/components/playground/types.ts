/**
 * Shared types for the capability playground.
 *
 * Shapes mirror `GET /api/v1/plugins/list` and the SSE payloads emitted by
 * `POST /api/v1/plugins/{tools|capabilities}/{name}/execute-stream`.
 */

export interface ToolParam {
  name: string;
  type: string;
  description?: string;
  required?: boolean;
  default?: unknown;
  enum?: string[] | null;
}

export interface ToolInfo {
  name: string;
  description: string;
  parameters?: ToolParam[];
}

export interface CapabilityInfo {
  name: string;
  description: string;
  stages?: string[];
  tools_used?: string[];
  availability?: {
    name: string;
    available: boolean;
    install_hint?: string;
  };
}

export interface PluginsListResponse {
  tools?: ToolInfo[];
  capabilities?: CapabilityInfo[];
  execution_enabled?: boolean;
}

export type PluginSelection =
  | { kind: "tool"; name: string }
  | { kind: "capability"; name: string };

/** One row in the live event log (stream event or process log line). */
export interface LogEntry {
  id: number;
  type: string;
  stage?: string;
  content: string;
  metadata?: Record<string, unknown>;
}

/** Normalized final result for both tool and capability runs. */
export interface RunResult {
  success: boolean;
  content: string;
  elapsedMs?: number;
  sources: Array<Record<string, string>>;
  extra?: Record<string, unknown>;
}

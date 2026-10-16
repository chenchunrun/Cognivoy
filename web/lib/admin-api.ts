import { apiFetch, apiUrl } from "@/lib/api";

export interface UserRecord {
  id: string;
  username: string;
  display_name?: string;
  role: "admin" | "user";
  created_at: string;
  disabled?: boolean;
  /** Avatar marker: "", "icon:<name>:<color>", or "img:<version>". */
  avatar?: string;
}

export async function listUsers(): Promise<UserRecord[]> {
  const res = await apiFetch(apiUrl("/api/v1/auth/users"));
  if (!res.ok) throw new Error("Failed to fetch users");
  return res.json();
}

export type UserAssetStrategy = "preserve" | "export" | "transfer" | "purge";

export async function deleteUser(
  username: string,
  options: { assetStrategy?: UserAssetStrategy; transferTo?: string } = {},
): Promise<void> {
  const params = new URLSearchParams({
    asset_strategy: options.assetStrategy ?? "preserve",
  });
  if (options.transferTo) params.set("transfer_to", options.transferTo);
  const res = await apiFetch(
    apiUrl(`/api/v1/auth/users/${encodeURIComponent(username)}?${params.toString()}`),
    {
      method: "DELETE",
    },
  );
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail ?? "Failed to delete user");
  }
}

export interface UserDeletionImpact {
  username: string;
  user_id: string;
  workspace_exists: boolean;
  workspace_shared: boolean;
  resources: Record<string, number>;
  file_count: number | null;
  total_bytes: number | null;
  truncated?: boolean;
  policy: "preserve_workspace";
  available_strategies: UserAssetStrategy[];
}

export async function getUserDeletionImpact(username: string): Promise<UserDeletionImpact> {
  const res = await apiFetch(
    apiUrl(`/api/v1/auth/users/${encodeURIComponent(username)}/deletion-impact`),
    { cache: "no-store" },
  );
  if (!res.ok) throw new Error("Failed to inspect user workspace");
  return (await res.json()) as UserDeletionImpact;
}

export async function setUserRole(
  username: string,
  role: "admin" | "user",
): Promise<void> {
  const res = await apiFetch(
    apiUrl(`/api/v1/auth/users/${encodeURIComponent(username)}/role`),
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    },
  );
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail ?? "Failed to update role");
  }
}

export async function setUserDisabled(
  username: string,
  disabled: boolean,
): Promise<void> {
  const res = await apiFetch(
    apiUrl(`/api/v1/auth/users/${encodeURIComponent(username)}/disabled`),
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ disabled }),
    },
  );
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const detail = data?.detail;
    throw new Error(
      typeof detail === "string"
        ? detail
        : typeof detail?.message === "string"
          ? detail.message
          : "Failed to update account status",
    );
  }
}

export interface CreatedUser {
  user_id: string;
  username: string;
  role: "admin" | "user";
  is_admin: boolean;
}

export async function createUser(
  username: string,
  password: string,
): Promise<CreatedUser> {
  const res = await apiFetch(apiUrl("/api/v1/auth/users"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const detail = data?.detail;
    const message =
      typeof detail === "string"
        ? detail
        : Array.isArray(detail) && detail.length > 0 && detail[0]?.msg
          ? String(detail[0].msg)
          : "Failed to create user";
    throw new Error(message);
  }
  return (await res.json()) as CreatedUser;
}

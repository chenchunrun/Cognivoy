import { cookies } from "next/headers";

import type { LearningDashboard } from "@/lib/learning-project-api";
import { COOKIE_NAME } from "@/lib/proxy-policy";

import ChatHomePage from "./HomeClient";

function dashboardApiUrl(): URL | null {
  const configured =
    process.env.COGNIVOY_API_BASE_URL
    ?? process.env.NEXT_PUBLIC_API_BASE
    ?? "http://127.0.0.1:8001";
  try {
    const base = new URL(configured);
    if (base.protocol !== "http:" && base.protocol !== "https:") return null;
    return new URL("/api/v1/learning/dashboard", base);
  } catch {
    return null;
  }
}

async function loadInitialDashboard(): Promise<LearningDashboard | null> {
  const url = dashboardApiUrl();
  if (!url) return null;
  const token = (await cookies()).get(COOKIE_NAME)?.value;
  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers: token ? { cookie: `${COOKIE_NAME}=${token}` } : undefined,
      signal: AbortSignal.timeout(800),
    });
    if (!response.ok) return null;
    return await response.json() as LearningDashboard;
  } catch {
    // The client keeps the existing retry/error experience when the API is
    // starting, offline, or intentionally unavailable during a static build.
    return null;
  }
}

export default async function Page() {
  const dashboard = await loadInitialDashboard();
  const snapshotKey = dashboard?.primary_project
    ? `${dashboard.primary_project.id}:${dashboard.primary_project.version}`
    : "empty";
  return <ChatHomePage key={snapshotKey} initialDashboard={dashboard} />;
}

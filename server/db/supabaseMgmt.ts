import type { SupabaseProjectItem } from "../../shared/types.js";
import { env } from "../env.js";

const base = () => env.supabase.apiBase.replace(/\/$/, "");

async function sb<T>(path: string, accessToken: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${base()}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(45_000),
  });
  if (res.status === 401) throw new Error("Supabase session expired or was revoked; reconnect Supabase.");
  if (res.status === 403) throw new Error("The Supabase authorization lacks the scope for this action (the OAuth app needs database access).");
  if (res.status === 429) throw new Error("Supabase Management API rate limit reached; try again in a minute.");
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try { const j = JSON.parse(text); detail = j.message ?? j.error ?? j.error_description ?? detail; } catch { /* keep text */ }
    throw new Error(`Supabase: ${detail}`);
  }
  return (text ? JSON.parse(text) : null) as T;
}

/** Run one SQL statement on a project through the Management API, always read-only. */
export async function sbQuery(accessToken: string, ref: string, sql: string): Promise<Record<string, unknown>[]> {
  const data = await sb<unknown>(`/v1/projects/${encodeURIComponent(ref)}/database/query`, accessToken, { method: "POST", body: JSON.stringify({ query: sql, read_only: true }) });
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (data && typeof data === "object" && Array.isArray((data as { result?: unknown }).result)) return (data as { result: Record<string, unknown>[] }).result;
  return [];
}

export async function sbListProjects(accessToken: string): Promise<SupabaseProjectItem[]> {
  const [projects, orgs] = await Promise.all([
    sb<{ id: string; name: string; region?: string; status?: string; organization_id?: string }[]>("/v1/projects", accessToken),
    sb<{ id: string; name: string }[]>("/v1/organizations", accessToken).catch(() => [] as { id: string; name: string }[]),
  ]);
  const orgName = new Map(orgs.map((o) => [o.id, o.name]));
  return (projects ?? []).map((p) => ({ ref: p.id, name: p.name, region: p.region, status: p.status, orgName: p.organization_id ? orgName.get(p.organization_id) : undefined }));
}

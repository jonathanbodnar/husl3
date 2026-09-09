import type { AdDataset, ChatEvent, ChatRequest, DbSchema, GithubRepoItem, HealthResponse, PostgresConnection, PromptsRequest, PromptsResponse, RepoDigest, Scoreboard, ScoreboardEval, SiteDigest, StatResult, SupabaseProjectItem } from "../../shared/types";
import { store } from "./state";

export interface BrainIndex { version: string; stages: { id: string; name: string; goal: string }[]; principles: { id: string; key: string; title: string }[]; evidence: Record<string, string> }

function headers(): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  const code = store.accessCode();
  if (code) h["x-access-code"] = code;
  return h;
}

async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { method: "POST", headers: headers(), body: JSON.stringify(body), signal });
  if (!res.ok) throw new Error(await errorText(res));
  return (await res.json()) as T;
}

async function errorText(res: Response): Promise<string> {
  try { const j = await res.json(); return j.error ?? `HTTP ${res.status}`; } catch { return `HTTP ${res.status}`; }
}

export const api = {
  health: async () => (await fetch("/api/health")).json() as Promise<HealthResponse>,
  brainIndex: async () => { const r = await fetch("/api/brain/index", { headers: headers() }); if (!r.ok) throw new Error(await errorText(r)); return (await r.json()) as BrainIndex; },
  scan: (url: string) => post<SiteDigest>("/api/site/scan", { url }),
  introspectDb: (connection: PostgresConnection) => post<DbSchema>("/api/db/introspect", { connection }),
  githubRepos: async (token: string) => { const r = await fetch("/api/github/repos", { headers: { ...headers(), "x-github-token": token } }); if (!r.ok) throw new Error(await errorText(r)); return (await r.json()) as GithubRepoItem[]; },
  supabaseProjects: async (token: string) => { const r = await fetch("/api/supabase/projects", { headers: { ...headers(), "x-supabase-token": token } }); if (!r.ok) throw new Error(await errorText(r)); return (await r.json()) as SupabaseProjectItem[]; },
  githubRevoke: async (token: string) => { const r = await fetch("/api/auth/github/revoke", { method: "POST", headers: { ...headers(), "x-github-token": token } }); if (!r.ok) throw new Error(await errorText(r)); },
  supabaseRefresh: (refreshToken: string) => post<{ accessToken: string; refreshToken?: string; expiresAt?: number }>("/api/auth/supabase/refresh", { refreshToken }),
  introspectRepo: (repo: string, token?: string) => post<RepoDigest>("/api/github/introspect", { repo, token }),
  prompts: (req: PromptsRequest) => post<PromptsResponse>("/api/prompts", req),
  runStats: (connection: PostgresConnection | undefined, scoreboard: Scoreboard, only?: string[], ads?: AdDataset | null) => post<{ results: Record<string, StatResult>; computedAt: string; eval: ScoreboardEval }>("/api/stats/run", { connection, scoreboard, only, ads }),
  parseAds: (text: string, source?: string, platform?: string) => post<AdDataset>("/api/ads/parse", { text, source, platform }),

  async chat(req: ChatRequest, onEvent: (e: ChatEvent) => void, signal: AbortSignal): Promise<void> {
    const res = await fetch("/api/chat", { method: "POST", headers: headers(), body: JSON.stringify(req), signal });
    if (!res.ok || !res.body) throw new Error(await errorText(res));
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
        if (!data) continue;
        try { onEvent(JSON.parse(data) as ChatEvent); } catch { /* ignore malformed frame */ }
      }
    }
  },
};

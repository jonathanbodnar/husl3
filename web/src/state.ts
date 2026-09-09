import type { AdDataset, Connections, CostEvent, DbSchema, RepoDigest, Scoreboard, ScoreboardEval, SiteDigest, Todo, TranscriptMessage } from "../../shared/types";

export interface AuditSession {
  id: string;
  /** Domain when a site was scanned, otherwise the repository name. */
  label: string;
  createdAt: string;
  updatedAt: string;
  site: SiteDigest | null;
  schema: DbSchema | null;
  repo: RepoDigest | null;
  /** Non-secret half of connections (repo name; whether a database was connected). */
  links: { postgres: boolean; githubRepo?: string };
  todos: Todo[];
  scoreboard?: Scoreboard | null;
  scoreboardEval?: ScoreboardEval | null;
  /** Ad spend the founder uploaded from their platform's export. Not a live connection. */
  ads?: AdDataset | null;
  transcript: TranscriptMessage[];
  costs: CostEvent[];
}

const SESSIONS_KEY = "vd.sessions.v1";
const CURRENT_KEY = "vd.current.v1";
const CODE_KEY = "vd.accessCode";
const secretsKey = (id: string) => `vd.secrets.${id}`;

function safe<T>(fn: () => T, fallback: T): T { try { return fn(); } catch { return fallback; } }

export const store = {
  loadSessions(): AuditSession[] {
    return safe(() => (JSON.parse(localStorage.getItem(SESSIONS_KEY) ?? "[]") as AuditSession[]).map((s) => ({ ...s, label: s.label ?? s.site?.domain ?? s.repo?.repo ?? "audit" })), []);
  },
  /** Returns an error string when the browser refused to persist (quota), so the UI can say so. */
  saveSessions(s: AuditSession[]): string | null {
    const trimmed = s.slice(0, 20);
    try {
      localStorage.setItem(SESSIONS_KEY, JSON.stringify(trimmed));
      return null;
    } catch {
      // Almost always the quota: drop the oldest audits and the bulkiest tool payloads, then retry once.
      try {
        const lean = trimmed.slice(0, 5).map((a) => ({ ...a, transcript: a.transcript.map((m) => (m.role === "tool" ? { ...m, content: m.content.slice(0, 400), ui: m.ui ? { ...m.ui, rows: undefined } : m.ui } : m)) }));
        localStorage.setItem(SESSIONS_KEY, JSON.stringify(lean));
        return "This browser ran out of storage, so older audits and query results were trimmed to keep this one.";
      } catch {
        return "This browser is out of storage, so this audit is not being saved. It stays in this tab only.";
      }
    }
  },
  currentId(): string | null { return safe(() => localStorage.getItem(CURRENT_KEY), null); },
  setCurrentId(id: string | null) { safe(() => (id ? localStorage.setItem(CURRENT_KEY, id) : localStorage.removeItem(CURRENT_KEY)), undefined); },
  accessCode(): string { return safe(() => localStorage.getItem(CODE_KEY) ?? "", ""); },
  setAccessCode(c: string) { safe(() => localStorage.setItem(CODE_KEY, c), undefined); },
  /** Secrets live in sessionStorage (this tab) unless the founder asked to remember them on this device. */
  secrets(id: string): Connections { return safe(() => JSON.parse(sessionStorage.getItem(secretsKey(id)) ?? localStorage.getItem(secretsKey(id)) ?? "{}") as Connections, {}); },
  setSecrets(id: string, c: Connections, remember: boolean) {
    safe(() => {
      const json = JSON.stringify(c);
      sessionStorage.setItem(secretsKey(id), json);
      if (remember) localStorage.setItem(secretsKey(id), json); else localStorage.removeItem(secretsKey(id));
    }, undefined);
  },
  isRemembered(id: string): boolean { return safe(() => localStorage.getItem(secretsKey(id)) != null, false); },
  clearSecrets(id: string) { safe(() => { sessionStorage.removeItem(secretsKey(id)); localStorage.removeItem(secretsKey(id)); }, undefined); },
};

export function newSession(site: SiteDigest | null, label?: string): AuditSession {
  const now = new Date().toISOString();
  return { id: `a-${Math.random().toString(36).slice(2, 10)}`, label: label ?? site?.domain ?? "audit", createdAt: now, updatedAt: now, site, schema: null, repo: null, links: { postgres: false }, todos: [], transcript: [], costs: [] };
}

export const totalUsd = (costs: CostEvent[]) => costs.reduce((s, c) => s + c.usd, 0);

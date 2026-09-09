import type { Connections, CostEvent, DbSchema, RepoDigest, SiteDigest, Todo, TranscriptMessage } from "../../shared/types";

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
  saveSessions(s: AuditSession[]) { safe(() => localStorage.setItem(SESSIONS_KEY, JSON.stringify(s.slice(0, 20))), undefined); },
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

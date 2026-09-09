import { useCallback, useEffect, useMemo, useState } from "react";
import type { HealthResponse } from "../../shared/types";
import { api, type BrainIndex } from "./api";
import { Landing } from "./components/Landing";
import { Workspace } from "./components/Workspace";
import { newSession, store, type AuditSession } from "./state";

export function App() {
  const [sessions, setSessions] = useState<AuditSession[]>(() => store.loadSessions());
  const [currentId, setCurrentId] = useState<string | null>(() => store.currentId());
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [brainIndex, setBrainIndex] = useState<BrainIndex | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);

  useEffect(() => { store.saveSessions(sessions); }, [sessions]);
  useEffect(() => { store.setCurrentId(currentId); }, [currentId]);
  useEffect(() => {
    api.health().then(setHealth).catch((e) => setHealthError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(() => {
    if (!health) return;
    if (health.accessCodeRequired && !store.accessCode()) return;
    api.brainIndex().then(setBrainIndex).catch(() => {});
  }, [health]);

  const current = useMemo(() => sessions.find((s) => s.id === currentId) ?? null, [sessions, currentId]);

  const update = useCallback((id: string, patch: Partial<AuditSession> | ((s: AuditSession) => AuditSession)) => {
    setSessions((prev) => prev.map((s) => (s.id !== id ? s : typeof patch === "function" ? patch(s) : { ...s, ...patch, updatedAt: new Date().toISOString() })));
  }, []);

  const start = useCallback(async (url: string) => {
    const site = await api.scan(url);
    const s = newSession(site);
    setSessions((prev) => [s, ...prev]);
    setCurrentId(s.id);
  }, []);

  /** Repo-first entry: read the repository, then scan the live site it names, if any. */
  const startFromRepo = useCallback(async (repo: string, token: string | undefined, remember: boolean, login?: string, via: "oauth" | "pat" = "pat") => {
    const digest = await api.introspectRepo(repo, token);
    let site = null as Awaited<ReturnType<typeof api.scan>> | null;
    for (const candidate of digest.siteCandidates.slice(0, 3)) {
      try { site = await api.scan(candidate); break; } catch { /* try the next candidate */ }
    }
    const s = newSession(site, site?.domain ?? digest.repo);
    s.repo = digest;
    s.links = { postgres: false, githubRepo: digest.repo };
    store.setSecrets(s.id, { github: { repo: digest.repo, token, login, via } }, remember);
    setSessions((prev) => [s, ...prev]);
    setCurrentId(s.id);
  }, []);

  const remove = useCallback((id: string) => {
    store.clearSecrets(id);
    setSessions((prev) => prev.filter((s) => s.id !== id));
    setCurrentId((c) => (c === id ? null : c));
  }, []);

  if (!current) {
    return (
      <Landing
        health={health}
        healthError={healthError}
        sessions={sessions}
        onStart={start}
        onStartRepo={startFromRepo}
        onResume={(id) => setCurrentId(id)}
        onDelete={remove}
        onAccessCode={(code) => { store.setAccessCode(code); api.health().then(setHealth).catch(() => {}); api.brainIndex().then(setBrainIndex).catch(() => {}); }}
      />
    );
  }
  return (
    <Workspace
      key={current.id}
      session={current}
      health={health}
      brainIndex={brainIndex}
      onUpdate={(patch) => update(current.id, patch)}
      onExit={() => setCurrentId(null)}
    />
  );
}

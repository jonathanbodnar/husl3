import { useEffect, useMemo, useState } from "react";
import type { Connections, DbSchema, GithubRepoItem, HealthResponse, RepoDigest, SupabaseLink, SupabaseProjectItem } from "../../../shared/types";
import { api } from "../api";
import { consumePendingOAuth, startOAuth } from "../oauth";

type Msg = { ok: boolean; text: string } | null;

export function ConnectDialog(props: {
  health: HealthResponse | null;
  connections: Connections;
  schema: DbSchema | null;
  repo: RepoDigest | null;
  remembered: boolean;
  onClose: () => void;
  onDb: (conn: Connections["postgres"] | null, schema: DbSchema | null, remember: boolean) => void;
  onRepo: (conn: Connections["github"] | null, digest: RepoDigest | null, remember: boolean) => void;
}) {
  const oauth = props.health?.oauth ?? { github: false, supabase: false };
  const [remember, setRemember] = useState(props.remembered);

  // ── Supabase / Postgres ──
  const [sbTokens, setSbTokens] = useState<Omit<SupabaseLink, "projectRef" | "projectName" | "orgName"> | null>(props.connections.postgres?.supabase ? { accessToken: props.connections.postgres.supabase.accessToken, refreshToken: props.connections.postgres.supabase.refreshToken, expiresAt: props.connections.postgres.supabase.expiresAt } : null);
  const [projects, setProjects] = useState<SupabaseProjectItem[] | null>(null);
  const [projectRef, setProjectRef] = useState(props.connections.postgres?.supabase?.projectRef ?? "");
  const [showPg, setShowPg] = useState(!oauth.supabase || !!props.connections.postgres?.connectionString);
  const [conn, setConn] = useState(props.connections.postgres?.connectionString ?? "");
  const [dbBusy, setDbBusy] = useState(false);
  const [dbMsg, setDbMsg] = useState<Msg>(props.schema ? { ok: true, text: describeSchema(props.schema, props.connections.postgres?.supabase?.projectName) } : null);

  // ── GitHub ──
  const [ghToken, setGhToken] = useState<{ token: string; login?: string } | null>(props.connections.github?.token ? { token: props.connections.github.token, login: props.connections.github.login } : null);
  const [repos, setRepos] = useState<GithubRepoItem[] | null>(null);
  const [repoFilter, setRepoFilter] = useState("");
  const [repo, setRepo] = useState(props.connections.github?.repo ?? "");
  const [showPat, setShowPat] = useState(!oauth.github || props.connections.github?.via === "pat");
  const [pat, setPat] = useState(props.connections.github?.via === "pat" ? props.connections.github.token ?? "" : "");
  const [ghBusy, setGhBusy] = useState(false);
  const [ghMsg, setGhMsg] = useState<Msg>(props.repo ? { ok: true, text: describeRepo(props.repo) } : null);

  // Popup-blocked fallback: a result may be waiting from a full-page redirect.
  useEffect(() => {
    const sb = consumePendingOAuth("supabase"); if (sb) void afterSupabaseAuth(sb.supabase);
    const gh = consumePendingOAuth("github"); if (gh) void afterGithubAuth(gh.github);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function afterSupabaseAuth(t: { accessToken: string; refreshToken?: string; expiresAt?: number }) {
    setSbTokens(t); setDbBusy(true); setDbMsg(null);
    try { const list = await api.supabaseProjects(t.accessToken); setProjects(list); if (list.length === 1) setProjectRef(list[0].ref); if (!list.length) setDbMsg({ ok: false, text: "No projects visible to this authorization. Pick the right organization when authorizing." }); }
    catch (e) { setDbMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }); } finally { setDbBusy(false); }
  }
  const connectSupabase = async () => {
    setDbBusy(true); setDbMsg(null);
    try { const r = await startOAuth("supabase"); await afterSupabaseAuth(r.supabase); } catch (e) { setDbMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }); setDbBusy(false); }
  };
  const useProject = async () => {
    if (!sbTokens || !projectRef) return;
    const p = projects?.find((x) => x.ref === projectRef);
    const link: SupabaseLink = { ...sbTokens, projectRef, projectName: p?.name, orgName: p?.orgName };
    setDbBusy(true); setDbMsg(null);
    try { const schema = await api.introspectDb({ supabase: link }); setDbMsg({ ok: true, text: describeSchema(schema, p?.name) }); props.onDb({ supabase: link }, schema, remember); }
    catch (e) { setDbMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }); } finally { setDbBusy(false); }
  };
  const connectPg = async () => {
    setDbBusy(true); setDbMsg(null);
    try { const schema = await api.introspectDb({ connectionString: conn.trim() }); setDbMsg({ ok: true, text: describeSchema(schema) }); props.onDb({ connectionString: conn.trim() }, schema, remember); }
    catch (e) { setDbMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }); } finally { setDbBusy(false); }
  };
  const disconnectDb = () => { setSbTokens(null); setProjects(null); setProjectRef(""); setConn(""); setDbMsg(null); props.onDb(null, null, remember); };

  async function afterGithubAuth(g: { token: string; login: string }) {
    setGhToken(g); setGhBusy(true); setGhMsg(null);
    try { const list = await api.githubRepos(g.token); setRepos(list); if (!list.length) setGhMsg({ ok: false, text: "No repositories visible to this authorization." }); }
    catch (e) { setGhMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }); } finally { setGhBusy(false); }
  }
  const connectGithub = async () => {
    setGhBusy(true); setGhMsg(null);
    try { const r = await startOAuth("github"); await afterGithubAuth(r.github); } catch (e) { setGhMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }); setGhBusy(false); }
  };
  const useRepo = async (fullName: string, token: string | undefined, via: "oauth" | "pat", login?: string) => {
    setGhBusy(true); setGhMsg(null);
    try { const digest = await api.introspectRepo(fullName, token); setRepo(digest.repo); setGhMsg({ ok: true, text: describeRepo(digest) }); props.onRepo({ repo: digest.repo, token, via, login }, digest, remember); }
    catch (e) { setGhMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }); } finally { setGhBusy(false); }
  };
  const disconnectGh = () => { setGhToken(null); setRepos(null); setRepo(""); setPat(""); setGhMsg(null); props.onRepo(null, null, remember); };

  const filteredRepos = useMemo(() => {
    const q = repoFilter.trim().toLowerCase();
    return (repos ?? []).filter((r) => !q || r.fullName.toLowerCase().includes(q) || (r.description ?? "").toLowerCase().includes(q)).slice(0, 40);
  }, [repos, repoFilter]);

  const busyLabel = (b: boolean, idle: string) => (b ? <><span className="spin" /> working…</> : idle);

  return (
    <div className="overlay" onClick={props.onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Connect your data">
        <div className="mhead"><h2 style={{ fontSize: "1.1rem" }}>Connect your data</h2><button className="btn ghost sm" onClick={props.onClose}>Close</button></div>
        <div className="mbody">
          {/* ── Database ── */}
          <section>
            <h3>Database</h3>
            <p className="desc">The guide reads your schema and runs read-only queries you can see, so it measures instead of guessing: signups by day, activation, who pays, who came back. Every statement runs read-only with a 20-second limit.</p>
            {oauth.supabase && !showPg && (
              <>
                {!sbTokens ? (
                  <div className="rowb">
                    <button className="btn primary sm" disabled={dbBusy} onClick={connectSupabase}>{busyLabel(dbBusy, "Connect Supabase")}</button>
                    <span className="note">Opens Supabase; you choose the organization. Read-only queries only.</span>
                  </div>
                ) : props.schema && props.connections.postgres?.supabase && !projects ? (
                  <div className="rowb">
                    <span className="ok">Supabase · {props.connections.postgres.supabase.projectName ?? props.connections.postgres.supabase.projectRef}</span>
                    <button className="btn sm" disabled={dbBusy} onClick={() => void afterSupabaseAuth(sbTokens)}>Switch project</button>
                    <button className="btn sm" onClick={disconnectDb}>Disconnect</button>
                  </div>
                ) : (
                  <div className="rowb" style={{ width: "100%" }}>
                    <select className="pick" value={projectRef} onChange={(e) => setProjectRef(e.target.value)} disabled={dbBusy || !projects}>
                      <option value="">{projects ? "Choose a project…" : "Loading projects…"}</option>
                      {(projects ?? []).map((p) => <option key={p.ref} value={p.ref}>{p.name}{p.orgName ? ` · ${p.orgName}` : ""}{p.region ? ` · ${p.region}` : ""}</option>)}
                    </select>
                    <button className="btn primary sm" disabled={dbBusy || !projectRef} onClick={useProject}>{busyLabel(dbBusy, "Use this project")}</button>
                    <button className="btn ghost sm" onClick={disconnectDb}>Cancel</button>
                  </div>
                )}
              </>
            )}
            {showPg && (
              <>
                <label htmlFor="conn">Postgres connection string</label>
                <input id="conn" type="password" placeholder="postgresql://postgres.xxxx:password@aws-0-us-east-1.pooler.supabase.com:5432/postgres" value={conn} onChange={(e) => setConn(e.target.value)} autoComplete="off" />
                <div className="rowb">
                  <button className="btn primary sm" disabled={dbBusy || !conn.trim()} onClick={connectPg}>{busyLabel(dbBusy, props.connections.postgres?.connectionString ? "Reconnect" : "Connect")}</button>
                  {props.connections.postgres?.connectionString && <button className="btn sm" onClick={disconnectDb}>Disconnect</button>}
                </div>
              </>
            )}
            {dbMsg && <div className={dbMsg.ok ? "ok" : "bad"}>{dbMsg.text}</div>}
            {oauth.supabase && (
              <button type="button" className="alt small" onClick={() => setShowPg((v) => !v)}>{showPg ? "Use Supabase sign-in instead" : "Use a Postgres connection string instead (any Postgres)"}</button>
            )}
            {!oauth.supabase && <div className="note">Supabase sign-in is not configured on this server yet; a connection string works meanwhile.</div>}
          </section>

          {/* ── Repository ── */}
          <section>
            <h3>Repository</h3>
            <p className="desc">The guide reads your recent commits and the files behind signup, pricing, checkout, limits and tracking. The most useful thing it can tell you is which changes you already shipped the data cannot show yet.</p>
            {oauth.github && !showPat && (
              <>
                {!ghToken ? (
                  <div className="rowb">
                    <button className="btn primary sm" disabled={ghBusy} onClick={connectGithub}>{busyLabel(ghBusy, "Connect GitHub")}</button>
                    <span className="note">Opens GitHub. Read access to your repositories, including private ones.</span>
                  </div>
                ) : props.repo && props.connections.github && !repos ? (
                  <div className="rowb">
                    <span className="ok">GitHub{ghToken.login ? ` · ${ghToken.login}` : ""} · {props.connections.github.repo}</span>
                    <button className="btn sm" disabled={ghBusy} onClick={() => void afterGithubAuth({ token: ghToken.token, login: ghToken.login ?? "" })}>Switch repository</button>
                    <button className="btn sm" onClick={disconnectGh}>Disconnect</button>
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: ".5rem" }}>
                    <input type="text" placeholder={repos ? `Filter ${repos.length} repositories…` : "Loading repositories…"} value={repoFilter} onChange={(e) => setRepoFilter(e.target.value)} disabled={!repos} autoComplete="off" />
                    <div className="repolist">
                      {filteredRepos.map((r) => (
                        <button key={r.fullName} type="button" className={`repoitem${repo === r.fullName ? " sel" : ""}`} disabled={ghBusy} onClick={() => void useRepo(r.fullName, ghToken.token, "oauth", ghToken.login)}>
                          <span className="name">{r.fullName}{r.private ? <span className="chip" style={{ marginLeft: ".4rem" }}>private</span> : null}</span>
                          <span className="meta">{[r.language, r.pushedAt ? `pushed ${r.pushedAt.slice(0, 10)}` : null].filter(Boolean).join(" · ")}</span>
                        </button>
                      ))}
                      {repos && !filteredRepos.length && <div className="note" style={{ padding: ".5rem" }}>No repository matches.</div>}
                    </div>
                    <div className="rowb"><button className="btn ghost sm" onClick={disconnectGh}>Cancel</button>{ghBusy && <span className="note"><span className="spin" /> reading…</span>}</div>
                  </div>
                )}
              </>
            )}
            {showPat && (
              <>
                <label htmlFor="repo">Repository</label>
                <input id="repo" type="text" placeholder="owner/name or https://github.com/owner/name" value={repo} onChange={(e) => setRepo(e.target.value)} autoComplete="off" />
                <label htmlFor="token">Personal access token (private repositories; fine-grained, read-only Contents + Metadata)</label>
                <input id="token" type="password" placeholder="github_pat_…" value={pat} onChange={(e) => setPat(e.target.value)} autoComplete="off" />
                <div className="rowb">
                  <button className="btn primary sm" disabled={ghBusy || !repo.trim()} onClick={() => void useRepo(repo.trim(), pat.trim() || undefined, "pat")}>{busyLabel(ghBusy, props.repo ? "Reconnect" : "Connect")}</button>
                  {props.repo && <button className="btn sm" onClick={disconnectGh}>Disconnect</button>}
                </div>
              </>
            )}
            {ghMsg && <div className={ghMsg.ok ? "ok" : "bad"}>{ghMsg.text}</div>}
            {oauth.github && (
              <button type="button" className="alt small" onClick={() => setShowPat((v) => !v)}>{showPat ? "Use GitHub sign-in instead" : "Use a personal access token instead"}</button>
            )}
            {!oauth.github && <div className="note">GitHub sign-in is not configured on this server yet; a token works meanwhile.</div>}
          </section>

          <section>
            <label className="rowb remember" style={{ cursor: "pointer" }}>
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              <span>Remember these connections on this device (otherwise they are forgotten when this tab closes)</span>
            </label>
            <div className="note">Tokens travel from your browser to this server only inside the requests they are needed for and are never written to disk or logs there. There is no account and no server-side storage.</div>
          </section>
        </div>
      </div>
    </div>
  );
}

function describeSchema(s: DbSchema, projectName?: string): string {
  return `Connected${projectName ? ` to ${projectName}` : ""}: ${s.tables.length} tables${s.authUsers != null ? `, ${s.authUsers.toLocaleString()} accounts in auth.users` : ""}`;
}
function describeRepo(r: RepoDigest): string {
  return `Connected: ${r.repo} · ${r.fileCount.toLocaleString()} files · ${r.recentCommits.length} recent commits${r.stack.length ? ` · ${r.stack.slice(0, 5).join(", ")}` : ""}`;
}

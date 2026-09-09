import { useEffect, useState } from "react";
import type { GithubRepoItem, HealthResponse } from "../../../shared/types";
import { api } from "../api";
import { consumePendingOAuth, startOAuth } from "../oauth";
import { store, totalUsd, type AuditSession } from "../state";

const PHASES = ["Reading the home page…", "Looking for pricing and signup…", "Reading the calls to action…", "Noting the stack…", "Almost there…"];
const REPO_PHASES = ["Reading the repository…", "Listing recent commits…", "Looking for a live URL in the README…", "Scanning the site it names…", "Almost there…"];

export function Landing(props: {
  health: HealthResponse | null;
  healthError: string | null;
  storageWarning?: string | null;
  sessions: AuditSession[];
  onStart: (url: string) => Promise<void>;
  onStartRepo: (repo: string, token: string | undefined, remember: boolean, login?: string, via?: "oauth" | "pat") => Promise<void>;
  onResume: (id: string) => void;
  onDelete: (id: string) => void;
  onAccessCode: (code: string) => void;
}) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [mode, setMode] = useState<"site" | "repo">("site");
  const [repo, setRepo] = useState("");
  const [token, setToken] = useState("");
  const [remember, setRemember] = useState(false);
  const [gh, setGh] = useState<{ token: string; login: string } | null>(null);
  const [repos, setRepos] = useState<GithubRepoItem[] | null>(null);
  const [filter, setFilter] = useState("");
  const [usePat, setUsePat] = useState(false);
  const oauthGithub = !!props.health?.oauth.github;
  useEffect(() => {
    const pending = consumePendingOAuth("github");
    if (pending) { setMode("repo"); void afterAuth(pending.github); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  async function afterAuth(g: { token: string; login: string }) {
    setGh(g); setBusy(false); setError(null);
    try { setRepos(await api.githubRepos(g.token)); } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }
  const connectGithub = async () => {
    setError(null);
    try { const r = await startOAuth("github"); await afterAuth(r.github); } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };
  const pickRepo = async (fullName: string) => {
    if (!gh || busy) return;
    setBusy(true); setError(null);
    try { await props.onStartRepo(fullName, gh.token, remember, gh.login, "oauth"); } catch (err) { setError(err instanceof Error ? err.message : String(err)); } finally { setBusy(false); }
  };
  const visibleRepos = (repos ?? []).filter((r) => !filter.trim() || r.fullName.toLowerCase().includes(filter.trim().toLowerCase())).slice(0, 30);
  const typedRepo = /^[\w.-]+\/[\w.-]+$/.test(filter.trim()) && !(repos ?? []).some((r) => r.fullName.toLowerCase() === filter.trim().toLowerCase()) ? filter.trim() : null;
  const grantUrl = props.health?.oauth.githubClientId ? `https://github.com/settings/connections/applications/${props.health.oauth.githubClientId}` : "https://github.com/settings/applications";
  const resetGithub = async () => {
    const old = gh?.token; setError(null); setRepos(null);
    try { const r = await startOAuth("github", { before: async () => { if (old) await api.githubRevoke(old).catch(() => {}); } }); await afterAuth(r.github); } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };
  const needsCode = !!props.health?.accessCodeRequired && !store.accessCode();

  useEffect(() => {
    if (!busy) return;
    setPhase(0);
    const t = setInterval(() => setPhase((p) => Math.min(PHASES.length - 1, p + 1)), mode === "repo" ? 3000 : 2200);
    return () => clearInterval(t);
  }, [busy, mode]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim() || busy) return;
    setBusy(true); setError(null);
    try { await props.onStart(url.trim()); } catch (err) { setError(err instanceof Error ? err.message : String(err)); } finally { setBusy(false); }
  };

  const submitRepo = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!repo.trim() || busy) return;
    setBusy(true); setError(null);
    try { await props.onStartRepo(repo.trim(), token.trim() || undefined, remember, undefined, "pat"); } catch (err) { setError(err instanceof Error ? err.message : String(err)); } finally { setBusy(false); }
  };

  const notConfigured = props.health && !props.health.chat.configured;

  return (
    <div className="landing">
      <div className="brand"><span className="mark" /> Vibe Distribution</div>
      <main className="hero">
        <h1>Your product is built. <em>Now distribute it.</em></h1>
        <p className="lede">
          A conversational audit of how your SaaS gets users, activates them, charges them and keeps them. Enter your site.
          Connect your database and repository if you want the audit to read what you shipped against what the data says.
          You leave with a list of what to do, each with a prompt your coding agent can run.
        </p>

        {props.healthError && <div className="banner error">The server is not reachable ({props.healthError}).</div>}
        {props.storageWarning && <div className="banner">{props.storageWarning}</div>}
        {notConfigured && <div className="banner">The conversation model is not configured on this server yet (DEEPSEEK_API_KEY). The scan will work; the audit will not start.</div>}

        {needsCode ? (
          <form className="gate ui" onSubmit={(e) => { e.preventDefault(); if (code.trim()) props.onAccessCode(code.trim()); }}>
            <label htmlFor="code" className="muted small">This instance asks for an access code</label>
            <input id="code" type="password" value={code} onChange={(e) => setCode(e.target.value)} placeholder="access code" autoComplete="off" />
            <button className="btn primary sm" type="submit">Continue</button>
          </form>
        ) : busy ? (
          <div className="scanning ui">
            <div><span className="pulse" /> &nbsp;{(mode === "repo" ? REPO_PHASES : PHASES)[phase]}</div>
            <div className="muted small">{mode === "repo" ? "Reading the tree, manifest, README and recent commits. Nothing is stored on the server." : "Reading up to six public pages. Nothing is stored on the server."}</div>
          </div>
        ) : mode === "site" ? (
          <>
            <form className="urlform" onSubmit={submit}>
              <input type="text" inputMode="url" autoFocus placeholder="yourproduct.com" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Your site" />
              <button className="btn primary" type="submit" disabled={!url.trim()}>Start the audit</button>
            </form>
            <button type="button" className="alt" onClick={() => { setMode("repo"); setError(null); }}>No public site yet? Start from a GitHub repository →</button>
          </>
        ) : oauthGithub && !usePat ? (
          <div className="repoform">
            <div className="muted small">The guide reads the tree, manifest, README and recent commits, and scans the live site if the README names one.</div>
            {!gh ? (
              <div className="row">
                <button type="button" className="btn primary" onClick={connectGithub}>Connect GitHub</button>
                <label className="muted small" style={{ display: "flex", gap: ".4rem", alignItems: "center", cursor: "pointer" }}><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> remember on this device</label>
                <span style={{ flex: 1 }} />
                <button type="button" className="alt" onClick={() => setUsePat(true)}>Use a token instead</button>
                <button type="button" className="alt" onClick={() => { setMode("site"); setError(null); }}>Use a site instead</button>
              </div>
            ) : (
              <>
                <div className="row"><span className="ok">Signed in as {gh.login}</span><span style={{ flex: 1 }} /><button type="button" className="alt" onClick={() => { setGh(null); setRepos(null); }}>Sign out</button></div>
                <input type="text" placeholder={repos ? `Filter ${repos.length} repositories…` : "Loading repositories…"} value={filter} onChange={(e) => setFilter(e.target.value)} disabled={!repos} aria-label="Filter repositories" />
                <div className="repolist">
                  {visibleRepos.map((r) => (
                    <button key={r.fullName} type="button" className="repoitem" disabled={busy} onClick={() => void pickRepo(r.fullName)}>
                      <span className="name">{r.fullName}{r.private ? <span className="chip" style={{ marginLeft: ".4rem" }}>private</span> : null}</span>
                      <span className="meta">{[r.language, r.pushedAt ? `pushed ${r.pushedAt.slice(0, 10)}` : null].filter(Boolean).join(" · ")}</span>
                    </button>
                  ))}
                  {repos && !visibleRepos.length && !typedRepo && <div className="note" style={{ padding: ".5rem" }}>No repository matches.</div>}
                  {typedRepo && <button type="button" className="repoitem" disabled={busy} onClick={() => void pickRepo(typedRepo)}><span className="name">Use {typedRepo}</span><span className="meta">typed name</span></button>}
                </div>
                <div className="muted small">Missing an organization's repositories? <a href={grantUrl} target="_blank" rel="noreferrer">Grant access on GitHub</a> or <button type="button" className="alt" onClick={() => void resetGithub()}>choose organizations again</button>. You can also type owner/name above.</div>
              </>
            )}
          </div>
        ) : (
          <form className="repoform" onSubmit={submitRepo}>
            {!oauthGithub && <div className="row"><button type="button" className="btn primary" disabled title="Not configured on this server: set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET">Connect GitHub</button><span className="muted small">Sign-in is not configured on this server yet; a repository name (and a token for private ones) works meanwhile.</span></div>}
            <label htmlFor="repo-entry" className="muted small">Repository (owner/name or GitHub URL). The guide reads the tree, manifest, README and recent commits, and scans the live site if the README names one.</label>
            <input id="repo-entry" type="text" autoFocus placeholder="owner/name" value={repo} onChange={(e) => setRepo(e.target.value)} aria-label="Your repository" />
            <input type="password" placeholder="github_pat_… (only for private repositories; read-only Contents + Metadata)" value={token} onChange={(e) => setToken(e.target.value)} aria-label="GitHub token" autoComplete="off" />
            <div className="row">
              <button className="btn primary" type="submit" disabled={!repo.trim()}>Read the repository</button>
              <label className="muted small" style={{ display: "flex", gap: ".4rem", alignItems: "center", cursor: "pointer" }}><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> remember the token on this device</label>
              <span style={{ flex: 1 }} />
              {oauthGithub && <button type="button" className="alt" onClick={() => setUsePat(false)}>Sign in with GitHub instead</button>}
              <button type="button" className="alt" onClick={() => { setMode("site"); setError(null); }}>Use a site instead</button>
            </div>
          </form>
        )}
        {error && (
          <div className="banner error">
            {error}
            {mode === "site" && /resolve|spelling/i.test(error) && <div style={{ marginTop: ".4rem" }}><button type="button" className="alt" onClick={() => { setMode("repo"); setError(null); }}>Start from a repository instead →</button></div>}
          </div>
        )}

        <div className="facts ui">
          <div className="fact"><b>97 days</b><span>of one AI SaaS running the method, audited 209 times</span></div>
          <div className="fact"><b>31 effects</b><span>measured, each with a confidence label</span></div>
          <div className="fact"><b>45 laws</b><span>and 22 measurement traps, learned the hard way</span></div>
          <div className="fact"><b>No account</b><span>your keys stay in this browser; the server keeps nothing</span></div>
        </div>
      </main>

      {props.sessions.length > 0 && (
        <section className="recent">
          <h3>Recent audits</h3>
          {props.sessions.map((s) => (
            <div className="row" key={s.id}>
              <button className="link" onClick={() => props.onResume(s.id)}>{s.label}</button>
              <span className="muted small">{s.todos.filter((t) => t.status !== "dismissed").length} to-dos · {new Date(s.updatedAt).toLocaleDateString()} · ${totalUsd(s.costs).toFixed(2)}</span>
              <button className="btn ghost sm danger" onClick={() => { if (confirm(`Delete the audit of ${s.label} from this browser?`)) props.onDelete(s.id); }}>Delete</button>
            </div>
          ))}
        </section>
      )}
      <footer className="footer">
        <span>Built from the Vibe Distribution brain{props.health ? ` v${props.health.brainVersion}` : ""}</span>
        <span>·</span>
        <a href="https://github.com/jonathanbodnar/husl3" target="_blank" rel="noreferrer">Source</a>
      </footer>
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import type { AdDataset, Connections, DbSchema, GithubRepoItem, HealthResponse, OAuthRelay, RepoDigest, SupabaseLink, SupabaseProjectItem } from "../../../shared/types";
import { api } from "../api";
import { consumePendingOAuth, startOAuth } from "../oauth";

type Msg = { ok: boolean; text: string } | null;

export function ConnectDialog(props: {
  health: HealthResponse | null;
  connections: Connections;
  schema: DbSchema | null;
  repo: RepoDigest | null;
  remembered: boolean;
  ads: AdDataset | null;
  onAds: (ads: AdDataset | null) => void;
  /** A sign-in already started by the click that opened this dialog (keeps the popup inside the user gesture). */
  pending?: { provider: "github" | "supabase"; promise: Promise<OAuthRelay> } | null;
  onClose: () => void;
  onRemember: (remember: boolean) => void;
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

  // ── Ad spend (an export the founder downloads; no ad account is connected) ──
  const [adBusy, setAdBusy] = useState(false);
  const [adMsg, setAdMsg] = useState<Msg>(props.ads?.rows.length ? { ok: true, text: describeAds(props.ads) } : null);
  const [pasted, setPasted] = useState("");
  const [adRoute, setAdRoute] = useState<"file" | "meta">("file");
  const [metaToken, setMetaToken] = useState("");
  const [metaHelp, setMetaHelp] = useState(false);
  const [metaAccounts, setMetaAccounts] = useState<{ id: string; accountId: string; name: string; currency?: string; timezone?: string; disabled?: boolean }[] | null>(null);
  const [metaAccount, setMetaAccount] = useState("");
  const isoDaysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toLocaleDateString("en-CA");
  const [since, setSince] = useState(() => isoDaysAgo(30));
  const [until, setUntil] = useState(() => isoDaysAgo(1));
  const ingest = async (text: string, source: string) => {
    setAdBusy(true); setAdMsg(null);
    try { const ds = await api.parseAds(text, source); setAdMsg({ ok: true, text: describeAds(ds) }); props.onAds(ds); }
    catch (e) { setAdMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }); } finally { setAdBusy(false); }
  };
  const loadMetaAccounts = async () => {
    setAdBusy(true); setAdMsg(null);
    try {
      const list = await api.metaAccounts(metaToken.trim());
      setMetaAccounts(list);
      if (list.length === 1) setMetaAccount(list[0].id);
      if (!list.length) setAdMsg({ ok: false, text: "That token works, but it can see no ad accounts. Give its user or system user access to the ad account in Business settings." });
    } catch (e) { setAdMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }); } finally { setAdBusy(false); }
  };
  const importMeta = async () => {
    setAdBusy(true); setAdMsg(null);
    try {
      const ds = await api.metaImport(metaToken.trim(), metaAccount, since, until);
      setAdMsg({ ok: true, text: describeAds(ds) });
      props.onAds(ds);
    } catch (e) { setAdMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }); } finally { setAdBusy(false); }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 5_000_000) { setAdMsg({ ok: false, text: "That file is larger than 5 MB; export a narrower date range." }); return; }
    await ingest(await file.text(), file.name);
  };

  // Popup-blocked fallback: a result may be waiting from a full-page redirect.
  useEffect(() => {
    const sb = consumePendingOAuth("supabase"); if (sb) void afterSupabaseAuth(sb.supabase);
    const gh = consumePendingOAuth("github"); if (gh) void afterGithubAuth(gh.github);
    if (props.pending) {
      const { provider, promise } = props.pending;
      if (provider === "github") { setGhBusy(true); promise.then((r) => (r.ok && r.provider === "github" ? afterGithubAuth(r.github) : Promise.reject(new Error(r.ok ? "unexpected provider" : r.error)))).catch((e) => { setGhMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }); setGhBusy(false); }); }
      else { setDbBusy(true); promise.then((r) => (r.ok && r.provider === "supabase" ? afterSupabaseAuth(r.supabase) : Promise.reject(new Error(r.ok ? "unexpected provider" : r.error)))).catch((e) => { setDbMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }); setDbBusy(false); }); }
    }
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
  /** Revoke the grant, then sign in again so GitHub shows the consent screen (with organization access) once more. */
  const resetGithub = async () => {
    const old = ghToken?.token;
    setGhBusy(true); setGhMsg(null); setRepos(null);
    let revokeFailed: string | null = null;
    try { const r = await startOAuth("github", { before: async () => { if (old) await api.githubRevoke(old).catch((e) => { revokeFailed = e instanceof Error ? e.message : String(e); }); } }); await afterGithubAuth(r.github);
      if (revokeFailed) setGhMsg({ ok: false, text: `Signed in again, but the old authorization could not be revoked (${revokeFailed}), so GitHub may have skipped the organization step. Use the "grant access on GitHub" link.` }); }
    catch (e) { setGhMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }); setGhBusy(false); }
  };
  const reauthSupabase = async () => {
    setDbBusy(true); setDbMsg(null); setProjects(null);
    try { const r = await startOAuth("supabase"); await afterSupabaseAuth(r.supabase); } catch (e) { setDbMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }); setDbBusy(false); }
  };
  const typedRepo = /^[\w.-]+\/[\w.-]+$/.test(repoFilter.trim()) && !(repos ?? []).some((r) => r.fullName.toLowerCase() === repoFilter.trim().toLowerCase()) ? repoFilter.trim() : null;
  const grantUrl = oauth.githubClientId ? `https://github.com/settings/connections/applications/${oauth.githubClientId}` : "https://github.com/settings/applications";

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
                    <button className="btn sm" disabled={dbBusy} onClick={() => void reauthSupabase()} title="Sign in again to pick a different organization">Different organization</button>
                    <button className="btn sm" onClick={disconnectDb}>Disconnect</button>
                  </div>
                ) : (
                  <div className="rowb" style={{ width: "100%" }}>
                    <select className="pick" value={projectRef} onChange={(e) => setProjectRef(e.target.value)} disabled={dbBusy || !projects}>
                      <option value="">{projects ? "Choose a project…" : "Loading projects…"}</option>
                      {(projects ?? []).map((p) => <option key={p.ref} value={p.ref}>{p.name}{p.orgName ? ` · ${p.orgName}` : ""}{p.region ? ` · ${p.region}` : ""}</option>)}
                    </select>
                    <button className="btn primary sm" disabled={dbBusy || !projectRef} onClick={useProject}>{busyLabel(dbBusy, "Use this project")}</button>
                    <button className="btn ghost sm" disabled={dbBusy} onClick={() => void reauthSupabase()} title="Sign in again to pick a different organization">Different organization</button>
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
            {!oauth.supabase && (
              <div className="rowb">
                <button className="btn primary sm" disabled title="Not configured on this server: set SUPABASE_OAUTH_CLIENT_ID and SUPABASE_OAUTH_CLIENT_SECRET">Connect Supabase</button>
                <span className="note">Sign-in is not configured on this server yet (SUPABASE_OAUTH_CLIENT_ID / SECRET). A connection string works meanwhile.</span>
              </div>
            )}
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
                    <button className="btn sm" disabled={ghBusy} onClick={() => void resetGithub()} title="Revoke this authorization and sign in again to choose organizations">Different organization</button>
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
                      {repos && !filteredRepos.length && !typedRepo && <div className="note" style={{ padding: ".5rem" }}>No repository matches.</div>}
                      {typedRepo && <button type="button" className="repoitem" disabled={ghBusy} onClick={() => void useRepo(typedRepo, ghToken.token, "oauth", ghToken.login)}><span className="name">Use {typedRepo}</span><span className="meta">typed name</span></button>}
                    </div>
                    <div className="note">Missing an organization's repositories? Chosen at the consent screen; <a href={grantUrl} target="_blank" rel="noreferrer">grant access on GitHub</a> or <button type="button" className="alt small" disabled={ghBusy} onClick={() => void resetGithub()}>choose organizations again</button>. You can also type owner/name above.</div>
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
            {!oauth.github && (
              <div className="rowb">
                <button className="btn primary sm" disabled title="Not configured on this server: set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET">Connect GitHub</button>
                <span className="note">Sign-in is not configured on this server yet (GITHUB_CLIENT_ID / SECRET). A token works meanwhile.</span>
              </div>
            )}
          </section>

          <section>
            <h3>Ad spend</h3>
            <p className="desc">If you buy traffic, the guide needs what you spent to work out what an activated user and a payer actually cost. There is no ad account to connect and no permission to grant: export a campaign report from your ad platform and drop the file here. Meta and Google both require an approved app for API access, which would put a review between you and your own numbers; your own export does not.</p>
            <div className="adroutes" role="tablist">
              <button role="tab" aria-selected={adRoute === "file"} className={adRoute === "file" ? "on" : ""} onClick={() => { setAdRoute("file"); setAdMsg(null); }}>Upload an export</button>
              <button role="tab" aria-selected={adRoute === "meta"} className={adRoute === "meta" ? "on" : ""} onClick={() => { setAdRoute("meta"); setAdMsg(null); }}>Connect Meta with a token</button>
            </div>

            {adRoute === "file" ? (
              <>
                <details className="howto">
                  <summary>How to export it</summary>
                  <ul>
                    <li><b>Meta (Facebook/Instagram):</b> Ads Manager → Campaigns. Set your date range, open <i>Breakdown</i> and pick <b>By Day</b> under Time, then <i>Columns → Customise columns</i> and tick Amount spent, Impressions, Link clicks and Campaign ID. Export → CSV.</li>
                    <li><b>Google Ads:</b> Campaigns. Set the date range, <i>Segment → Time → Day</i>, add the Campaign ID column, then the download icon → .csv.</li>
                    <li>The <b>campaign ID</b> is worth including: it survives a campaign being renamed, so spend can be matched to the accounts in your database that carry it.</li>
                    <li>Any platform works if the file has a cost column and a campaign or date column. The title and total rows these exports add are handled.</li>
                  </ul>
                </details>
                <div className="rowb">
                  <label className={`btn sm${adBusy ? " disabled" : ""}`} style={{ cursor: adBusy ? "default" : "pointer" }}>
                    {adBusy ? <><span className="spin" /> reading…</> : props.ads?.rows.length ? "Replace file" : "Choose a CSV file"}
                    <input type="file" accept=".csv,.tsv,.txt,text/csv,text/plain,text/tab-separated-values" style={{ display: "none" }} disabled={adBusy} onChange={(e) => { void onFile(e.target.files?.[0]); e.currentTarget.value = ""; }} />
                  </label>
                  {props.ads?.rows.length ? <button className="btn sm" onClick={() => { setAdMsg(null); props.onAds(null); }}>Remove</button> : null}
                </div>
                <details className="howto">
                  <summary>Or paste the rows</summary>
                  <textarea rows={4} placeholder={"Campaign,Day,Cost\nBrand,2026-08-01,123.45"} value={pasted} onChange={(e) => setPasted(e.target.value)} />
                  <div className="rowb"><button className="btn sm" disabled={adBusy || !pasted.trim()} onClick={() => void ingest(pasted, "pasted")}>Use pasted rows</button></div>
                </details>
              </>
            ) : (
              <>
                <p className="desc">Meta will not let a tool like this read your ad account on your behalf without an approved app and a review. It will let <i>you</i> read your own account: make a free app of your own, mint a token against it, and paste the token here. Nothing is reviewed and nothing is stored — the token stays in this browser and travels only with the requests that use it.</p>
                <div className="rowb">
                  <button className="btn sm" aria-expanded={metaHelp} onClick={() => setMetaHelp((v) => !v)}>{metaHelp ? "Hide the steps" : "How do I get a token?"}</button>
                  <span className="note">About five minutes, once.</span>
                </div>
                {metaHelp && (
                  <div className="howtobox">
                    <b>1. Make an app (free, no review)</b>
                    <ol>
                      <li>Go to <a href="https://developers.facebook.com/apps" target="_blank" rel="noreferrer">developers.facebook.com/apps</a> → <i>Create app</i>. Pick the <b>Business</b> type and give it any name; this app is only a key, it is never published.</li>
                      <li>On the app dashboard, add the <b>Marketing API</b> product.</li>
                    </ol>
                    <b>2a. A token that keeps working — system user (recommended)</b>
                    <ol>
                      <li>Open <a href="https://business.facebook.com/settings" target="_blank" rel="noreferrer">Business settings</a> → <i>Users → System users</i> → <b>Add</b>, and give it any name with the Employee role.</li>
                      <li><i>Add assets</i> → assign your <b>ad account</b> (View performance is enough) and the app you just made.</li>
                      <li>Click <b>Generate new token</b>, choose that app, tick <b>ads_read</b>, and pick a token that does not expire.</li>
                      <li>Copy it once — Meta shows it a single time — and paste it below.</li>
                    </ol>
                    <b>2b. A token in one minute — user token (expires in about an hour)</b>
                    <ol>
                      <li>Open the <a href="https://developers.facebook.com/tools/explorer" target="_blank" rel="noreferrer">Graph API Explorer</a>, choose your app in the top right.</li>
                      <li>Add the <b>ads_read</b> permission, click <b>Generate access token</b> and approve.</li>
                      <li>Copy it and paste it below. Good for trying this now; use 2a if you want it to keep working.</li>
                    </ol>
                    <div className="note">Why the extra step: an app serving other people's ad accounts needs Advanced Access to ads_read, which means Business Verification and app review. Reading <i>your own</i> account with <i>your own</i> app needs neither, because you hold a role on both.</div>
                  </div>
                )}
                <label htmlFor="metatoken">Access token</label>
                <input id="metatoken" type="password" placeholder="EAAG…" value={metaToken} onChange={(e) => { setMetaToken(e.target.value); setMetaAccounts(null); }} autoComplete="off" />
                {!metaAccounts ? (
                  <div className="rowb"><button className="btn primary sm" disabled={adBusy || !metaToken.trim()} onClick={() => void loadMetaAccounts()}>{adBusy ? <><span className="spin" /> checking…</> : "Load my ad accounts"}</button></div>
                ) : (
                  <>
                    <label htmlFor="metaacct">Ad account</label>
                    <select id="metaacct" className="pick" value={metaAccount} onChange={(e) => setMetaAccount(e.target.value)}>
                      <option value="">Choose an ad account…</option>
                      {metaAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}{a.currency ? ` · ${a.currency}` : ""}{a.timezone ? ` · ${a.timezone}` : ""}{a.disabled ? " · inactive" : ""}</option>)}
                    </select>
                    <div className="rowb">
                      <label className="note" htmlFor="since">From</label>
                      <input id="since" type="date" value={since} max={until} onChange={(e) => setSince(e.target.value)} />
                      <label className="note" htmlFor="until">to</label>
                      <input id="until" type="date" value={until} min={since} onChange={(e) => setUntil(e.target.value)} />
                    </div>
                    <div className="rowb">
                      <button className="btn primary sm" disabled={adBusy || !metaAccount} onClick={() => void importMeta()}>{adBusy ? <><span className="spin" /> importing…</> : "Import spend"}</button>
                      <button className="btn sm" onClick={() => { setMetaAccounts(null); setMetaAccount(""); }}>Use a different token</button>
                    </div>
                  </>
                )}
              </>
            )}
            {adMsg && <div className={adMsg.ok ? "ok" : "bad"}>{adMsg.text}</div>}
            {props.ads?.notes.length ? <div className="note">{props.ads.notes.join(" ")}</div> : null}
            <div className="note">Spend is kept in this browser with the rest of the audit, and it is a snapshot: an uploaded file is fixed at the day you exported it, and a token import is fixed at the moment you pressed Import. Run it again when you want fresher numbers.</div>
          </section>

          <section>
            <label className="rowb remember" style={{ cursor: "pointer" }}>
              <input type="checkbox" checked={remember} onChange={(e) => { setRemember(e.target.checked); props.onRemember(e.target.checked); }} />
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
function describeAds(a: AdDataset): string {
  const campaigns = new Set(a.rows.map((r) => r.campaign)).size;
  return `Read ${a.rows.length} campaign-day rows: ${a.totalSpend.toLocaleString("en-US", { maximumFractionDigits: 0 })} ${a.currency} across ${campaigns} campaign${campaigns === 1 ? "" : "s"}, ${a.firstDay} to ${a.lastDay} (${a.platforms.join(", ")})`;
}
function describeRepo(r: RepoDigest): string {
  return `Connected: ${r.repo} · ${r.fileCount.toLocaleString()} files · ${r.recentCommits.length} recent commits${r.stack.length ? ` · ${r.stack.slice(0, 5).join(", ")}` : ""}`;
}

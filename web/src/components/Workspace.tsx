import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatRequest, Connections, CostEvent, HealthResponse, OAuthRelay, Todo, TranscriptMessage } from "../../../shared/types";
import { startOAuth } from "../oauth";
import { api, type BrainIndex } from "../api";
import { store, totalUsd, type AuditSession } from "../state";
import { Chat, type LiveSegment } from "./Chat";
import { ScoreboardPanel } from "./Scoreboard";
import { ConnectDialog } from "./ConnectDialog";
import { TodoPanel } from "./TodoPanel";

/**
 * The server round-trips the to-do list it was SENT, so anything the founder changed while the turn
 * was streaming — most expensively a crafted prompt — is absent from the list that comes back.
 * Assigning that list wholesale silently threw the work away. The server stays authoritative for
 * membership, order and the model's own edits; locally-newer fields win.
 */
const localDate = () => { try { return new Date().toLocaleDateString("en-CA"); } catch { return new Date().toISOString().slice(0, 10); } };
const localZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; } catch { return undefined; } };

function mergeTodos(fromServer: Todo[], local: Todo[]): Todo[] {
  const byId = new Map(local.map((t) => [t.id, t]));
  return fromServer.map((st) => {
    const ct = byId.get(st.id);
    if (!ct) return st;
    const localNewer = Date.parse(ct.updatedAt || "") > Date.parse(st.updatedAt || "");
    return {
      ...st,
      prompt: ct.prompt ?? st.prompt,
      promptModel: ct.promptModel ?? st.promptModel,
      promptStale: ct.prompt && !st.prompt ? ct.promptStale : st.promptStale,
      status: localNewer ? ct.status : st.status,
      title: localNewer && ct.title !== st.title ? ct.title : st.title,
      updatedAt: localNewer ? ct.updatedAt : st.updatedAt,
    };
  });
}

export function Workspace(props: {
  session: AuditSession;
  health: HealthResponse | null;
  brainIndex: BrainIndex | null;
  onUpdate: (patch: Partial<AuditSession> | ((s: AuditSession) => AuditSession)) => void;
  onExit: () => void;
  /** Every audit in this browser, newest first, for the switcher. */
  projects: { id: string; label: string; updatedAt: string; hasDb: boolean; hasRepo: boolean; todos: number }[];
  onSwitch: (id: string) => void;
  onNewProject: () => void;
  storageWarning?: string | null;
}) {
  const { session: s } = props;
  const [secrets, setSecrets] = useState<Connections>(() => store.secrets(s.id));
  /**
   * React state updates are async, and the auto-sent "I connected …" message runs from the closure
   * captured before that update — so it would ship the OLD connections and the model would get no
   * tools for what was just connected. Every write goes through applySecrets, which updates this ref
   * synchronously; send() reads the ref, never the state.
   */
  const secretsRef = useRef(secrets);
  const applySecrets = useCallback((next: Connections, remember: boolean) => {
    secretsRef.current = next;
    setSecrets(next);
    store.setSecrets(latest.current.id, next, remember);
  }, []);
  const [live, setLive] = useState<LiveSegment[] | null>(null);
  const [pendingUser, setPendingUser] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectOpen, setConnectOpen] = useState(() => !!(sessionStorage.getItem("vd.oauth.github") || sessionStorage.getItem("vd.oauth.supabase")));
  const [crafting, setCrafting] = useState(false);
  const [showPanel, setShowPanel] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [tab, setTab] = useState<"todo" | "scoreboard">("todo");
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [connectDismissed, setConnectDismissed] = useState(false);
  const [pendingOAuth, setPendingOAuth] = useState<{ provider: "github" | "supabase"; promise: Promise<OAuthRelay> } | null>(null);
  /** Opens the dialog; when the provider's sign-in is configured and not yet connected, starts it in this click (popup blockers need the gesture). */
  const openConnect = (provider?: "github" | "supabase") => {
    const oauth = props.health?.oauth;
    const connected = provider === "github" ? !!secrets.github : provider === "supabase" ? !!secrets.postgres : true;
    if (provider && oauth?.[provider] && !connected) setPendingOAuth({ provider, promise: startOAuth(provider) as Promise<OAuthRelay> });
    else setPendingOAuth(null);
    setConnectOpen(true);
  };
  const abortRef = useRef<AbortController | null>(null);
  /** A connect message that fired while a turn was streaming; sent as soon as the turn ends. */
  const queuedRef = useRef<string | null>(null);
  const started = useRef(false);
  const latest = useRef(s);
  latest.current = s;

  const say = useCallback((m: string) => { setToast(m); setTimeout(() => setToast(null), 2200); }, []);
  // health===null means the check has not answered yet, which is not the same as "not configured".
  const chatConfigured = props.health ? props.health.chat.configured : true;
  const promptsConfigured = !!props.health?.prompts.configured;

  /** Supabase Management API tokens expire; refresh shortly before, so a long audit never dies mid-query. */
  const freshSecrets = useCallback(async (): Promise<Connections> => {
    const cur = secretsRef.current;
    const sb = cur.postgres?.supabase;
    if (sb?.refreshToken && sb.expiresAt && sb.expiresAt - Date.now() < 5 * 60_000) {
      try {
        const t = await api.supabaseRefresh(sb.refreshToken);
        const next: Connections = { ...cur, postgres: { supabase: { ...sb, ...t } } };
        applySecrets(next, store.isRemembered(latest.current.id));
        return next;
      } catch { /* fall through with the old token; the server reports expiry clearly */ }
    }
    return cur;
  }, [applySecrets]);

  const send = useCallback(async (text: string, kickoff = false) => {
    if (streaming) { if (!kickoff) queuedRef.current = text; return; }
    const cur = latest.current;
    const creds = await freshSecrets();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setStreaming(true); setError(null); setLive([]);
    if (!kickoff) setPendingUser(text);
    const req: ChatRequest = {
      site: cur.site,
      connections: { postgres: creds.postgres, github: creds.github },
      schema: cur.schema,
      repo: cur.repo,
      todos: cur.todos,
      scoreboard: cur.scoreboard ?? null,
      ads: cur.ads ?? null,
      transcript: cur.transcript,
      message: text,
      kickoff,
      clientTime: new Date().toISOString(),
      clientDate: localDate(),
      clientTimezone: localZone(),
    };
    const costs: CostEvent[] = [];
    let settled = false;
    let streamedText = "";
    try {
      await api.chat(req, (e) => {
        switch (e.type) {
          case "delta":
            streamedText += e.text;
            setLive((prev) => {
              const arr = prev ? [...prev] : [];
              const last = arr[arr.length - 1];
              if (last && last.kind === "text") arr[arr.length - 1] = { kind: "text", text: last.text + e.text };
              else arr.push({ kind: "text", text: e.text });
              return arr;
            });
            break;
          case "tool_start":
            setLive((prev) => [...(prev ?? []), { kind: "tool", id: e.id, name: e.name, args: e.args }]);
            break;
          case "tool_result":
            setLive((prev) => (prev ?? []).map((seg) => (seg.kind === "tool" && seg.id === e.id ? { ...seg, ui: e.ui } : seg)));
            break;
          case "todos":
            props.onUpdate((prev) => ({ ...prev, todos: mergeTodos(e.todos, prev.todos) }));
            break;
          case "scoreboard": {
            const wasEmpty = !latest.current.scoreboard?.stats.length;
            props.onUpdate({ scoreboard: e.scoreboard, scoreboardEval: e.eval });
            // Switch tabs only when the board first appears; later rebuilds must not yank the founder off a to-do edit.
            if (e.scoreboard.stats.length && wasEmpty) setTab("scoreboard");
            break;
          }
          case "usage":
            costs.push(e.cost);
            break;
          case "error":
            setError(e.message);
            break;
          case "done":
            settled = true;
            props.onUpdate((prev) => ({ ...prev, transcript: [...prev.transcript, ...e.messages], todos: mergeTodos(e.todos, prev.todos), scoreboard: e.scoreboard ?? prev.scoreboard, costs: [...prev.costs, ...costs], updatedAt: new Date().toISOString() }));
            break;
        }
      }, ctrl.signal);
    } catch (err) {
      if (!ctrl.signal.aborted) setError(err instanceof Error ? err.message : String(err));
    } finally {
      // A stopped or failed turn was still asked and still billed: keep the question and whatever was
      // answered, so the transcript matches what the founder saw and the cost has something to sit next to.
      if (!settled) {
        const salvage: TranscriptMessage[] = [];
        if (!kickoff) salvage.push({ role: "user", content: text, at: new Date().toISOString() });
        if (streamedText.trim()) salvage.push({ role: "assistant", content: streamedText, at: new Date().toISOString() });
        if (salvage.length || costs.length) {
          props.onUpdate((prev) => ({ ...prev, transcript: [...prev.transcript, ...salvage], costs: [...prev.costs, ...costs], updatedAt: new Date().toISOString() }));
        }
      }
      setStreaming(false); setLive(null); setPendingUser(null); abortRef.current = null;
      const queued = queuedRef.current;
      if (queued) { queuedRef.current = null; setTimeout(() => void send(queued), 30); }
    }
  }, [props, streaming, freshSecrets]);

  // Opening turn, once, after the scan.
  useEffect(() => {
    if (started.current || s.transcript.length || !props.health) return;
    if (!chatConfigured) return;
    started.current = true;
    void send("", true);
  }, [s.transcript.length, props.health, chatConfigured, send]);

  const stop = () => abortRef.current?.abort();
  /** Leaving this audit stops its turn: the answer would land in a session nobody is looking at, and it bills. */
  const leaveTo = useCallback((go: () => void) => { abortRef.current?.abort(); setProjectsOpen(false); go(); }, []);

  const craft = useCallback(async (ids?: string[]) => {
    const cur = latest.current;
    setCrafting(true);
    try {
      const res = await api.prompts({ site: cur.site, schema: cur.schema, repo: cur.repo, todos: cur.todos, scoreboard: cur.scoreboard ?? null, ads: cur.ads ?? null, transcript: cur.transcript, todoIds: ids });
      const byId = new Map(res.prompts.map((p) => [p.todoId, p.prompt]));
      props.onUpdate((prev) => ({
        ...prev,
        todos: prev.todos.map((t) => (byId.has(t.id) ? { ...t, prompt: byId.get(t.id)!, promptStale: false, promptModel: res.model, updatedAt: new Date().toISOString() } : t)),
        costs: [...prev.costs, res.cost],
        updatedAt: new Date().toISOString(),
      }));
      say(`${res.prompts.length} prompt${res.prompts.length === 1 ? "" : "s"} written · $${res.cost.usd.toFixed(3)}${res.skipped?.length ? ` · ${res.skipped.length} left for the next call` : ""}`);
    } catch (e) { say(e instanceof Error ? e.message : String(e)); } finally { setCrafting(false); }
  }, [props, say]);

  const refreshScoreboard = useCallback(async () => {
    const cur = latest.current;
    if (!cur.scoreboard?.stats.length) return;
    setRefreshing(true);
    try {
      const creds = await freshSecrets();
      const r = await api.runStats(creds.postgres, cur.scoreboard, undefined, cur.ads ?? null);
      props.onUpdate((prev) => {
        if (!prev.scoreboard) return prev;
        // Merge by id onto whatever specs exist now: a stat added meanwhile keeps its result, a removed one gains none.
        const results = { ...prev.scoreboard.results };
        for (const s of prev.scoreboard.stats) if (r.results[s.id]) results[s.id] = r.results[s.id];
        const newest = Object.values(results).reduce((m, x) => (x.computedAt > m ? x.computedAt : m), "");
        return { ...prev, scoreboard: { ...prev.scoreboard, results, computedAt: newest || prev.scoreboard.computedAt }, scoreboardEval: r.eval };
      });
      const failed = Object.values(r.results).filter((x) => !x.ok).length;
      say(failed ? `Scoreboard refreshed; ${failed} stat${failed === 1 ? "" : "s"} failed` : "Scoreboard refreshed");
    } catch (e) { say(e instanceof Error ? e.message : String(e)); } finally { setRefreshing(false); }
  }, [props, say, freshSecrets]);

  const onDb = (conn: Connections["postgres"] | null, schema: AuditSession["schema"], remember: boolean) => {
    const next: Connections = { ...secretsRef.current, postgres: conn ?? undefined };
    applySecrets(next, remember);
    props.onUpdate({ schema, links: { ...s.links, postgres: !!conn } });
    if (conn && schema) setTimeout(() => void send(`I connected my database (${schema.tables.length} tables${schema.authUsers != null ? `, ${schema.authUsers.toLocaleString()} accounts` : ""}). Build my scoreboard first: name the money event and activation for this product, bind the brain's recipes to my tables, run them, and place me by the numbers. Then re-read the current to-dos against what the data says.`), 50);
  };
  const onAds = (ads: AuditSession["ads"]) => {
    props.onUpdate({ ads });
    if (ads?.rows.length) setTimeout(() => void send(`I uploaded my ad spend (${ads.platforms.join(" + ")}, ${ads.firstDay} to ${ads.lastDay}, ${ads.totalSpend} ${ads.currency}). Read it, then tell me what it costs to get an activated user and a payer, and whether my own data can attribute any of this spend to accounts.`), 50);
  };

  const onRepo = (conn: Connections["github"] | null, digest: AuditSession["repo"], remember: boolean) => {
    const next: Connections = { ...secretsRef.current, github: conn ?? undefined };
    applySecrets(next, remember);
    // A repo-first audit has no site digest; keeping the repository digest is what stops the next
    // request from being rejected as malformed when the founder only means to drop the credential.
    props.onUpdate({ repo: digest ?? (s.site ? null : s.repo), links: { ...s.links, githubRepo: conn?.repo } });
    const repo = conn?.repo;
    if (repo && digest) setTimeout(() => void send(`I connected my repository (${repo}). Read the code behind signup, the core action, the limit or paywall, checkout and tracking; rebuild the funnel from the real steps and event names${latest.current.scoreboard?.stats.length ? " and update the scoreboard" : ""}; then tell me what shipped recently that the data cannot show yet, and what to instrument.`), 50);
  };

  const exportMd = () => {
    const md = exportMarkdown(s, props.brainIndex);
    const blob = new Blob([md], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = `vibe-distribution-${s.label.replace(/[^a-z0-9.-]+/gi, "-")}.md`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const hasReply = s.transcript.some((m) => m.role === "assistant" && !!m.content);
  const missing = [!secrets.github && "repository", !secrets.postgres && "database"].filter(Boolean) as string[];
  const connectNotice = hasReply && missing.length > 0 && !connectDismissed ? (
    <div className="connectcard" role="note">
      <div>
        <b>{missing.length === 2 ? "Your placement is provisional." : `Connect your ${missing[0]} too.`}</b>{" "}
        {missing.length === 2
          ? "Connect your repository and your database so the guide reads what you shipped and what users actually did, instead of guessing from the public site."
          : missing[0] === "database"
            ? "With read-only access the guide measures signups, activation and who pays, instead of asking you to estimate."
            : "With the repository the guide reads the code behind signup, pricing and tracking, and spots what shipped that the data cannot show yet."}
      </div>
      <div className="row">
        <button className="btn primary sm" onClick={() => openConnect(missing.length === 1 ? (missing[0] === "database" ? "supabase" : "github") : undefined)}>Connect</button>
        <button className="btn ghost sm" onClick={() => setConnectDismissed(true)}>Not now</button>
      </div>
    </div>
  ) : null;

  const usd = totalUsd(s.costs);
  const tokens = s.costs.reduce((n, c) => n + c.usage.promptHit + c.usage.promptMiss + c.usage.completion, 0);
  const hit = s.costs.reduce((n, c) => n + c.usage.promptHit, 0);

  return (
    <div className="ws">
      <header className="topbar">
        <button className="btn ghost sm brand" onClick={() => leaveTo(props.onExit)} title="Back to start"><span className="mark" /> <span className="word">Vibe Distribution</span></button>
        <div className="projects">
          <button
            className="projbtn"
            aria-haspopup="menu"
            aria-expanded={projectsOpen}
            title={`${s.label} — switch project`}
            onClick={() => setProjectsOpen((o) => !o)}
          >
            {s.site ? <img src={`https://www.google.com/s2/favicons?domain=${s.site.domain}&sz=32`} alt="" width={16} height={16} /> : <span aria-hidden>⎇</span>}
            <span className="plabel">{s.label}</span>
            <span className="caret" aria-hidden>▾</span>
          </button>
          <button className="addproj" title="Add another project — a different site, with its own connections" aria-label="Add another project" onClick={() => leaveTo(props.onNewProject)}>+</button>
          {projectsOpen && (
            <>
              <div className="menuscrim" onClick={() => setProjectsOpen(false)} />
              <div className="projmenu" role="menu">
                <div className="mtitle">Projects in this browser</div>
                {props.projects.map((p) => (
                  <button
                    key={p.id}
                    role="menuitem"
                    className={`pitem${p.id === s.id ? " on" : ""}`}
                    onClick={() => (p.id === s.id ? setProjectsOpen(false) : leaveTo(() => props.onSwitch(p.id)))}
                  >
                    <span className="pname">{p.label}</span>
                    <span className="pmeta">
                      {p.hasDb && <span className="chip on"><span className="dot" /> data</span>}
                      {p.hasRepo && <span className="chip on"><span className="dot" /> code</span>}
                      <span className="muted small">{p.todos} to-do{p.todos === 1 ? "" : "s"}</span>
                    </span>
                  </button>
                ))}
                <button role="menuitem" className="pitem newp" onClick={() => leaveTo(props.onNewProject)}>+ New project</button>
                <div className="mnote">Each project keeps its own site, database and repository. Connections are never shared between them.</div>
              </div>
            </>
          )}
        </div>
        <span className="spacer" />
        <div className="conns">
          <span className={`chip clickable ${secrets.postgres ? "on" : s.schema ? "stale" : ""}`} onClick={() => openConnect("supabase")} title={secrets.postgres?.supabase ? `Supabase · ${secrets.postgres.supabase.projectName ?? secrets.postgres.supabase.projectRef}` : secrets.postgres ? "Database connected" : s.schema ? "Database schema known; reconnect to run queries" : props.health?.oauth.supabase ? "Sign in with Supabase" : "Connect your database"}><span className="dot" /> {secrets.postgres?.supabase || (!secrets.postgres && props.health?.oauth.supabase) ? "Supabase" : "Database"}</span>
          <span className={`chip clickable ${s.ads?.rows.length ? "on" : ""}`} onClick={() => openConnect()} title={s.ads?.rows.length ? `${s.ads.totalSpend} ${s.ads.currency} uploaded · ${s.ads.firstDay}…${s.ads.lastDay}` : "Upload an ad platform export"}><span className="dot" /> Ads</span>
          <span className={`chip clickable ${secrets.github ? "on" : s.repo ? "stale" : ""}`} onClick={() => openConnect("github")} title={secrets.github ? `Repository ${secrets.github.repo}` : s.repo ? "Repository digest known; reconnect to read files" : props.health?.oauth.github ? "Sign in with GitHub" : "Connect your repository"}><span className="dot" /> GitHub</span>
        </div>
        <span className="cost" title={`${tokens.toLocaleString()} tokens this audit · ${tokens ? Math.round((hit / Math.max(1, tokens)) * 100) : 0}% served from the provider's cache · ${s.costs.length} model calls`}>${usd.toFixed(usd < 0.1 ? 3 : 2)}</span>
        <button className="btn ghost sm" onClick={() => openConnect()}>Connect</button>
        <button className="btn ghost sm export" onClick={exportMd} title="Download the audit as markdown">Export</button>
        <button className="btn ghost sm panel-toggle" onClick={() => setShowPanel((v) => !v)} id="panel-toggle">{showPanel ? "Chat" : `To-dos (${s.todos.filter((t) => t.status !== "dismissed").length})`}</button>
      </header>
      {props.storageWarning && <div className="banner ui" style={{ margin: ".5rem 1rem 0", maxWidth: "none" }}>{props.storageWarning}</div>}
      <div className={`main${showPanel ? " show-panel" : ""}`}>
        <Chat transcript={s.transcript} live={live} pendingUser={pendingUser} streaming={streaming} error={error} disabled={!chatConfigured} notice={connectNotice} onSend={(t) => void send(t)} onStop={stop} />
        <aside className="panel">
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={tab === "todo"} className={tab === "todo" ? "on" : ""} onClick={() => setTab("todo")}>What to do <span className="count">{s.todos.filter((t) => t.status !== "dismissed").length}</span></button>
            <button role="tab" aria-selected={tab === "scoreboard"} className={tab === "scoreboard" ? "on" : ""} onClick={() => setTab("scoreboard")}>Scoreboard {s.scoreboard?.stats.length ? <span className="count">{s.scoreboard.stats.length}</span> : null}</button>
          </div>
          {tab === "todo"
            ? <TodoPanel todos={s.todos} brainIndex={props.brainIndex} crafting={crafting} promptsConfigured={promptsConfigured} onCraft={(ids) => void craft(ids)} onChange={(todos) => props.onUpdate({ todos })} onToast={say} embedded />
            : <div className="plist"><ScoreboardPanel board={s.scoreboard ?? null} evaluation={s.scoreboardEval ?? null} brainIndex={props.brainIndex} dbConnected={!!secrets.postgres} refreshing={refreshing} onRefresh={() => void refreshScoreboard()} /></div>}
        </aside>
      </div>
      {connectOpen && (
        <ConnectDialog health={props.health} ads={s.ads ?? null} onAds={onAds} onRemember={(r) => applySecrets(secretsRef.current, r)} connections={secrets} schema={s.schema} repo={s.repo} remembered={store.isRemembered(s.id)} pending={pendingOAuth} onClose={() => { setConnectOpen(false); setPendingOAuth(null); }} onDb={onDb} onRepo={onRepo} />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function exportMarkdown(s: AuditSession, brainIndex: BrainIndex | null): string {
  const L: string[] = [`# Vibe Distribution audit — ${s.label}`, ``, `_${new Date(s.createdAt).toLocaleString()} · brain ${brainIndex?.version ?? ""} · $${totalUsd(s.costs).toFixed(3)} of model time_`, ``, `## What to do`];
  for (const t of [...s.todos].sort((a, b) => a.order - b.order)) {
    if (t.status === "dismissed") continue;
    const stage = brainIndex?.stages.find((x) => x.id === t.stage)?.name ?? t.stage;
    L.push(``, `### [${t.status}] ${t.title}`, `_${t.stage} · ${stage}${t.principle ? ` · ${t.principle}` : ""}_`, ``, t.why);
    if (t.evidence.length) { L.push(``, `Evidence:`); for (const id of t.evidence) L.push(`- ${brainIndex?.evidence[id] ?? id}`); }
    if (t.prompt) L.push(``, `<details><summary>Coding-agent prompt</summary>`, ``, "```", t.prompt, "```", ``, `</details>`);
  }
  L.push(``, `## Conversation`);
  for (const m of s.transcript) {
    if (m.role === "user" && !m.hidden) L.push(``, `**You:** ${m.content}`);
    else if (m.role === "assistant" && m.content) L.push(``, `**Guide:** ${m.content}`);
    else if (m.role === "tool" && m.ui) L.push(``, `> ${m.ui.name}: ${m.ui.summary}${m.ui.sql ? `\n>\n> \`${m.ui.sql.replace(/\s+/g, " ").slice(0, 300)}\`` : ""}`);
  }
  return L.join("\n");
}

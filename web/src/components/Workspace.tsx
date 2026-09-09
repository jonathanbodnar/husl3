import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatRequest, Connections, CostEvent, HealthResponse, OAuthRelay, Todo } from "../../../shared/types";
import { startOAuth } from "../oauth";
import { api, type BrainIndex } from "../api";
import { store, totalUsd, type AuditSession } from "../state";
import { Chat, type LiveSegment } from "./Chat";
import { ConnectDialog } from "./ConnectDialog";
import { TodoPanel } from "./TodoPanel";

export function Workspace(props: {
  session: AuditSession;
  health: HealthResponse | null;
  brainIndex: BrainIndex | null;
  onUpdate: (patch: Partial<AuditSession> | ((s: AuditSession) => AuditSession)) => void;
  onExit: () => void;
}) {
  const { session: s } = props;
  const [secrets, setSecrets] = useState<Connections>(() => store.secrets(s.id));
  const [live, setLive] = useState<LiveSegment[] | null>(null);
  const [pendingUser, setPendingUser] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectOpen, setConnectOpen] = useState(() => !!(sessionStorage.getItem("vd.oauth.github") || sessionStorage.getItem("vd.oauth.supabase")));
  const [crafting, setCrafting] = useState(false);
  const [showPanel, setShowPanel] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
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
  const started = useRef(false);
  const latest = useRef(s);
  latest.current = s;

  const say = useCallback((m: string) => { setToast(m); setTimeout(() => setToast(null), 2200); }, []);
  const chatConfigured = !!props.health?.chat.configured;
  const promptsConfigured = !!props.health?.prompts.configured;

  /** Supabase Management API tokens expire; refresh shortly before, so a long audit never dies mid-query. */
  const freshSecrets = useCallback(async (): Promise<Connections> => {
    const sb = secrets.postgres?.supabase;
    if (sb?.refreshToken && sb.expiresAt && sb.expiresAt - Date.now() < 5 * 60_000) {
      try {
        const t = await api.supabaseRefresh(sb.refreshToken);
        const next: Connections = { ...secrets, postgres: { supabase: { ...sb, ...t } } };
        setSecrets(next); store.setSecrets(latest.current.id, next, store.isRemembered(latest.current.id));
        return next;
      } catch { /* fall through with the old token; the server reports expiry clearly */ }
    }
    return secrets;
  }, [secrets]);

  const send = useCallback(async (text: string, kickoff = false) => {
    if (streaming) return;
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
      transcript: cur.transcript,
      message: text,
      kickoff,
      clientTime: new Date().toISOString(),
    };
    const costs: CostEvent[] = [];
    try {
      await api.chat(req, (e) => {
        switch (e.type) {
          case "delta":
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
            props.onUpdate({ todos: e.todos });
            break;
          case "usage":
            costs.push(e.cost);
            break;
          case "error":
            setError(e.message);
            break;
          case "done":
            props.onUpdate((prev) => ({ ...prev, transcript: [...prev.transcript, ...e.messages], todos: e.todos, costs: [...prev.costs, ...costs], updatedAt: new Date().toISOString() }));
            break;
        }
      }, ctrl.signal);
    } catch (err) {
      if (!ctrl.signal.aborted) setError(err instanceof Error ? err.message : String(err));
      if (costs.length) props.onUpdate((prev) => ({ ...prev, costs: [...prev.costs, ...costs] }));
    } finally {
      setStreaming(false); setLive(null); setPendingUser(null); abortRef.current = null;
    }
  }, [props, secrets, streaming, freshSecrets]);

  // Opening turn, once, after the scan.
  useEffect(() => {
    if (started.current || s.transcript.length || !props.health) return;
    if (!chatConfigured) return;
    started.current = true;
    void send("", true);
  }, [s.transcript.length, props.health, chatConfigured, send]);

  const stop = () => abortRef.current?.abort();

  const craft = useCallback(async (ids?: string[]) => {
    const cur = latest.current;
    setCrafting(true);
    try {
      const res = await api.prompts({ site: cur.site, schema: cur.schema, repo: cur.repo, todos: cur.todos, transcript: cur.transcript, todoIds: ids });
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

  const onDb = (conn: Connections["postgres"] | null, schema: AuditSession["schema"], remember: boolean) => {
    const next: Connections = { ...secrets, postgres: conn ?? undefined };
    setSecrets(next); store.setSecrets(s.id, next, remember);
    props.onUpdate({ schema, links: { ...s.links, postgres: !!conn } });
    if (conn && schema) setTimeout(() => void send(`I connected my database (${schema.tables.length} tables${schema.authUsers != null ? `, ${schema.authUsers.toLocaleString()} accounts` : ""}). Place me by the numbers and check the current to-dos against the data before asking me anything else.`), 50);
  };
  const onRepo = (conn: Connections["github"] | null, digest: AuditSession["repo"], remember: boolean) => {
    const next: Connections = { ...secrets, github: conn ?? undefined };
    setSecrets(next); store.setSecrets(s.id, next, remember);
    props.onUpdate({ repo: digest, links: { ...s.links, githubRepo: conn?.repo } });
    const repo = conn?.repo;
    if (repo && digest) setTimeout(() => void send(`I connected my repository (${repo}). What shipped recently that the data cannot show yet, and what should I instrument before we go on?`), 50);
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
        <button className="btn ghost sm brand" onClick={props.onExit} title="Back to start"><span className="mark" /> <span className="word">Vibe Distribution</span></button>
        <span className="site">{s.site ? <img src={`https://www.google.com/s2/favicons?domain=${s.site.domain}&sz=32`} alt="" width={16} height={16} /> : <span aria-hidden>⎇</span>} {s.label}</span>
        <span className="spacer" />
        <div className="conns">
          <span className={`chip clickable ${secrets.postgres ? "on" : s.schema ? "stale" : ""}`} onClick={() => openConnect("supabase")} title={secrets.postgres?.supabase ? `Supabase · ${secrets.postgres.supabase.projectName ?? secrets.postgres.supabase.projectRef}` : secrets.postgres ? "Database connected" : s.schema ? "Database schema known; reconnect to run queries" : props.health?.oauth.supabase ? "Sign in with Supabase" : "Connect your database"}><span className="dot" /> {secrets.postgres?.supabase || (!secrets.postgres && props.health?.oauth.supabase) ? "Supabase" : "Database"}</span>
          <span className={`chip clickable ${secrets.github ? "on" : s.repo ? "stale" : ""}`} onClick={() => openConnect("github")} title={secrets.github ? `Repository ${secrets.github.repo}` : s.repo ? "Repository digest known; reconnect to read files" : props.health?.oauth.github ? "Sign in with GitHub" : "Connect your repository"}><span className="dot" /> GitHub</span>
        </div>
        <span className="cost" title={`${tokens.toLocaleString()} tokens this audit · ${tokens ? Math.round((hit / Math.max(1, tokens)) * 100) : 0}% served from the provider's cache · ${s.costs.length} model calls`}>${usd.toFixed(usd < 0.1 ? 3 : 2)}</span>
        <button className="btn ghost sm" onClick={() => openConnect()}>Connect</button>
        <button className="btn ghost sm export" onClick={exportMd} title="Download the audit as markdown">Export</button>
        <button className="btn ghost sm panel-toggle" onClick={() => setShowPanel((v) => !v)} id="panel-toggle">{showPanel ? "Chat" : `To-dos (${s.todos.filter((t) => t.status !== "dismissed").length})`}</button>
      </header>
      <div className={`main${showPanel ? " show-panel" : ""}`}>
        <Chat transcript={s.transcript} live={live} pendingUser={pendingUser} streaming={streaming} error={error} disabled={!chatConfigured} notice={connectNotice} onSend={(t) => void send(t)} onStop={stop} />
        <TodoPanel todos={s.todos} brainIndex={props.brainIndex} crafting={crafting} promptsConfigured={promptsConfigured} onCraft={(ids) => void craft(ids)} onChange={(todos) => props.onUpdate({ todos })} onToast={say} />
      </div>
      {connectOpen && (
        <ConnectDialog health={props.health} connections={secrets} schema={s.schema} repo={s.repo} remembered={store.isRemembered(s.id)} pending={pendingOAuth} onClose={() => { setConnectOpen(false); setPendingOAuth(null); }} onDb={onDb} onRepo={onRepo} />
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

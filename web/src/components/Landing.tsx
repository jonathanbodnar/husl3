import { useEffect, useState } from "react";
import type { HealthResponse } from "../../../shared/types";
import { store, totalUsd, type AuditSession } from "../state";

const PHASES = ["Reading the home page…", "Looking for pricing and signup…", "Reading the calls to action…", "Noting the stack…", "Almost there…"];

export function Landing(props: {
  health: HealthResponse | null;
  healthError: string | null;
  sessions: AuditSession[];
  onStart: (url: string) => Promise<void>;
  onResume: (id: string) => void;
  onDelete: (id: string) => void;
  onAccessCode: (code: string) => void;
}) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const needsCode = !!props.health?.accessCodeRequired && !store.accessCode();

  useEffect(() => {
    if (!busy) return;
    setPhase(0);
    const t = setInterval(() => setPhase((p) => Math.min(PHASES.length - 1, p + 1)), 2200);
    return () => clearInterval(t);
  }, [busy]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim() || busy) return;
    setBusy(true); setError(null);
    try { await props.onStart(url.trim()); } catch (err) { setError(err instanceof Error ? err.message : String(err)); } finally { setBusy(false); }
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
        {notConfigured && <div className="banner">The conversation model is not configured on this server yet (DEEPSEEK_API_KEY). The scan will work; the audit will not start.</div>}

        {needsCode ? (
          <form className="gate ui" onSubmit={(e) => { e.preventDefault(); if (code.trim()) props.onAccessCode(code.trim()); }}>
            <label htmlFor="code" className="muted small">This instance asks for an access code</label>
            <input id="code" type="password" value={code} onChange={(e) => setCode(e.target.value)} placeholder="access code" autoComplete="off" />
            <button className="btn primary sm" type="submit">Continue</button>
          </form>
        ) : busy ? (
          <div className="scanning ui">
            <div><span className="pulse" /> &nbsp;{PHASES[phase]}</div>
            <div className="muted small">Reading up to six public pages. Nothing is stored on the server.</div>
          </div>
        ) : (
          <form className="urlform" onSubmit={submit}>
            <input type="text" inputMode="url" autoFocus placeholder="yourproduct.com" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Your site" />
            <button className="btn primary" type="submit" disabled={!url.trim()}>Start the audit</button>
          </form>
        )}
        {error && <div className="banner error">{error}</div>}

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
              <button className="link" onClick={() => props.onResume(s.id)}>{s.site.domain}</button>
              <span className="muted small">{s.todos.filter((t) => t.status !== "dismissed").length} to-dos · {new Date(s.updatedAt).toLocaleDateString()} · ${totalUsd(s.costs).toFixed(2)}</span>
              <button className="btn ghost sm danger" onClick={() => { if (confirm(`Delete the audit of ${s.site.domain} from this browser?`)) props.onDelete(s.id); }}>Delete</button>
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

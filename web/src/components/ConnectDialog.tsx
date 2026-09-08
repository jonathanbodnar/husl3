import { useState } from "react";
import type { Connections, DbSchema, RepoDigest } from "../../../shared/types";
import { api } from "../api";

export function ConnectDialog(props: {
  connections: Connections;
  schema: DbSchema | null;
  repo: RepoDigest | null;
  remembered: boolean;
  onClose: () => void;
  onDb: (conn: string | null, schema: DbSchema | null, remember: boolean) => void;
  onRepo: (repo: string | null, token: string | undefined, digest: RepoDigest | null, remember: boolean) => void;
}) {
  const [conn, setConn] = useState(props.connections.postgres?.connectionString ?? "");
  const [repo, setRepo] = useState(props.connections.github?.repo ?? "");
  const [token, setToken] = useState(props.connections.github?.token ?? "");
  const [remember, setRemember] = useState(props.remembered);
  const [dbBusy, setDbBusy] = useState(false);
  const [ghBusy, setGhBusy] = useState(false);
  const [dbMsg, setDbMsg] = useState<{ ok: boolean; text: string } | null>(props.schema ? { ok: true, text: `Connected: ${props.schema.tables.length} tables${props.schema.authUsers != null ? `, ${props.schema.authUsers.toLocaleString()} accounts in auth.users` : ""}` } : null);
  const [ghMsg, setGhMsg] = useState<{ ok: boolean; text: string } | null>(props.repo ? { ok: true, text: `Connected: ${props.repo.repo} · ${props.repo.fileCount.toLocaleString()} files · ${props.repo.recentCommits.length} recent commits` } : null);

  const connectDb = async () => {
    setDbBusy(true); setDbMsg(null);
    try {
      const schema = await api.introspectDb(conn.trim());
      setDbMsg({ ok: true, text: `Connected: ${schema.tables.length} tables${schema.authUsers != null ? `, ${schema.authUsers.toLocaleString()} accounts in auth.users` : ""}` });
      props.onDb(conn.trim(), schema, remember);
    } catch (e) { setDbMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }); } finally { setDbBusy(false); }
  };
  const connectGh = async () => {
    setGhBusy(true); setGhMsg(null);
    try {
      const digest = await api.introspectRepo(repo.trim(), token.trim() || undefined);
      setGhMsg({ ok: true, text: `Connected: ${digest.repo} · ${digest.fileCount.toLocaleString()} files · ${digest.recentCommits.length} recent commits${digest.stack.length ? ` · ${digest.stack.slice(0, 5).join(", ")}` : ""}` });
      props.onRepo(digest.repo, token.trim() || undefined, digest, remember);
    } catch (e) { setGhMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }); } finally { setGhBusy(false); }
  };

  return (
    <div className="overlay" onClick={props.onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Connect your data">
        <div className="mhead"><h2 style={{ fontSize: "1.1rem" }}>Connect your data</h2><button className="btn ghost sm" onClick={props.onClose}>Close</button></div>
        <div className="mbody">
          <section>
            <h3>Database (Supabase or any Postgres)</h3>
            <p className="desc">The guide reads your schema and runs read-only queries you can see, so it measures instead of guessing: signups by day, activation, who pays, who came back. Every statement runs inside a read-only transaction with a 20-second limit.</p>
            <label htmlFor="conn">Connection string</label>
            <input id="conn" type="password" placeholder="postgresql://postgres.xxxx:password@aws-0-us-east-1.pooler.supabase.com:5432/postgres" value={conn} onChange={(e) => setConn(e.target.value)} autoComplete="off" />
            <div className="note">Supabase: Project → Connect → Connection string → URI (choose the session pooler if your network is IPv4-only). Use a read-only role if you have one; the app only ever opens read-only transactions either way.</div>
            <div className="rowb">
              <button className="btn primary sm" disabled={dbBusy || !conn.trim()} onClick={connectDb}>{dbBusy ? <><span className="spin" /> connecting…</> : props.schema ? "Reconnect" : "Connect"}</button>
              {props.schema && <button className="btn sm" onClick={() => { setConn(""); setDbMsg(null); props.onDb(null, null, remember); }}>Disconnect</button>}
              {dbMsg && <span className={dbMsg.ok ? "ok" : "bad"}>{dbMsg.text}</span>}
            </div>
          </section>
          <section>
            <h3>Repository (GitHub)</h3>
            <p className="desc">The guide reads your recent commits and the files behind signup, pricing, checkout, limits and tracking. The most useful thing it can tell you is which changes you already shipped the data cannot show yet.</p>
            <label htmlFor="repo">Repository</label>
            <input id="repo" type="text" placeholder="owner/name or https://github.com/owner/name" value={repo} onChange={(e) => setRepo(e.target.value)} autoComplete="off" />
            <label htmlFor="token">Personal access token (needed for private repositories; fine-grained, read-only Contents + Metadata)</label>
            <input id="token" type="password" placeholder="github_pat_…" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
            <div className="rowb">
              <button className="btn primary sm" disabled={ghBusy || !repo.trim()} onClick={connectGh}>{ghBusy ? <><span className="spin" /> reading…</> : props.repo ? "Reconnect" : "Connect"}</button>
              {props.repo && <button className="btn sm" onClick={() => { setRepo(""); setToken(""); setGhMsg(null); props.onRepo(null, undefined, null, remember); }}>Disconnect</button>}
              {ghMsg && <span className={ghMsg.ok ? "ok" : "bad"}>{ghMsg.text}</span>}
            </div>
          </section>
          <section>
            <label className="rowb" style={{ cursor: "pointer" }}>
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              <span>Remember these credentials on this device (otherwise they are forgotten when this tab closes)</span>
            </label>
            <div className="note">Credentials travel from your browser to this server only inside the requests they are needed for and are never written to disk or logs there. There is no account and no server-side storage.</div>
          </section>
        </div>
      </div>
    </div>
  );
}

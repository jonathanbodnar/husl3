import { useState } from "react";
import type { ToolUi } from "../../../shared/types";

const LABELS: Record<string, string> = {
  update_todos: "What-to-do list",
  update_scoreboard: "Scoreboard",
  run_sql: "Query",
  db_describe_table: "Table",
  fetch_page: "Read page",
  github_read_file: "Read file",
  github_search_files: "Find files",
  github_list_commits: "Commits",
};
const ICONS: Record<string, string> = { update_todos: "☑", update_scoreboard: "▦", run_sql: "⌕", db_describe_table: "▤", fetch_page: "⇲", github_read_file: "⌘", github_search_files: "⌕", github_list_commits: "⎇" };

export function ToolCard({ name, ui, pending, args }: { name: string; ui?: ToolUi; pending?: boolean; args?: Record<string, unknown> }) {
  const [open, setOpen] = useState(false);
  const ok = ui ? ui.ok : true;
  const sub = ui ? ui.summary : describeArgs(name, args);
  const hasBody = !!ui && (ui.sql || ui.rows || ui.commits || ui.files || ui.error || ui.url || ui.path);
  return (
    <div className={`tool${ok ? "" : " err"}`}>
      <div className="head" onClick={() => hasBody && setOpen((o) => !o)} role={hasBody ? "button" : undefined}>
        <span className="icon">{pending ? <span className="spin" /> : ok ? ICONS[name] ?? "•" : "!"}</span>
        <span className="title">{LABELS[name] ?? name}</span>
        <span className="sub" title={sub}>{sub}</span>
        {ui?.ms != null && <span className="muted small">{(ui.ms / 1000).toFixed(1)}s</span>}
        {hasBody && <span className="muted small">{open ? "▴" : "▾"}</span>}
      </div>
      {open && ui && (
        <div className="body">
          {ui.error && <div style={{ color: "var(--red)" }}>{ui.error}</div>}
          {ui.sql && <pre className="mono">{ui.sql}</pre>}
          {ui.url && <div><a href={ui.url} target="_blank" rel="noreferrer">{ui.url}</a></div>}
          {ui.path && <div className="mono">{ui.path}</div>}
          {ui.rows && ui.columns && (
            <>
              <div className="muted small">{ui.rowCount} row{ui.rowCount === 1 ? "" : "s"}{ui.truncated ? " (capped at 200)" : ""}</div>
              {ui.rows.length > 0 && (
                <div className="tablewrap">
                  <table>
                    <thead><tr>{ui.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                    <tbody>
                      {ui.rows.map((r, i) => (
                        <tr key={i}>{ui.columns!.map((c) => <td key={c} title={fmt(r[c])}>{fmt(r[c])}</td>)}</tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
          {ui.commits && (
            <div className="tablewrap"><table><tbody>
              {ui.commits.map((c) => <tr key={c.sha}><td className="mono">{c.date.slice(0, 10)}</td><td className="mono">{c.sha}</td><td style={{ whiteSpace: "normal", maxWidth: 520 }}>{c.message}</td></tr>)}
            </tbody></table></div>
          )}
          {ui.files && <pre className="mono">{ui.files.join("\n") || "(none)"}</pre>}
        </div>
      )}
    </div>
  );
}

function fmt(v: unknown): string { return v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v); }

function describeArgs(name: string, args?: Record<string, unknown>): string {
  if (!args) return "…";
  if (name === "run_sql") return String(args.purpose ?? "running…");
  if (name === "fetch_page") return String(args.url ?? "");
  if (name === "github_read_file") return String(args.path ?? "");
  if (name === "github_search_files") return `"${String(args.query ?? "")}"`;
  if (name === "db_describe_table") return String(args.table ?? "");
  if (name === "update_todos") return "updating…";
  return "";
}

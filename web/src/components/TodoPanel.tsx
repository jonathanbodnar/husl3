import { useMemo, useState } from "react";
import type { Todo, TodoStatus } from "../../../shared/types";
import type { BrainIndex } from "../api";

const STAGE_FALLBACK: Record<string, string> = { s0: "Before users", s1: "First users", s2: "Activation", s3: "Monetization", s4: "Retention", s5: "Acquisition", s6: "Scale" };

export function TodoPanel(props: {
  todos: Todo[];
  brainIndex: BrainIndex | null;
  crafting: boolean;
  promptsConfigured: boolean;
  onCraft: (ids?: string[]) => void;
  onChange: (todos: Todo[]) => void;
  onToast: (m: string) => void;
}) {
  const active = props.todos.filter((t) => t.status !== "dismissed");
  const needPrompt = props.todos.filter((t) => (t.status === "todo" || t.status === "doing") && (!t.prompt || t.promptStale));
  const groups = useMemo(() => {
    const byStage = new Map<string, Todo[]>();
    for (const t of [...props.todos].sort((a, b) => a.order - b.order)) { if (!byStage.has(t.stage)) byStage.set(t.stage, []); byStage.get(t.stage)!.push(t); }
    return [...byStage.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [props.todos]);
  const stageName = (id: string) => props.brainIndex?.stages.find((s) => s.id === id)?.name ?? STAGE_FALLBACK[id] ?? id;

  const patch = (id: string, p: Partial<Todo>) => props.onChange(props.todos.map((t) => (t.id === id ? { ...t, ...p, updatedAt: new Date().toISOString() } : t)));

  return (
    <aside className="panel">
      <div className="phead">
        <h2>What to do</h2>
        <span className="count">{active.length}</span>
        <span style={{ flex: 1 }} />
        <button
          className="btn primary sm"
          disabled={props.crafting || !needPrompt.length || !props.promptsConfigured}
          title={!props.promptsConfigured ? "Prompt writer not configured on this server" : needPrompt.length ? "One call writes every missing prompt (≈10–15¢)" : "Every item has a fresh prompt"}
          onClick={() => props.onCraft()}
        >
          {props.crafting ? <><span className="spin" /> writing…</> : needPrompt.length ? `Craft ${needPrompt.length} prompt${needPrompt.length === 1 ? "" : "s"}` : "Prompts ready"}
        </button>
      </div>
      <div className="plist">
        {!props.todos.length && <div className="empty">The guide fills this list as it learns your product. Each item gets a prompt for your coding agent.</div>}
        {groups.map(([stage, items]) => (
          <div className="stagegroup" key={stage}>
            <div className="stagehead" title={stageName(stage)}><span className="sdot" style={{ background: `var(--${stage})` }} /> {stage} · {stageName(stage).split(":")[0]}</div>
            {items.map((t) => (
              <TodoCard key={t.id} todo={t} brainIndex={props.brainIndex} onPatch={(p) => patch(t.id, p)} onCraft={() => props.onCraft([t.id])} crafting={props.crafting} promptsConfigured={props.promptsConfigured} onToast={props.onToast} />
            ))}
          </div>
        ))}
      </div>
    </aside>
  );
}

const NEXT: Record<TodoStatus, TodoStatus> = { todo: "doing", doing: "done", done: "todo", dismissed: "todo" };

function TodoCard(props: { todo: Todo; brainIndex: BrainIndex | null; crafting: boolean; promptsConfigured: boolean; onPatch: (p: Partial<Todo>) => void; onCraft: () => void; onToast: (m: string) => void }) {
  const { todo: t } = props;
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(t.title);
  const ev = (id: string) => props.brainIndex?.evidence[id];
  const conf = (id: string) => { const m = ev(id)?.match(/\[([a-z-]+)\]/); return m ? m[1] : null; };
  const principle = t.principle ? props.brainIndex?.principles.find((p) => p.id === t.principle) : undefined;

  const copy = async () => {
    if (!t.prompt) return;
    try { await navigator.clipboard.writeText(t.prompt); props.onToast("Prompt copied"); } catch { props.onToast("Could not copy; select the text instead"); }
  };

  return (
    <div className={`todo ${t.status}`} style={{ marginBottom: ".55rem" }}>
      <div className="row">
        <button className={`check st-${t.status}`} title={`Status: ${t.status} (click to change)`} onClick={() => props.onPatch({ status: NEXT[t.status] })}>
          {t.status === "done" ? "✓" : t.status === "doing" ? "…" : ""}
        </button>
        {editing ? (
          <input
            className="title"
            style={{ border: "1px solid var(--line-2)", borderRadius: 6, padding: ".1rem .4rem", background: "var(--surface)", width: "100%" }}
            value={title}
            autoFocus
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => { setEditing(false); if (title.trim() && title.trim() !== t.title) props.onPatch({ title: title.trim(), promptStale: !!t.prompt }); }}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") { setTitle(t.title); setEditing(false); } }}
          />
        ) : (
          <div className="title" onDoubleClick={() => setEditing(true)} title="Double-click to edit">{t.title}</div>
        )}
      </div>
      <div className="why">{t.why}</div>
      <div className="meta">
        {principle && <span className="chip" title={principle.title}>{principle.key}</span>}
        {t.evidence.map((id) => (
          <span className="ev" key={id} title={ev(id) ?? id}>{id}{conf(id) ? ` · ${conf(id)}` : ""}</span>
        ))}
        <span className="actions">
          {t.prompt && <button className="btn ghost sm" onClick={() => setOpen((o) => !o)}>{open ? "Hide prompt" : t.promptStale ? "Prompt (stale)" : "Prompt"}</button>}
          {!t.prompt && props.promptsConfigured && <button className="btn ghost sm" disabled={props.crafting} onClick={props.onCraft} title="Write this item's prompt (one model call)">Write prompt</button>}
          {t.status !== "dismissed"
            ? <button className="btn ghost sm" title="Dismiss" onClick={() => props.onPatch({ status: "dismissed" })}>×</button>
            : <button className="btn ghost sm" title="Restore" onClick={() => props.onPatch({ status: "todo" })}>↺</button>}
        </span>
      </div>
      {open && t.prompt && (
        <div className="prompt">
          <div className="ptools">
            <button className="btn sm" onClick={copy}>Copy prompt</button>
            <button className="btn ghost sm" disabled={props.crafting || !props.promptsConfigured} onClick={props.onCraft}>Rewrite</button>
            <span>{t.promptModel ? `written by ${t.promptModel}` : ""}{t.promptStale ? " · item changed since" : ""}</span>
          </div>
          <pre className="mono">{t.prompt}</pre>
        </div>
      )}
    </div>
  );
}

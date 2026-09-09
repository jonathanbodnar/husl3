import { randomBytes } from "node:crypto";
import type { ChatRequest, Scoreboard, ScoreboardEval, StageId, StatKind, StatSpec, StatUnit, Todo, ToolUi } from "../../shared/types.js";
import { evaluateScoreboard } from "../stats/readiness.js";
import { runScoreboard } from "../stats/run.js";
import { brainIndex, stageIds } from "../brain/render.js";
import { hasDatabase, runReadOnlyQuery } from "../db/postgres.js";
import { listCommits, readFile, searchFiles } from "../github/client.js";
import { fetchPageForTool } from "../site/scan.js";

export interface ToolOutcome { content: string; ui: ToolUi; todos?: Todo[]; scoreboard?: Scoreboard; eval?: ScoreboardEval }
export interface ToolContext { req: ChatRequest; todos: Todo[]; scoreboard: Scoreboard }

const MODEL_CONTENT_CAP = 12_000;

export function parseArgs(json: string): Record<string, unknown> {
  try { const v = JSON.parse(json || "{}"); return v && typeof v === "object" ? v : {}; } catch { return { __parse_error: true, raw: json.slice(0, 200) }; }
}

export async function executeTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const t0 = Date.now();
  try {
    if (args.__parse_error) throw new Error("Arguments were not valid JSON; send a single JSON object.");
    switch (name) {
      case "update_todos": return applyTodoOps(args, ctx);
      case "update_scoreboard": return await applyScoreboardOps(args, ctx);
      case "fetch_page": return await fetchPage(args, ctx);
      case "run_sql": return await runSql(args, ctx, t0);
      case "db_describe_table": return describeTable(args, ctx);
      case "github_read_file": return await ghRead(args, ctx);
      case "github_search_files": return await ghSearch(args, ctx);
      case "github_list_commits": return await ghCommits(args, ctx);
      default: throw new Error(`Unknown tool ${name}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: JSON.stringify({ error: message }), ui: { name, ok: false, summary: message, error: message, ms: Date.now() - t0 } };
  }
}

const modelJson = (v: unknown) => { const s = JSON.stringify(v); return s.length > MODEL_CONTENT_CAP ? s.slice(0, MODEL_CONTENT_CAP) + "…(truncated)" : s; };
const newId = () => `td-${randomBytes(4).toString("hex")}`;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function applyTodoOps(args: Record<string, unknown>, ctx: ToolContext): ToolOutcome {
  const ops = Array.isArray(args.ops) ? (args.ops as Record<string, unknown>[]) : [];
  if (!ops.length) throw new Error("ops[] is empty");
  const todos = ctx.todos.map((t) => ({ ...t, evidence: [...t.evidence] }));
  const warnings: string[] = [];
  let added = 0, changed = 0, removed = 0, reordered = false;
  const now = new Date().toISOString();
  const validEvidence = (ids: unknown): string[] => {
    const out: string[] = [];
    for (const id of Array.isArray(ids) ? ids : []) {
      const s = String(id).trim();
      if (brainIndex.has(s)) { if (!out.includes(s)) out.push(s); } else warnings.push(`unknown evidence id dropped: ${s}`);
    }
    return out;
  };
  const validStage = (s: unknown, fallback: StageId): StageId => (typeof s === "string" && stageIds.includes(s) ? (s as StageId) : fallback);
  const validPrinciple = (p: unknown): string | undefined => (typeof p === "string" && brainIndex.get(p)?.kind === "principle" ? p : undefined);

  for (const op of ops) {
    const kind = String(op.op ?? "");
    if (kind === "add") {
      const title = String(op.title ?? "").trim();
      const why = String(op.why ?? "").trim();
      if (!title || !why) { warnings.push("add skipped: title and why are required"); continue; }
      const dup = todos.find((t) => t.status !== "dismissed" && norm(t.title) === norm(title));
      if (dup) { warnings.push(`add merged into existing ${dup.id} (same title)`); dup.why = why || dup.why; dup.updatedAt = now; changed++; continue; }
      if (typeof op.principle === "string" && !validPrinciple(op.principle)) warnings.push(`unknown principle id dropped: ${op.principle}`);
      if (typeof op.stage !== "string" || !stageIds.includes(op.stage)) warnings.push(`stage missing or unknown on "${title.slice(0, 40)}"; defaulted to s1`);
      todos.push({
        id: newId(), title: title.slice(0, 120), why: why.slice(0, 600), stage: validStage(op.stage, "s1"), principle: validPrinciple(op.principle),
        evidence: validEvidence(op.evidence), status: "todo", order: Math.max(0, ...todos.map((t) => t.order)) + 1, createdAt: now, updatedAt: now,
      });
      added++;
    } else if (kind === "update") {
      const t = todos.find((x) => x.id === op.id);
      if (!t) { warnings.push(`update skipped: no item ${String(op.id)}`); continue; }
      let material = false;
      if (typeof op.title === "string" && op.title.trim() && op.title.trim() !== t.title) { t.title = op.title.trim().slice(0, 120); material = true; }
      if (typeof op.why === "string" && op.why.trim() && op.why.trim() !== t.why) { t.why = op.why.trim().slice(0, 600); material = true; }
      if (typeof op.stage === "string" && stageIds.includes(op.stage) && op.stage !== t.stage) { t.stage = op.stage as StageId; material = true; }
      if (typeof op.principle === "string") { const p = validPrinciple(op.principle); if (p) t.principle = p; else warnings.push(`unknown principle id ignored: ${op.principle}`); }
      if (Array.isArray(op.evidence)) { const ev = validEvidence(op.evidence); if (ev.join() !== t.evidence.join()) { t.evidence = ev; material = true; } }
      if (typeof op.status === "string" && ["todo", "doing", "done", "dismissed"].includes(op.status)) t.status = op.status as Todo["status"];
      if (material && t.prompt) t.promptStale = true;
      t.updatedAt = now; changed++;
    } else if (kind === "remove") {
      const i = todos.findIndex((x) => x.id === op.id);
      if (i < 0) { warnings.push(`remove skipped: no item ${String(op.id)}`); continue; }
      todos.splice(i, 1); removed++;
    } else if (kind === "reorder") {
      const ids = Array.isArray(op.ids) ? op.ids.map(String) : [];
      let order = 1;
      for (const id of ids) { const t = todos.find((x) => x.id === id); if (t) t.order = order++; }
      for (const t of [...todos].sort((a, b) => a.order - b.order)) if (!ids.includes(t.id)) t.order = order++;
      reordered = true;
    } else warnings.push(`unknown op ${kind}`);
  }
  const active = todos.filter((t) => t.status === "todo" || t.status === "doing").length;
  if (active > 9) warnings.push(`there are now ${active} active items; the founder can act on 3–7, merge or remove some`);
  const summaryBits = [added && `${added} added`, changed && `${changed} changed`, removed && `${removed} removed`, reordered && "reordered"].filter(Boolean).join(", ") || "no change";
  const listing = [...todos].sort((a, b) => a.order - b.order).map((t) => ({ id: t.id, title: t.title, stage: t.stage, status: t.status, principle: t.principle, evidence: t.evidence }));
  return {
    content: modelJson({ result: summaryBits, active_items: active, items: listing, warnings }),
    ui: { name: "update_todos", ok: true, summary: `What-to-do list: ${summaryBits}` },
    todos,
  };
}

const KINDS: StatKind[] = ["number", "rate", "series", "funnel", "breakdown", "assert"];
const UNITS: StatUnit[] = ["percent", "count", "usd", "minutes", "days", "score"];
const MAX_STATS = 12;

async function applyScoreboardOps(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const board: Scoreboard = { ...ctx.scoreboard, stats: ctx.scoreboard.stats.map((s) => ({ ...s })), results: { ...ctx.scoreboard.results } };
  const ops = Array.isArray(args.ops) ? (args.ops as Record<string, unknown>[]) : [];
  const warnings: string[] = [];
  const now = new Date().toISOString();
  for (const k of ["goal", "activation", "coreRequest"] as const) if (typeof args[k] === "string" && (args[k] as string).trim()) board[k] = (args[k] as string).trim().slice(0, 300);
  if (typeof args.timezone === "string" && args.timezone.trim()) {
    try { new Intl.DateTimeFormat("en-CA", { timeZone: args.timezone.trim() }); board.timezone = args.timezone.trim(); }
    catch { warnings.push(`unknown timezone ignored: ${args.timezone}`); }
  }
  const touched: string[] = [];
  const validMetric = (m: unknown) => (typeof m === "string" && brainIndex.get(m)?.kind === "metric" ? m : undefined);
  let added = 0, changed = 0, removed = 0;
  for (const op of ops) {
    const kind = String(op.op ?? "");
    if (kind === "add") {
      const title = String(op.title ?? "").trim();
      const k = KINDS.includes(op.kind as StatKind) ? (op.kind as StatKind) : undefined;
      if (!title || !k) { warnings.push(`add skipped: title and a valid kind are required (${title.slice(0, 40) || "untitled"})`); continue; }
      if (k !== "assert" && !String(op.sql ?? "").trim()) { warnings.push(`add skipped: "${title.slice(0, 40)}" has no sql`); continue; }
      if (board.stats.length >= MAX_STATS) { warnings.push(`add skipped: the scoreboard holds ${MAX_STATS} stats; remove one first`); continue; }
      if (typeof op.metricId === "string" && !validMetric(op.metricId)) warnings.push(`unknown metricId dropped on "${title.slice(0, 40)}": ${op.metricId}`);
      const spec: StatSpec = {
        id: `st-${randomBytes(3).toString("hex")}`, title: title.slice(0, 90), kind: k,
        unit: UNITS.includes(op.unit as StatUnit) ? (op.unit as StatUnit) : k === "rate" ? "percent" : "count",
        sql: k === "assert" ? undefined : String(op.sql).trim(), metricId: validMetric(op.metricId), field: typeof op.field === "string" ? op.field.trim() : undefined,
        why: String(op.why ?? "").trim().slice(0, 600), caveat: typeof op.caveat === "string" ? op.caveat.trim().slice(0, 300) : undefined,
        stage: typeof op.stage === "string" && stageIds.includes(op.stage) ? (op.stage as StageId) : undefined,
        order: Math.max(0, ...board.stats.map((s) => s.order)) + 1,
        value: k === "assert" && typeof op.value === "number" ? op.value : undefined, source: typeof op.source === "string" ? op.source.slice(0, 200) : undefined,
        createdAt: now, updatedAt: now,
      };
      board.stats.push(spec); touched.push(spec.id); added++;
    } else if (kind === "update") {
      const s = board.stats.find((x) => x.id === op.id);
      if (!s) { warnings.push(`update skipped: no stat ${String(op.id)}`); continue; }
      if (typeof op.title === "string" && op.title.trim()) s.title = op.title.trim().slice(0, 90);
      if (KINDS.includes(op.kind as StatKind)) s.kind = op.kind as StatKind;
      if (UNITS.includes(op.unit as StatUnit)) s.unit = op.unit as StatUnit;
      if (typeof op.sql === "string" && op.sql.trim()) s.sql = op.sql.trim();
      if (typeof op.metricId === "string") { const m = validMetric(op.metricId); if (m) s.metricId = m; else warnings.push(`unknown metricId ignored: ${op.metricId}`); }
      if (typeof op.field === "string") s.field = op.field.trim() || undefined;
      if (typeof op.why === "string" && op.why.trim()) s.why = op.why.trim().slice(0, 600);
      if (typeof op.caveat === "string") s.caveat = op.caveat.trim().slice(0, 300) || undefined;
      if (typeof op.stage === "string" && stageIds.includes(op.stage)) s.stage = op.stage as StageId;
      if (typeof op.value === "number") s.value = op.value;
      if (typeof op.source === "string") s.source = op.source.slice(0, 200);
      s.updatedAt = now; touched.push(s.id); changed++;
    } else if (kind === "remove") {
      const i = board.stats.findIndex((x) => x.id === op.id);
      if (i < 0) { warnings.push(`remove skipped: no stat ${String(op.id)}`); continue; }
      delete board.results[board.stats[i].id]; board.stats.splice(i, 1); removed++;
    } else if (kind === "reorder") {
      const ids = Array.isArray(op.ids) ? op.ids.map(String) : [];
      let order = 1;
      for (const id of ids) { const s = board.stats.find((x) => x.id === id); if (s) s.order = order++; }
      for (const s of [...board.stats].sort((a, b) => a.order - b.order)) if (!ids.includes(s.id)) s.order = order++;
    } else warnings.push(`unknown op ${kind}`);
  }
  // Run what changed (and anything never run), on one connection.
  const toRun = board.stats.filter((s) => touched.includes(s.id) || !board.results[s.id]).map((s) => s.id);
  if (toRun.length) {
    const fresh = await runScoreboard(ctx.req.connections?.postgres, board, toRun);
    Object.assign(board.results, fresh);
    board.computedAt = new Date().toISOString();
  }
  const evaluation = evaluateScoreboard(board);
  const failed = board.stats.filter((s) => board.results[s.id] && !board.results[s.id].ok);
  {
    const seen = new Map<string, StatSpec[]>();
    for (const s of board.stats) if (s.metricId && s.field) { const k = `${s.metricId}.${s.field}`; seen.set(k, [...(seen.get(k) ?? []), s]); }
    for (const [k, list] of seen) if (list.length > 1) warnings.push(`${k} is bound by ${list.length} stats (${list.map((s) => `${s.id} ${s.kind}`).join(", ")}); the scalar one grades readiness, a series is graded on its latest period — keep one per field or bind the other to a different field`);
  }
  const forModel = {
    result: [added && `${added} added`, changed && `${changed} changed`, removed && `${removed} removed`].filter(Boolean).join(", ") || "no change",
    goal: board.goal, activation: board.activation, timezone: board.timezone,
    stats: [...board.stats].sort((a, b) => a.order - b.order).map((s) => ({ id: s.id, title: s.title, kind: s.kind, metricId: s.metricId, field: s.field, result: compactResult(board.results[s.id]) })),
    readiness: { stageByNumbers: evaluation.stageByNumbers, rows: evaluation.rows.filter((r) => r.status !== "unmeasured").map((r) => `${r.stage} ${r.metric}.${r.field}: ${r.status}${r.actual != null ? ` (actual ${fmtNum(r.actual)} ${r.op} ${r.value})` : ""}`), unboundForCurrentStage: evaluation.stageByNumbers ? evaluation.unbound[evaluation.stageByNumbers] : undefined },
    warnings: [...warnings, ...failed.map((s) => `${s.id} "${s.title}" failed: ${board.results[s.id].error}`)],
  };
  const okCount = board.stats.filter((s) => board.results[s.id]?.ok).length;
  return {
    content: modelJson(forModel),
    // Partial success is success with a count; only a board where nothing computed reads as an error.
    ui: { name: "update_scoreboard", ok: okCount > 0 || board.stats.length === 0, summary: `Scoreboard: ${forModel.result}; ${okCount}/${board.stats.length} stats computed${failed.length ? `, ${failed.length} failed` : ""}${evaluation.stageByNumbers ? `; stage by the numbers: ${evaluation.stageByNumbers}` : ""}` },
    scoreboard: board,
    eval: evaluation,
  };
}

const fmtNum = (n: number) => (Math.abs(n) < 1 && n !== 0 ? n.toFixed(3) : Number.isInteger(n) ? String(n) : n.toFixed(2));
function compactResult(r: import("../../shared/types.js").StatResult | undefined) {
  if (!r) return "not run";
  if (!r.ok) return { error: r.error };
  if (r.points) return { points: r.points.length, first: r.points[0], last: r.points[r.points.length - 1], last7: r.points.slice(-7).map((p) => p.value), droppedToday: r.droppedToday };
  if (r.steps) return { steps: r.steps.map((s) => `${s.step}: ${s.count}${s.fromPrev != null ? ` (${(s.fromPrev * 100).toFixed(0)}% of prev)` : ""}`) };
  if (r.items) return { items: r.items.map((i) => `${i.label}: ${fmtNum(i.value)}${i.n != null ? ` (n=${i.n})` : ""}`) };
  if (r.numerator != null) return { numerator: r.numerator, denominator: r.denominator, share: r.smallN ? "small-n: quote the counts, not a percentage" : `${(r.value! * 100).toFixed(1)}%` };
  return { value: r.value, n: r.n };
}

async function fetchPage(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const url = String(args.url ?? "").trim();
  if (!url) throw new Error("url is required");
  const { page, sameSite } = await fetchPageForTool(url, ctx.req.site?.origin ?? "");
  const content = modelJson({ ...page, text: page.text.slice(0, 5000), sameSite });
  return { content, ui: { name: "fetch_page", ok: page.status < 400, summary: `${page.title || "(untitled)"} — HTTP ${page.status}`, url: page.url } };
}

async function runSql(args: Record<string, unknown>, ctx: ToolContext, t0: number): Promise<ToolOutcome> {
  const conn = ctx.req.connections?.postgres;
  if (!conn || !hasDatabase(conn)) throw new Error("No database is connected");
  const sql = String(args.sql ?? "");
  const res = await runReadOnlyQuery(conn, sql, 200);
  const forModel = { purpose: args.purpose, columns: res.columns, rowCount: res.rowCount, truncated: res.truncated, rows: res.rows.slice(0, 60), note: res.rows.length > 60 ? "showing first 60 rows to the model; the founder sees up to 200" : undefined };
  return {
    content: modelJson(forModel),
    ui: { name: "run_sql", ok: true, summary: String(args.purpose ?? "Query"), sql, columns: res.columns, rows: res.rows, rowCount: res.rowCount, truncated: res.truncated, ms: Date.now() - t0 },
  };
}

function describeTable(args: Record<string, unknown>, ctx: ToolContext): ToolOutcome {
  const want = String(args.table ?? "").trim().toLowerCase();
  const tables = ctx.req.schema?.tables ?? [];
  const t = tables.find((x) => `${x.schema}.${x.name}`.toLowerCase() === want) ?? tables.find((x) => x.name.toLowerCase() === want.replace(/^public\./, ""));
  if (!t) { const near = tables.filter((x) => x.name.toLowerCase().includes(want.split(".").pop() ?? "")).slice(0, 8).map((x) => `${x.schema}.${x.name}`); throw new Error(`No table ${want}${near.length ? `; similar: ${near.join(", ")}` : ""}`); }
  return { content: modelJson({ table: `${t.schema}.${t.name}`, rows_estimate: t.rows, columns: t.columns }), ui: { name: "db_describe_table", ok: true, summary: `${t.schema}.${t.name}: ${t.columns.length} columns` } };
}

function ghCtx(ctx: ToolContext) {
  const gh = ctx.req.connections?.github;
  const repo = gh?.repo ?? ctx.req.repo?.repo;
  if (!repo) throw new Error("No repository is connected");
  return { repo, token: gh?.token, branch: ctx.req.repo?.defaultBranch ?? "HEAD" };
}

async function ghRead(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const { repo, token } = ghCtx(ctx);
  const path = String(args.path ?? "").trim();
  if (!path) throw new Error("path is required");
  const f = await readFile(repo, path, typeof args.ref === "string" ? args.ref : undefined, token);
  return { content: modelJson({ path: f.path, size: f.size, truncated: f.truncated, content: f.content }), ui: { name: "github_read_file", ok: true, summary: `${f.path} (${f.size.toLocaleString("en-US")} chars${f.truncated ? ", truncated" : ""})`, path: f.path } };
}

async function ghSearch(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const { repo, token, branch } = ghCtx(ctx);
  const q = String(args.query ?? "").trim();
  if (!q) throw new Error("query is required");
  const r = await searchFiles(repo, branch, q, token);
  return { content: modelJson(r), ui: { name: "github_search_files", ok: true, summary: `${r.total} file(s) match "${q}"`, files: r.files } };
}

async function ghCommits(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const { repo, token, branch } = ghCtx(ctx);
  const commits = await listCommits(repo, { since: str(args.since), until: str(args.until), path: str(args.path), limit: typeof args.limit === "number" ? args.limit : 50, branch }, token);
  return { content: modelJson({ count: commits.length, commits }), ui: { name: "github_list_commits", ok: true, summary: `${commits.length} commit(s)`, commits } };
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

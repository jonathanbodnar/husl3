import { randomBytes } from "node:crypto";
import type { ChatRequest, StageId, Todo, ToolUi } from "../../shared/types.js";
import { brainIndex, stageIds } from "../brain/render.js";
import { hasDatabase, runReadOnlyQuery } from "../db/postgres.js";
import { listCommits, readFile, searchFiles } from "../github/client.js";
import { fetchPageForTool } from "../site/scan.js";

export interface ToolOutcome { content: string; ui: ToolUi; todos?: Todo[] }
export interface ToolContext { req: ChatRequest; todos: Todo[] }

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

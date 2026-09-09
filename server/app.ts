import { serveStatic } from "@hono/node-server/serve-static";
import type { HttpBindings } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ChatRequest, HealthResponse, PromptsRequest } from "../shared/types.js";
import { brainIndex, brainTokensApprox, brainVersion, describeEvidence, brain } from "./brain/render.js";
import { runChatTurn } from "./chat.js";
import { DailyBudget } from "./cost.js";
import { introspect, validateConnectionString } from "./db/postgres.js";
import { env } from "./env.js";
import { introspectRepo, parseRepo } from "./github/client.js";
import { craftPrompts } from "./prompts/craft.js";
import { scanSite } from "./site/scan.js";

type Bindings = { Bindings: HttpBindings };
export const app = new Hono<Bindings>();
const budget = new DailyBudget(env.dailyBudgetUsd);

// ── helpers ──────────────────────────────────────────────────────────────────
const ipOf = (c: { req: { header: (k: string) => string | undefined }; env?: HttpBindings }) =>
  (c.req.header("x-forwarded-for") ?? "").split(",")[0].trim() || c.env?.incoming?.socket?.remoteAddress || "unknown";

class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private readonly perHour: number) {}
  take(key: string): boolean {
    if (this.perHour <= 0) return true;
    const now = Date.now();
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < 3_600_000);
    if (arr.length >= this.perHour) { this.hits.set(key, arr); return false; }
    arr.push(now); this.hits.set(key, arr);
    if (this.hits.size > 20_000) this.hits.clear();
    return true;
  }
}
const limits = { chat: new RateLimiter(env.rate.chat), scan: new RateLimiter(env.rate.scan), prompts: new RateLimiter(env.rate.prompts) };

const errJson = (message: string, status: 400 | 401 | 403 | 413 | 429 | 500 | 502 | 503) => Response.json({ error: message }, { status });
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function body<T>(c: { req: { header: (k: string) => string | undefined; json: () => Promise<unknown> } }): Promise<T> {
  const len = Number(c.req.header("content-length") ?? 0);
  if (len > 6_000_000) throw Object.assign(new Error("Request too large"), { status: 413 });
  try { return (await c.req.json()) as T; } catch { throw Object.assign(new Error("Body must be JSON"), { status: 400 }); }
}

// ── middleware ───────────────────────────────────────────────────────────────
app.use("/api/*", async (c, next) => {
  if (env.accessCode && c.req.path !== "/api/health" && c.req.header("x-access-code") !== env.accessCode) return errJson("Access code required", 401);
  await next();
});

app.onError((err, c) => {
  const status = (err as { status?: number }).status;
  console.error(`[${new Date().toISOString()}] ${c.req.method} ${c.req.path} → ${msg(err)}`);
  return errJson(msg(err), status === 400 || status === 413 ? status : 500);
});

// ── api ──────────────────────────────────────────────────────────────────────
app.get("/api/health", (c) => {
  const chat = env.chat(); const prompts = env.prompts();
  const res: HealthResponse = {
    ok: true, brainVersion, brainTokensApprox,
    chat: { configured: !!chat.apiKey, model: chat.model, thinking: chat.thinking },
    prompts: { configured: !!prompts.apiKey, model: prompts.model, thinking: prompts.thinking, thinkingBudget: prompts.thinkingBudget },
    accessCodeRequired: !!env.accessCode,
    budget: { dailyUsd: env.dailyBudgetUsd, spentTodayUsd: Math.round(budget.spentToday() * 10_000) / 10_000 },
  };
  return c.json(res);
});

app.get("/api/brain/index", (c) => {
  const evidence: Record<string, string> = {};
  for (const id of brainIndex.keys()) { const d = describeEvidence(id); if (d) evidence[id] = d; }
  const stages = (brain.journey ?? []).map((s: { id: string; name: string; goal: string }) => ({ id: s.id, name: s.name, goal: s.goal }));
  const principles = (brain.principles ?? []).map((p: { id: string; key: string; title: string }) => ({ id: p.id, key: p.key, title: p.title }));
  c.header("cache-control", "public, max-age=3600");
  return c.json({ version: brainVersion, stages, principles, evidence });
});

app.post("/api/site/scan", async (c) => {
  if (!limits.scan.take(ipOf(c))) return errJson("Too many scans from this address; try again later", 429);
  const { url } = await body<{ url?: string }>(c);
  if (!url || typeof url !== "string") return errJson("url is required", 400);
  try { return c.json(await scanSite(url)); } catch (e) { return errJson(`Could not read that site: ${msg(e)}`, 502); }
});

app.post("/api/db/introspect", async (c) => {
  if (!limits.scan.take(ipOf(c))) return errJson("Too many requests from this address; try again later", 429);
  const { connectionString } = await body<{ connectionString?: string }>(c);
  try {
    const cs = validateConnectionString(String(connectionString ?? ""));
    return c.json(await introspect(cs));
  } catch (e) { return errJson(`Could not connect: ${redact(msg(e))}`, 502); }
});

app.post("/api/github/introspect", async (c) => {
  if (!limits.scan.take(ipOf(c))) return errJson("Too many requests from this address; try again later", 429);
  const { repo, token } = await body<{ repo?: string; token?: string }>(c);
  try { return c.json(await introspectRepo(parseRepo(String(repo ?? "")), token?.trim() || undefined)); } catch (e) { return errJson(msg(e), 502); }
});

app.post("/api/chat", async (c) => {
  if (!limits.chat.take(ipOf(c))) return errJson("Too many messages from this address this hour; try again later", 429);
  if (budget.exhausted()) return errJson("Today's model budget is used up; the audit resumes tomorrow (UTC).", 503);
  const req = await body<ChatRequest>(c);
  if (!(req?.site?.pages || req?.repo?.repo) || !Array.isArray(req.transcript) || !Array.isArray(req.todos)) return errJson("Malformed chat request", 400);
  if (!req.kickoff && (typeof req.message !== "string" || !req.message.trim())) return errJson("message is required", 400);
  if (req.message && req.message.length > 8000) return errJson("Message too long", 400);
  return streamSSE(c, async (stream) => {
    const ctrl = new AbortController();
    stream.onAbort(() => ctrl.abort());
    c.req.raw.signal?.addEventListener?.("abort", () => ctrl.abort());
    // Hono's writeSSE awaits before it writes; serialize every frame so the last ones
    // (usage, done) cannot lose the race with the stream closing when the handler returns.
    let chain: Promise<unknown> = Promise.resolve();
    const write = (payload: unknown) => { chain = chain.then(() => stream.writeSSE({ data: JSON.stringify(payload) })).catch(() => {}); return chain; };
    const keepalive = setInterval(() => { chain = chain.then(() => stream.writeSSE({ event: "ping", data: "" })).catch(() => {}); }, 15_000);
    try {
      const { usd } = await runChatTurn(req, (e) => { void write(e); }, ctrl.signal);
      budget.add(usd);
    } catch (e) {
      void write({ type: "error", message: msg(e) });
      void write({ type: "done", messages: [], todos: req.todos });
    } finally {
      clearInterval(keepalive);
      await chain;
    }
  });
});

app.post("/api/prompts", async (c) => {
  if (!limits.prompts.take(ipOf(c))) return errJson("Too many prompt requests from this address this hour", 429);
  if (budget.exhausted()) return errJson("Today's model budget is used up; the audit resumes tomorrow (UTC).", 503);
  const req = await body<PromptsRequest>(c);
  if (!(req?.site || req?.repo) || !Array.isArray(req.todos)) return errJson("Malformed prompts request", 400);
  try {
    const res = await craftPrompts(req, c.req.raw.signal);
    budget.add(res.cost.usd);
    return c.json(res);
  } catch (e) { return errJson(msg(e), 502); }
});

// ── static web app ───────────────────────────────────────────────────────────
app.use("/*", serveStatic({ root: "./dist/web" }));
app.get("*", serveStatic({ path: "./dist/web/index.html" }));

function redact(s: string): string { return s.replace(/postgres(ql)?:\/\/[^\s]+/gi, "postgres://…"); }

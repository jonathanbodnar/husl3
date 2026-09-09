import { serveStatic } from "@hono/node-server/serve-static";
import type { HttpBindings } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ChatRequest, HealthResponse, PostgresConnection, PromptsRequest } from "../shared/types.js";
import { auth } from "./auth/oauth.js";
import { sbListProjects } from "./db/supabaseMgmt.js";
import { brainIndex, brainTokensApprox, brainVersion, describeEvidence, brain } from "./brain/render.js";
import { runChatTurn } from "./chat.js";
import { DailyBudget } from "./cost.js";
import { introspect, validateConnectionString } from "./db/postgres.js";
import { env } from "./env.js";
import { introspectRepo, listRepos, parseRepo } from "./github/client.js";
import { evaluateScoreboard } from "./stats/readiness.js";
import { runScoreboard } from "./stats/run.js";
import { craftPrompts } from "./prompts/craft.js";
import { scanSite } from "./site/scan.js";

type Bindings = { Bindings: HttpBindings };
export const app = new Hono<Bindings>();
const budget = new DailyBudget(env.dailyBudgetUsd);

// ── helpers ──────────────────────────────────────────────────────────────────
/**
 * X-Forwarded-For is attacker-controlled up to the first trusted proxy: a visitor can prepend any
 * value. Each proxy APPENDS the peer it saw, so with N trusted proxies the real client is N from the
 * right. Taking the leftmost entry (the old behavior) let one header defeat every per-IP limit.
 */
const ipOf = (c: { req: { header: (k: string) => string | undefined }; env?: HttpBindings }) => {
  const socket = c.env?.incoming?.socket?.remoteAddress;
  const hops = env.trustProxyHops;
  if (hops > 0) {
    const chain = (c.req.header("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (chain.length) return chain[Math.max(0, chain.length - hops)];
  }
  return socket || "unknown";
};

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
const globalLimits = { chat: new RateLimiter(env.rateGlobal.chat), scan: new RateLimiter(env.rateGlobal.scan), prompts: new RateLimiter(env.rateGlobal.prompts) };
/** Per-IP first, then the shared ceiling. Returns an error response, or null when the call may proceed. */
function throttle(kind: "chat" | "scan" | "prompts", ip: string, what: string): Response | null {
  if (!limits[kind].take(ip)) return errJson(`Too many ${what} from this address; try again later`, 429);
  if (!globalLimits[kind].take("all")) return errJson(`This instance is busy right now; try again in a few minutes`, 429);
  return null;
}

const errJson = (message: string, status: 400 | 401 | 403 | 413 | 422 | 429 | 500 | 502 | 503) => Response.json({ error: message }, { status });

/**
 * "We could not use what you gave us" is a 4xx, not a bad gateway. It also has to be a 4xx in
 * practice: a CDN in front of this app replaces 5xx bodies with its own error page, which would
 * throw away the sentence telling the founder what to fix.
 */
const targetError = (message: string) => errJson(message, 422);
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const MAX_BODY_BYTES = 6_000_000;

async function body<T>(c: { req: { header: (k: string) => string | undefined; text: () => Promise<string>; json: () => Promise<unknown> } }): Promise<T> {
  const len = Number(c.req.header("content-length") ?? 0);
  if (len > MAX_BODY_BYTES) throw Object.assign(new Error("Request too large"), { status: 413 });
  // Content-Length is a claim; measure what actually arrived.
  const raw = await c.req.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) throw Object.assign(new Error("Request too large"), { status: 413 });
  try { return JSON.parse(raw) as T; } catch { throw Object.assign(new Error("Body must be JSON"), { status: 400 }); }
}

// ── middleware ───────────────────────────────────────────────────────────────
// Canonical host: when APP_ORIGIN is set, send every other public host there so OAuth callbacks,
// the relay page's postMessage origin and the browser's stored sessions all live on one origin.
app.use("*", async (c, next) => {
  if (env.appOrigin && c.req.path !== "/api/health") {
    const host = (c.req.header("x-forwarded-host") ?? c.req.header("host") ?? "").toLowerCase();
    let canonical = "";
    try { canonical = new URL(env.appOrigin).host.toLowerCase(); } catch { canonical = ""; }
    if (host && canonical && host !== canonical && !host.startsWith("localhost") && !host.startsWith("127.0.0.1") && !host.endsWith(".railway.internal")) {
      const u = new URL(c.req.url);
      return c.redirect(`${env.appOrigin.replace(/\/$/, "")}${u.pathname}${u.search}`, 308);
    }
  }
  await next();
});

app.use("/api/*", async (c, next) => {
  // OAuth start/callback are top-level navigations and cannot carry the header.
  if (env.accessCode && c.req.path !== "/api/health" && !c.req.path.startsWith("/api/auth/") && c.req.header("x-access-code") !== env.accessCode) return errJson("Access code required", 401);
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
    oauth: { github: !!(env.github.clientId && env.github.clientSecret), supabase: !!(env.supabase.clientId && env.supabase.clientSecret), githubClientId: env.github.clientId || undefined },
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
  const throttled = throttle("scan", ipOf(c), "scans");
  if (throttled) return throttled;
  const { url } = await body<{ url?: string }>(c);
  if (!url || typeof url !== "string") return errJson("url is required", 400);
  try { return c.json(await scanSite(url)); } catch (e) { return targetError(`Could not read that site: ${msg(e)}`); }
});

app.route("/api/auth", auth);

app.get("/api/github/repos", async (c) => {
  { const throttled = throttle("scan", ipOf(c), "requests"); if (throttled) return throttled; }
  const token = c.req.header("x-github-token");
  if (!token) return errJson("x-github-token header is required", 400);
  try { return c.json(await listRepos(token)); } catch (e) { return targetError(msg(e)); }
});

app.get("/api/supabase/projects", async (c) => {
  { const throttled = throttle("scan", ipOf(c), "requests"); if (throttled) return throttled; }
  const token = c.req.header("x-supabase-token");
  if (!token) return errJson("x-supabase-token header is required", 400);
  try { return c.json(await sbListProjects(token)); } catch (e) { return targetError(msg(e)); }
});

app.post("/api/stats/run", async (c) => {
  { const throttled = throttle("scan", ipOf(c), "requests"); if (throttled) return throttled; }
  const b = await body<{ connection?: PostgresConnection; scoreboard?: { stats?: unknown[]; timezone?: string; results?: Record<string, unknown> }; only?: string[] }>(c);
  if (!b?.scoreboard || !Array.isArray(b.scoreboard.stats)) return errJson("scoreboard.stats is required", 400);
  // Existing results are kept so a partial run (only=[…]) is graded on the whole board, not on the subset.
  const prior = (b.scoreboard.results && typeof b.scoreboard.results === "object" ? b.scoreboard.results : {}) as Record<string, import("../shared/types.js").StatResult>;
  const board = { ...(b.scoreboard as import("../shared/types.js").Scoreboard), results: { ...prior } };
  if (board.stats.length > 12) return errJson("At most 12 stats", 400);
  try {
    const results = await runScoreboard(b.connection, board, Array.isArray(b.only) ? b.only.map(String) : undefined);
    const merged = { ...board, results: { ...board.results, ...results }, computedAt: new Date().toISOString() };
    return c.json({ results, computedAt: merged.computedAt, eval: evaluateScoreboard(merged) });
  } catch (e) { return targetError(`Could not run the scoreboard: ${redact(msg(e))}`); }
});

app.post("/api/db/introspect", async (c) => {
  { const throttled = throttle("scan", ipOf(c), "requests"); if (throttled) return throttled; }
  const b = await body<{ connectionString?: string; connection?: PostgresConnection }>(c);
  const conn: PostgresConnection = b.connection ?? { connectionString: b.connectionString };
  try {
    if (conn.connectionString) conn.connectionString = validateConnectionString(String(conn.connectionString));
    else if (!conn.supabase?.accessToken || !conn.supabase.projectRef) return errJson("Provide a connection string or a Supabase project", 400);
    return c.json(await introspect(conn));
  } catch (e) { return targetError(`Could not connect: ${redact(msg(e))}`); }
});

app.post("/api/github/introspect", async (c) => {
  { const throttled = throttle("scan", ipOf(c), "requests"); if (throttled) return throttled; }
  const { repo, token } = await body<{ repo?: string; token?: string }>(c);
  try { return c.json(await introspectRepo(parseRepo(String(repo ?? "")), token?.trim() || undefined)); } catch (e) { return targetError(msg(e)); }
});

app.post("/api/chat", async (c) => {
  const throttled = throttle("chat", ipOf(c), "messages this hour");
  if (throttled) return throttled;
  const reservation = budget.reserve();
  if (!reservation) return errJson("Today's model budget is used up; the audit resumes tomorrow (UTC).", 503);
  const req = await body<ChatRequest>(c);
  const bad = (m: string, s: 400 = 400) => { reservation.settle(0); return errJson(m, s); };
  if (!(req?.site?.pages || req?.repo?.repo) || !Array.isArray(req.transcript) || !Array.isArray(req.todos)) return bad("Malformed chat request");
  if (!req.kickoff && (typeof req.message !== "string" || !req.message.trim())) return bad("message is required");
  if (req.message && req.message.length > 8000) return bad("Message too long");
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
      reservation.settle(usd);
    } catch (e) {
      void write({ type: "error", message: msg(e) });
      void write({ type: "done", messages: [], todos: req.todos });
    } finally {
      reservation.settle(0);
      clearInterval(keepalive);
      await chain;
    }
  });
});

app.post("/api/prompts", async (c) => {
  const throttled = throttle("prompts", ipOf(c), "prompt requests this hour");
  if (throttled) return throttled;
  const reservation = budget.reserve();
  if (!reservation) return errJson("Today's model budget is used up; the audit resumes tomorrow (UTC).", 503);
  const req = await body<PromptsRequest>(c);
  if (!(req?.site || req?.repo) || !Array.isArray(req.todos)) { reservation.settle(0); return errJson("Malformed prompts request", 400); }
  try {
    const res = await craftPrompts(req, c.req.raw.signal);
    reservation.settle(res.cost.usd);
    return c.json(res);
  } catch (e) {
    // A reply that failed to parse was still generated and still billed by the provider.
    reservation.settle((e as { billedUsd?: number }).billedUsd ?? 0);
    return targetError(msg(e));
  }
});

// ── static web app ───────────────────────────────────────────────────────────
app.use("/*", serveStatic({ root: "./dist/web" }));
app.get("*", serveStatic({ path: "./dist/web/index.html" }));

function redact(s: string): string { return s.replace(/postgres(ql)?:\/\/[^\s]+/gi, "postgres://…"); }

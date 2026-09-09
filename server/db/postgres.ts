import pg from "pg";
import type { DbColumn, DbSchema, DbTable, PostgresConnection } from "../../shared/types.js";
import { env } from "../env.js";
import { assertPublicHost } from "../net.js";
import { prepareReadOnlySql, uniqueColumns } from "./sqlGate.js";
import { sbQuery } from "./supabaseMgmt.js";

const { Client } = pg;

export { prepareReadOnlySql } from "./sqlGate.js";

const SYSTEM_SCHEMAS = [
  "pg_catalog", "information_schema", "pg_toast", "extensions", "graphql", "graphql_public", "realtime", "vault",
  "supabase_functions", "storage", "net", "pgsodium", "pgsodium_masks", "supabase_migrations", "cron", "_realtime", "_analytics", "pgbouncer", "auth",
];

// ── connection handling ─────────────────────────────────────────────────────
function safeUrl(s: string): URL | null { try { return new URL(s); } catch { return null; } }

export function validateConnectionString(s: string): string {
  const t = s.trim();
  if (!/^postgres(ql)?:\/\//i.test(t)) throw new Error("Expected a postgres:// or postgresql:// connection string");
  const u = safeUrl(t);
  if (!u || !u.hostname) throw new Error("Connection string has no host");
  return t;
}

export function hasDatabase(conn: PostgresConnection | undefined | null): boolean {
  return !!(conn?.connectionString || (conn?.supabase?.accessToken && conn.supabase.projectRef));
}

/**
 * A connection string points the server at an arbitrary host:port, which is a request forgery
 * primitive unless it is checked the same way an outbound fetch is. Private ranges are refused
 * unless the operator opted in (local development).
 */
async function assertConnectableHost(connectionString: string): Promise<void> {
  const u = safeUrl(connectionString);
  const host = (u?.hostname ?? "").replace(/^\[|\]$/g, "");
  if (!host) throw new Error("Connection string has no host");
  const local = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (local || env.allowPrivateDbHosts) return;
  await assertPublicHost(host);
}

function clientFor(connectionString: string): pg.Client {
  const host = safeUrl(connectionString)?.hostname ?? "";
  const local = host === "localhost" || host === "127.0.0.1" || host === "::1";
  return new Client({
    connectionString,
    // Managed Postgres (Supabase pooler, Neon, RDS) commonly presents a certificate this client has no
    // root for; verification is on by default and the operator can relax it.
    ssl: local ? undefined : { rejectUnauthorized: env.dbStrictTls },
    connectionTimeoutMillis: 10_000,
    query_timeout: 25_000,
    statement_timeout: 20_000,
    application_name: "vibe-distribution-audit",
  });
}

/** Rows as objects plus the column list, whatever the transport. */
type Runner = (sql: string) => Promise<{ rows: Record<string, unknown>[]; columns: string[] }>;

/** Runs `fn` with a runner bound to the connection: a read-only pg transaction, or the Supabase Management API in read-only mode. */
async function withRunner<T>(conn: PostgresConnection, fn: (run: Runner) => Promise<T>): Promise<T> {
  if (conn.connectionString) {
    const cs = validateConnectionString(conn.connectionString);
    await assertConnectableHost(cs);
    const c = clientFor(cs);
    await c.connect();
    try {
      await c.query("begin read only");
      await c.query("set local statement_timeout = '20s'");
      try {
        return await fn(async (sql) => {
          const res = await c.query({ text: sql, rowMode: "array" });
          const columns = uniqueColumns(res.fields.map((f) => f.name));
          const rows = (res.rows as unknown[][]).map((r) => Object.fromEntries(columns.map((col, i) => [col, r[i]])));
          return { rows, columns };
        });
      } finally { await c.query("rollback").catch(() => {}); }
    } finally { await c.end().catch(() => {}); }
  }
  if (conn.supabase?.accessToken && conn.supabase.projectRef) {
    const { accessToken, projectRef } = conn.supabase;
    return fn(async (sql) => {
      const rows = await sbQuery(accessToken, projectRef, sql);
      const columns = rows.length ? Object.keys(rows[0]) : [];
      return { rows, columns };
    });
  }
  throw new Error("No database is connected");
}

export interface QueryResult { columns: string[]; rows: Record<string, unknown>[]; rowCount: number; truncated: boolean; ms: number }

export async function runReadOnlyQuery(conn: PostgresConnection, input: string, limit = 200): Promise<QueryResult> {
  const { sql, kind } = prepareReadOnlySql(input);
  const wrapped = kind === "select" ? `select * from (${sql}) as q limit ${limit + 1}` : sql;
  const t0 = Date.now();
  return withRunner(conn, async (run) => {
    const { rows, columns } = await run(wrapped);
    const truncated = rows.length > limit;
    const out = rows.slice(0, limit).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, jsonSafe(v)])));
    return { columns, rows: out, rowCount: out.length, truncated, ms: Date.now() - t0 };
  });
}

export interface BatchItem { id: string; sql: string; limit?: number }
export interface BatchResult { rows: Record<string, unknown>[]; columns: string[]; ms: number; error?: string }

/**
 * Runs several read-only statements on ONE connection (or one Management API session) so a scoreboard
 * of a dozen stats does not open a dozen connections. Sequential by design: each statement is bounded
 * by the 20-second statement timeout, and the whole batch by `budgetMs`; statements past the budget
 * are reported, not run.
 */
export async function runReadOnlyBatch(conn: PostgresConnection, items: BatchItem[], budgetMs = 90_000): Promise<Record<string, BatchResult>> {
  const out: Record<string, BatchResult> = {};
  const started = Date.now();
  const prepared = items.map((it) => {
    try { const p = prepareReadOnlySql(it.sql); return { it, sql: p.kind === "select" ? `select * from (${p.sql}) as q limit ${(it.limit ?? 200) + 1}` : p.sql, error: undefined as string | undefined }; }
    catch (e) { return { it, sql: "", error: e instanceof Error ? e.message : String(e) }; }
  });
  for (const p of prepared) if (p.error) out[p.it.id] = { rows: [], columns: [], ms: 0, error: p.error };
  const runnable = prepared.filter((p) => !p.error);
  if (!runnable.length) return out;
  await withRunner(conn, async (run) => {
    for (const p of runnable) {
      if (Date.now() - started > budgetMs) { out[p.it.id] = { rows: [], columns: [], ms: 0, error: "Skipped: the scoreboard's time budget was used up by earlier stats; simplify them or run this one alone." }; continue; }
      const t0 = Date.now();
      try {
        const { rows, columns } = await run(p.sql);
        out[p.it.id] = { rows: rows.slice(0, p.it.limit ?? 200).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, jsonSafe(v)]))), columns, ms: Date.now() - t0 };
      } catch (e) {
        out[p.it.id] = { rows: [], columns: [], ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) };
        // A failed statement aborts a Postgres transaction; the runner opened a single read-only one, so
        // re-arm it before the next statement. The Management API path has no transaction to re-arm.
        if (conn.connectionString) { try { await run("rollback"); await run("begin read only"); await run("set local statement_timeout = '20s'"); } catch { /* the next statement will report it */ } }
      }
    }
  });
  return out;
}

function jsonSafe(v: unknown): unknown {
  if (v == null) return v;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v === "bigint") return v.toString();
  if (Buffer.isBuffer(v)) return `<${v.length} bytes>`;
  if (typeof v === "string") return v.length > 400 ? v.slice(0, 400) + "…" : v;
  if (typeof v === "object") { const s = JSON.stringify(v); return s.length > 400 ? s.slice(0, 400) + "…" : v; }
  return v;
}

// ── introspection ───────────────────────────────────────────────────────────
const TIME_COL = /(created|inserted|signed|started|updated|paid|cancel|deleted|ended|expires?|trial|converted|last_|first_|_at$|_on$|date|timestamp)/i;

export async function introspect(conn: PostgresConnection): Promise<DbSchema> {
  return withRunner(conn, async (run) => {
    const notes: string[] = [];
    const cols = await run(
      `select c.table_schema, c.table_name, c.column_name, c.data_type, c.is_nullable
       from information_schema.columns c
       join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
       where c.table_schema not in (${SYSTEM_SCHEMAS.map((s) => `'${s}'`).join(",")})
       order by c.table_schema, c.table_name, c.ordinal_position`,
    );
    const stats = await run(`select schemaname, relname, n_live_tup from pg_stat_user_tables`).catch(() => ({ rows: [] as Record<string, unknown>[], columns: [] as string[] }));
    const est = new Map<string, number>();
    for (const r of stats.rows) est.set(`${r.schemaname}.${r.relname}`, Number(r.n_live_tup));

    const tables = new Map<string, DbTable>();
    for (const r of cols.rows as unknown as { table_schema: string; table_name: string; column_name: string; data_type: string; is_nullable: string }[]) {
      const key = `${r.table_schema}.${r.table_name}`;
      if (!tables.has(key)) tables.set(key, { schema: r.table_schema, name: r.table_name, rows: est.get(key) ?? null, columns: [], timeColumns: [] });
      const t = tables.get(key)!;
      t.columns.push({ name: r.column_name, type: shortType(r.data_type), nullable: r.is_nullable === "YES" });
      if (/timestamp|date/.test(r.data_type) && TIME_COL.test(r.column_name)) t.timeColumns.push(r.column_name);
    }

    // auth.users is excluded above (it is a platform schema) but it is the account table on Supabase,
    // so read its real shape rather than assuming one.
    let authUsers: number | null = null;
    try {
      const r = await run(`select count(*)::text as n from auth.users`);
      authUsers = Number((r.rows[0] as { n?: string })?.n ?? 0);
      const ac = await run(
        `select column_name, data_type, is_nullable from information_schema.columns
         where table_schema = 'auth' and table_name = 'users' order by ordinal_position`,
      ).catch(() => ({ rows: [] as Record<string, unknown>[], columns: [] as string[] }));
      const columns: DbColumn[] = (ac.rows as unknown as { column_name: string; data_type: string; is_nullable: string }[])
        .map((c) => ({ name: c.column_name, type: shortType(c.data_type), nullable: c.is_nullable === "YES" }));
      const timeColumns = (ac.rows as unknown as { column_name: string; data_type: string }[])
        .filter((c) => /timestamp|date/.test(c.data_type) && TIME_COL.test(c.column_name)).map((c) => c.column_name);
      if (columns.length) tables.set("auth.users", { schema: "auth", name: "users", rows: authUsers, columns, timeColumns });
      else notes.push("auth.users is readable but its column list is not; ask before assuming column names there.");
    } catch { authUsers = null; }

    const list = [...tables.values()].sort((a, b) => (b.rows ?? -1) - (a.rows ?? -1));
    const statsMissing = stats.rows.length === 0 && list.length > 0;
    if (statsMissing) notes.push("Row estimates were unavailable (pg_stat_user_tables not readable with this connection), so table sizes are unknown.");
    notes.push("Only tables this connection may read are listed; a table you expect but do not see is one this role cannot see.");
    return { introspectedAt: new Date().toISOString(), tables: list, summary: summarize(list, authUsers, notes), authUsers };
  });
}

function shortType(t: string): string {
  return t.replace("timestamp with time zone", "timestamptz").replace("timestamp without time zone", "timestamp").replace("character varying", "varchar").replace("double precision", "float8").replace("USER-DEFINED", "enum").replace("ARRAY", "array");
}

const fmt = (n: number | null) => (n == null ? "?" : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export function summarize(tables: DbTable[], authUsers: number | null, notes: string[] = []): string {
  const L: string[] = [];
  L.push(`${tables.length} tables. Row counts are planner estimates except auth.users${authUsers != null ? ` (exact: ${authUsers.toLocaleString("en-US")} accounts)` : " (not readable with this connection)"}.`);
  for (const n of notes) L.push(`Note: ${n}`);
  const detailed = tables.slice(0, 70);
  for (const t of detailed) {
    const cols = t.columns.slice(0, 45).map((c) => `${c.name} ${c.type}`).join(", ");
    L.push(`- ${t.schema}.${t.name} (≈${fmt(t.rows)} rows${t.timeColumns.length ? `; time cols: ${t.timeColumns.join(", ")}` : ""}): ${cols}${t.columns.length > 45 ? `, … +${t.columns.length - 45} more` : ""}`);
  }
  if (tables.length > detailed.length) L.push(`Other tables (use db_describe_table for columns): ${tables.slice(detailed.length).map((t) => `${t.schema}.${t.name} (≈${fmt(t.rows)})`).join(", ")}`);
  return L.join("\n");
}

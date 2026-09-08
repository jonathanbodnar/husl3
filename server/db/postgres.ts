import pg from "pg";
import type { DbColumn, DbSchema, DbTable } from "../../shared/types.js";

const { Client } = pg;

const SYSTEM_SCHEMAS = new Set([
  "pg_catalog", "information_schema", "pg_toast", "extensions", "graphql", "graphql_public", "realtime", "vault",
  "supabase_functions", "storage", "net", "pgsodium", "pgsodium_masks", "supabase_migrations", "cron", "_realtime", "_analytics", "pgbouncer", "auth",
]);

function clientFor(connectionString: string): pg.Client {
  const u = safeUrl(connectionString);
  const host = u?.hostname ?? "";
  const local = host === "localhost" || host === "127.0.0.1" || host === "::1";
  return new Client({
    connectionString,
    ssl: local ? undefined : { rejectUnauthorized: false },
    connectionTimeoutMillis: 10_000,
    query_timeout: 25_000,
    statement_timeout: 20_000,
    application_name: "vibe-distribution-audit",
  });
}

function safeUrl(s: string): URL | null { try { return new URL(s); } catch { return null; } }

export function validateConnectionString(s: string): string {
  const t = s.trim();
  if (!/^postgres(ql)?:\/\//i.test(t)) throw new Error("Expected a postgres:// or postgresql:// connection string");
  const u = safeUrl(t);
  if (!u || !u.hostname) throw new Error("Connection string has no host");
  return t;
}

/** Run one function against a connected client, always closing it. */
async function withClient<T>(connectionString: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = clientFor(connectionString);
  await c.connect();
  try { return await fn(c); } finally { await c.end().catch(() => {}); }
}

const FORBIDDEN = /\b(insert|update|delete|drop|alter|create|grant|revoke|truncate|copy|call|do|vacuum|analyze|analyse|refresh|lock|listen|notify|unlisten|set|reset|comment|security|pg_terminate_backend|pg_cancel_backend|pg_sleep|set_config|pg_advisory_lock|pg_advisory_xact_lock|pg_try_advisory_lock|pg_read_file|pg_read_binary_file|pg_ls_dir|dblink|lo_import|lo_export|pg_reload_conf|pg_rotate_logfile)\b/i;

/** Accept a single read-only statement; everything else is rejected before it reaches the database. */
export function prepareReadOnlySql(input: string): { sql: string; kind: "select" | "explain" } {
  let sql = input.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "").trim();
  sql = sql.replace(/;+\s*$/, "").trim();
  if (!sql) throw new Error("Empty SQL");
  if (sql.includes(";")) throw new Error("One statement at a time (no semicolons)");
  if (!/^(select|with|explain)\b/i.test(sql)) throw new Error("Only SELECT / WITH / EXPLAIN statements are allowed");
  // Strip string literals before the keyword check so a value like 'set' does not trip it.
  const noLiterals = sql.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""');
  const bad = noLiterals.match(FORBIDDEN);
  if (bad) throw new Error(`Statement contains a non-read-only keyword: ${bad[0]}`);
  return { sql, kind: /^explain\b/i.test(sql) ? "explain" : "select" };
}

export interface QueryResult { columns: string[]; rows: Record<string, unknown>[]; rowCount: number; truncated: boolean; ms: number }

export async function runReadOnlyQuery(connectionString: string, input: string, limit = 200): Promise<QueryResult> {
  const { sql, kind } = prepareReadOnlySql(input);
  const wrapped = kind === "select" ? `select * from (${sql}) as q limit ${limit + 1}` : sql;
  return withClient(connectionString, async (c) => {
    const t0 = Date.now();
    await c.query("begin read only");
    try {
      await c.query("set local statement_timeout = '20s'");
      const res = await c.query({ text: wrapped, rowMode: "array" });
      const columns = res.fields.map((f) => f.name);
      const truncated = res.rows.length > limit;
      const rows = (res.rows.slice(0, limit) as unknown[][]).map((r) => Object.fromEntries(columns.map((col, i) => [col, jsonSafe(r[i])])));
      return { columns, rows, rowCount: rows.length, truncated, ms: Date.now() - t0 };
    } finally {
      await c.query("rollback").catch(() => {});
    }
  });
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

const TIME_COL = /(created|inserted|signed|started|updated|paid|cancel|deleted|ended|expires?|trial|converted|last_|first_|_at$|_on$|date|timestamp)/i;

export async function introspect(connectionString: string): Promise<DbSchema> {
  return withClient(connectionString, async (c) => {
    await c.query("begin read only");
    try {
      await c.query("set local statement_timeout = '20s'");
      const cols = await c.query<{ table_schema: string; table_name: string; column_name: string; data_type: string; is_nullable: string }>(
        `select c.table_schema, c.table_name, c.column_name, c.data_type, c.is_nullable
         from information_schema.columns c
         join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
         where c.table_schema not in (${[...SYSTEM_SCHEMAS].map((s) => `'${s}'`).join(",")})
         order by c.table_schema, c.table_name, c.ordinal_position`,
      );
      const stats = await c.query<{ schemaname: string; relname: string; n_live_tup: string }>(`select schemaname, relname, n_live_tup from pg_stat_user_tables`).catch(() => ({ rows: [] as { schemaname: string; relname: string; n_live_tup: string }[] }));
      const est = new Map<string, number>();
      for (const r of stats.rows) est.set(`${r.schemaname}.${r.relname}`, Number(r.n_live_tup));
      let authUsers: number | null = null;
      try { const r = await c.query<{ n: string }>(`select count(*)::text as n from auth.users`); authUsers = Number(r.rows[0]?.n ?? 0); } catch { authUsers = null; }
      const tables = new Map<string, DbTable>();
      for (const r of cols.rows) {
        const key = `${r.table_schema}.${r.table_name}`;
        if (!tables.has(key)) tables.set(key, { schema: r.table_schema, name: r.table_name, rows: est.get(key) ?? null, columns: [], timeColumns: [] });
        const t = tables.get(key)!;
        const col: DbColumn = { name: r.column_name, type: shortType(r.data_type), nullable: r.is_nullable === "YES" };
        t.columns.push(col);
        if (/timestamp|date/.test(r.data_type) && TIME_COL.test(r.column_name)) t.timeColumns.push(r.column_name);
      }
      if (authUsers != null) tables.set("auth.users", { schema: "auth", name: "users", rows: authUsers, columns: [
        { name: "id", type: "uuid", nullable: false }, { name: "email", type: "text", nullable: true }, { name: "created_at", type: "timestamptz", nullable: true },
        { name: "last_sign_in_at", type: "timestamptz", nullable: true }, { name: "confirmed_at", type: "timestamptz", nullable: true }, { name: "raw_user_meta_data", type: "jsonb", nullable: true }, { name: "raw_app_meta_data", type: "jsonb", nullable: true },
      ], timeColumns: ["created_at", "last_sign_in_at", "confirmed_at"] });
      const list = [...tables.values()].sort((a, b) => (b.rows ?? -1) - (a.rows ?? -1));
      return { introspectedAt: new Date().toISOString(), tables: list, summary: summarize(list, authUsers), authUsers };
    } finally {
      await c.query("rollback").catch(() => {});
    }
  });
}

function shortType(t: string): string {
  return t.replace("timestamp with time zone", "timestamptz").replace("timestamp without time zone", "timestamp").replace("character varying", "varchar").replace("double precision", "float8").replace("USER-DEFINED", "enum").replace("ARRAY", "array");
}

const fmt = (n: number | null) => (n == null ? "?" : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export function summarize(tables: DbTable[], authUsers: number | null): string {
  const L: string[] = [];
  L.push(`${tables.length} tables. Row counts are planner estimates except auth.users${authUsers != null ? ` (exact: ${authUsers.toLocaleString("en-US")} accounts)` : " (not readable with this connection)"}.`);
  const detailed = tables.slice(0, 70);
  for (const t of detailed) {
    const cols = t.columns.slice(0, 45).map((c) => `${c.name} ${c.type}`).join(", ");
    L.push(`- ${t.schema}.${t.name} (≈${fmt(t.rows)} rows${t.timeColumns.length ? `; time cols: ${t.timeColumns.join(", ")}` : ""}): ${cols}${t.columns.length > 45 ? `, … +${t.columns.length - 45} more` : ""}`);
  }
  if (tables.length > detailed.length) L.push(`Other tables (use db_describe_table for columns): ${tables.slice(detailed.length).map((t) => `${t.schema}.${t.name} (≈${fmt(t.rows)})`).join(", ")}`);
  return L.join("\n");
}

/**
 * Read-only SQL gate.
 *
 * The gate must decide two things about a statement the model wrote: is it a single read, and does it
 * call anything that reads files, kills backends, sleeps, or executes SQL from a string. Doing that with
 * plain regexes over the raw text is wrong in both directions:
 *   - stripping comments before masking literals mangles `where note = '-- not a comment'`;
 *   - masking double-quoted identifiers hides `select "pg_sleep"(30)`, which Postgres runs happily.
 * So the text is lexed once, following Postgres' actual quoting rules, and the checks run on the parts
 * that are really code.
 */

/** Functions that read the filesystem, control other sessions, sleep, or execute SQL from a string. */
const FORBIDDEN_CALLS = [
  "pg_sleep", "pg_sleep_for", "pg_sleep_until",
  "pg_read_file", "pg_read_binary_file", "pg_stat_file", "pg_ls_dir", "pg_ls_logdir", "pg_ls_waldir", "pg_ls_tmpdir", "pg_ls_archive_statusdir",
  "pg_terminate_backend", "pg_cancel_backend", "pg_reload_conf", "pg_rotate_logfile", "pg_promote",
  "lo_import", "lo_export", "lo_get", "lo_put",
  "dblink", "dblink_exec", "dblink_connect", "dblink_send_query",
  "query_to_xml", "query_to_xmlschema", "query_to_xml_and_xmlschema",
  "set_config", "pg_advisory_lock", "pg_advisory_xact_lock", "pg_try_advisory_lock", "pg_advisory_unlock",
  "pg_create_restore_point", "pg_switch_wal", "pg_backup_start", "pg_backup_stop",
];

/**
 * Words that can turn a statement that STARTS as a read into a write: DML inside a CTE
 * (with x as (delete …)), SELECT … INTO, FOR UPDATE locks, and DDL. Everything else that is not a read
 * (SET, COPY, BEGIN, VACUUM …) cannot appear inside a SELECT at all, so it is already excluded by the
 * head check and the one-statement rule — and listing it here only blocked honest queries, because
 * CASE … END, FETCH FIRST, and columns named start, end, comment, lock or set are all ordinary reads.
 * The database-level read-only transaction remains the last line.
 */
const FORBIDDEN_KEYWORDS = [
  "insert", "update", "delete", "merge", "into", "truncate", "drop", "alter", "create", "grant", "revoke", "analyze", "analyse",
];

const FORBIDDEN = new Set([...FORBIDDEN_CALLS, ...FORBIDDEN_KEYWORDS]);

export interface LexResult {
  /** The statement with real comments removed and everything else untouched. This is what runs. */
  sql: string;
  /** Words that appear as code: bare words plus the contents of double-quoted identifiers, lowercased. */
  words: string[];
  /** Leading keyword, lowercased. */
  head: string;
  /** Statement separators found outside literals and comments. */
  separators: number;
  /** True when a quote or comment was never closed. */
  unterminated: boolean;
}

const WORD_CHAR = /[A-Za-z0-9_-￿]/;
const DOLLAR_TAG = /^\$(?:[A-Za-z_-￿][A-Za-z0-9_-￿]*)?\$/;

export function lexSql(input: string): LexResult {
  const out: string[] = [];
  const words: string[] = [];
  let separators = 0;
  let unterminated = false;
  let word = "";
  const flush = () => {
    if (word) { words.push(word.toLowerCase()); word = ""; }
  };

  for (let i = 0; i < input.length; ) {
    const c = input[i];
    const next = input[i + 1];

    // line comment
    if (c === "-" && next === "-") {
      flush();
      const nl = input.indexOf("\n", i);
      i = nl < 0 ? input.length : nl;
      out.push(" ");
      continue;
    }
    // block comment (nests in Postgres)
    if (c === "/" && next === "*") {
      flush();
      let depth = 1;
      i += 2;
      while (i < input.length && depth > 0) {
        if (input[i] === "/" && input[i + 1] === "*") { depth++; i += 2; }
        else if (input[i] === "*" && input[i + 1] === "/") { depth--; i += 2; }
        else i++;
      }
      if (depth > 0) unterminated = true;
      out.push(" ");
      continue;
    }
    // string literal; a leading E allows backslash escapes
    if (c === "'") {
      const escaped = word.toLowerCase() === "e";
      flush();
      const start = i;
      i++;
      let closed = false;
      while (i < input.length) {
        if (escaped && input[i] === "\\") { i += 2; continue; }
        if (input[i] === "'") {
          if (input[i + 1] === "'") { i += 2; continue; }
          i++; closed = true; break;
        }
        i++;
      }
      if (!closed) unterminated = true;
      out.push(input.slice(start, i));
      continue;
    }
    // dollar-quoted string
    if (c === "$") {
      const tag = DOLLAR_TAG.exec(input.slice(i));
      if (tag) {
        flush();
        const close = input.indexOf(tag[0], i + tag[0].length);
        const end = close < 0 ? input.length : close + tag[0].length;
        if (close < 0) unterminated = true;
        out.push(input.slice(i, end));
        i = end;
        continue;
      }
    }
    // double-quoted identifier: its CONTENT is code, so it must be checked, never blanked
    if (c === '"') {
      flush();
      const start = i;
      i++;
      let ident = "";
      let closed = false;
      while (i < input.length) {
        if (input[i] === '"') {
          if (input[i + 1] === '"') { ident += '"'; i += 2; continue; }
          i++; closed = true; break;
        }
        ident += input[i];
        i++;
      }
      if (!closed) unterminated = true;
      words.push(ident.toLowerCase());
      out.push(input.slice(start, i));
      continue;
    }
    if (c === ";") { flush(); separators++; out.push(c); i++; continue; }

    if (WORD_CHAR.test(c)) word += c; else flush();
    out.push(c);
    i++;
  }
  flush();
  return { sql: out.join("").trim(), words, head: (words[0] ?? "").toLowerCase(), separators, unterminated };
}

export interface PreparedSql { sql: string; kind: "select" | "explain" }

/** Accept a single read-only statement; everything else is rejected before it reaches the database. */
export function prepareReadOnlySql(input: string): PreparedSql {
  const lexed = lexSql(input ?? "");
  if (lexed.unterminated) throw new Error("Unterminated quote or comment in the statement");
  let sql = lexed.sql;
  let separators = lexed.separators;
  while (/;\s*$/.test(sql)) { sql = sql.replace(/;\s*$/, "").trim(); separators--; }
  if (!sql) throw new Error("Empty SQL");
  if (separators > 0) throw new Error("One statement at a time (no semicolons)");
  if (!["select", "with", "explain", "table", "values"].includes(lexed.head)) {
    throw new Error("Only SELECT / WITH / EXPLAIN statements are allowed");
  }
  for (const w of lexed.words) {
    if (FORBIDDEN.has(w)) throw new Error(`Statement contains a non-read-only keyword: ${w}`);
  }
  return { sql, kind: lexed.head === "explain" ? "explain" : "select" };
}

/** Column names as the caller must see them: duplicates from a join get a suffix instead of collapsing. */
export function uniqueColumns(columns: string[]): string[] {
  const seen = new Map<string, number>();
  return columns.map((name) => {
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    return n === 1 ? name : `${name}_${n}`;
  });
}

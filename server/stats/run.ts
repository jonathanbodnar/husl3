import type { PostgresConnection, Scoreboard, StatResult, StatSpec } from "../../shared/types.js";
import { runReadOnlyBatch } from "../db/postgres.js";

/**
 * Runs every stat on the scoreboard through the read-only gate and normalizes the rows into the shape
 * the kind promises. The honesty rules from the brain's metric conventions are applied here, not left
 * to the model: today is dropped from daily series, and a share with a numerator under 5 or a
 * denominator under 100 is marked small-n so it is shown as counts, never as a percentage.
 */

const MAX_SERIES_POINTS = 120;
/** The brain's rule: never quote a share with a numerator under 5 or a denominator under 100. */
const smallN = (k: number, n: number) => k < 5 || n < 100;
const MAX_STEPS = 12;
const MAX_ITEMS = 12;
/** Whole-scoreboard wall-clock budget; stats past it report an error instead of hanging the turn. */
const TIME_BUDGET_MS = 90_000;

const num = (v: unknown): number | null => {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") { const n = Number(v.replace(/,/g, "")); return Number.isFinite(n) ? n : null; }
  if (v instanceof Date) return v.getTime();
  return null;
};
const str = (v: unknown): string => (v == null ? "" : v instanceof Date ? v.toISOString().slice(0, 10) : String(v));

/** Today's calendar date in the reporting timezone, as YYYY-MM-DD; UTC when the zone is unknown or invalid. */
export function todayIn(timezone?: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

const pick = (row: Record<string, unknown>, ...names: string[]): unknown => {
  for (const n of names) if (n in row) return row[n];
  const keys = Object.keys(row);
  for (const n of names) { const k = keys.find((x) => x.toLowerCase() === n); if (k) return row[k]; }
  return undefined;
};

export function normalize(spec: StatSpec, rows: Record<string, unknown>[], columns: string[], timezone: string | undefined, computedAt: string, ms: number): StatResult {
  const base: StatResult = { specId: spec.id, ok: true, computedAt, ms };
  const fail = (error: string): StatResult => ({ ...base, ok: false, error });
  switch (spec.kind) {
    case "number": {
      const r = rows[0];
      if (!r) return fail("The query returned no row; a number stat must return exactly one row with a value column.");
      const value = num(pick(r, "value") ?? (columns.length === 1 ? r[columns[0]] : undefined));
      if (value == null) return fail(`No numeric value column in the result (columns: ${columns.join(", ") || "none"}).`);
      const n = num(pick(r, "n"));
      const notes = rows.length > 1 ? [`The query returned ${rows.length} rows; the first was used. A number stat should return one row.`] : undefined;
      return { ...base, value, n: n ?? undefined, notes };
    }
    case "rate": {
      const r = rows[0];
      if (!r) return fail("The query returned no row; a rate stat must return one row with numerator and denominator.");
      const numerator = num(pick(r, "numerator", "num"));
      const denominator = num(pick(r, "denominator", "den"));
      if (numerator == null || denominator == null) return fail(`A rate needs numerator and denominator columns (got: ${columns.join(", ") || "none"}).`);
      const value = denominator > 0 ? numerator / denominator : 0;
      const notes: string[] = [];
      if (rows.length > 1) notes.push(`The query returned ${rows.length} rows; the first was used. A rate stat should return one row.`);
      if (denominator <= 0) notes.push("Denominator is zero; the share is undefined.");
      return { ...base, numerator, denominator, value, smallN: smallN(numerator, denominator) || denominator <= 0, notes: notes.length ? notes : undefined };
    }
    case "series": {
      const today = todayIn(timezone);
      let droppedToday = false;
      const points = rows
        .map((r) => ({ day: str(pick(r, "day", "date", "d")).slice(0, 10), value: num(pick(r, "value", "count", "n")) }))
        .filter((p): p is { day: string; value: number } => /^\d{4}-\d{2}-\d{2}$/.test(p.day) && p.value != null)
        .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
        .filter((p) => { if (p.day >= today) { droppedToday = true; return false; } return true; });
      if (!points.length) return fail(rows.length ? "No usable day/value rows (day must be a date, value numeric; today is excluded)." : "The query returned no rows.");
      const notes: string[] = [];
      const dedup: { day: string; value: number }[] = [];
      for (const p of points) { const last = dedup[dedup.length - 1]; if (last && last.day === p.day) { last.value += p.value; if (!notes.includes("Several rows shared a day and were summed.")) notes.push("Several rows shared a day and were summed."); } else dedup.push({ ...p }); }
      const kept = dedup.slice(-MAX_SERIES_POINTS);
      if (dedup.length > MAX_SERIES_POINTS) notes.push(`Only the latest ${MAX_SERIES_POINTS} of ${dedup.length} days are kept.`);
      if (spec.sql && !/time\s*zone|timezone/i.test(spec.sql)) notes.push(`The SQL names no timezone, so days are bucketed in the database session zone (usually UTC)${timezone ? `, not ${timezone}` : ""}; add AT TIME ZONE to the day expression.`);
      const span = (Date.parse(kept[kept.length - 1].day) - Date.parse(kept[0].day)) / 86_400_000 + 1;
      if (span > kept.length) notes.push(`${Math.round(span - kept.length)} day(s) in the range have no row (quiet days are missing, not zero); totals over "the last 7 days" use calendar days.`);
      return { ...base, points: kept, droppedToday, notes: notes.length ? notes : undefined };
    }
    case "funnel": {
      const raw = rows.map((r) => ({ step: str(pick(r, "step", "name", "label")), count: num(pick(r, "count", "value", "n")) })).filter((s): s is { step: string; count: number } => !!s.step && s.count != null);
      if (!raw.length) return fail("A funnel needs step and count columns, one row per step in path order.");
      const steps = raw.slice(0, MAX_STEPS).map((s, i, arr) => {
        const prev = i > 0 ? arr[i - 1].count : 0;
        const first = arr[0].count;
        // A step conversion is a share: the step is the numerator, the previous step the denominator.
        const small = i > 0 && smallN(s.count, prev);
        return {
          step: s.step,
          count: s.count,
          fromPrev: i > 0 && prev > 0 && !small ? s.count / prev : undefined,
          fromFirst: i > 0 && first > 0 && !smallN(s.count, first) ? s.count / first : undefined,
          smallN: i > 0 ? small : undefined,
        };
      });
      const notes: string[] = [];
      if (steps.some((s, i) => i > 0 && s.count > steps[i - 1].count)) notes.push("Steps are not in narrowing order (a later step counts more than an earlier one): the path order or the step definitions need a second look before any conversion is read.");
      if (rows.length > MAX_STEPS) notes.push(`Only the first ${MAX_STEPS} of ${rows.length} steps are shown.`);
      return { ...base, steps, notes: notes.length ? notes : undefined };
    }
    case "breakdown": {
      const items: { label: string; value: number; n?: number }[] = [];
      for (const r of rows) {
        const label = str(pick(r, "label", "name", "key", "bucket"));
        const value = num(pick(r, "value", "count", "rate"));
        const n = num(pick(r, "n", "denominator"));
        if (label && value != null) {
          // For a share, n is the denominator and value·n the numerator; without n the rule cannot be applied.
          const isShare = spec.unit === "percent";
          const flagged = isShare && n != null ? smallN(Math.round(value * n), n) : undefined;
          items.push({ label, value, ...(n == null ? {} : { n }), ...(flagged ? { smallN: true } : {}) });
        }
      }
      if (!items.length) return fail("A breakdown needs label and value columns.");
      const notes: string[] = [];
      if (spec.unit === "percent" && items.some((i) => i.n == null)) notes.push("Percent breakdown without an n column: the small-n rule cannot be applied, so these shares are unverified. Add n (the denominator) to the query.");
      if (rows.length > MAX_ITEMS) notes.push(`Only the first ${MAX_ITEMS} of ${rows.length} rows are shown.`);
      return { ...base, items: items.slice(0, MAX_ITEMS), notes: notes.length ? notes : undefined };
    }
    case "assert":
      return spec.value == null ? fail("An assert stat needs a value.") : { ...base, value: spec.value };
  }
}

export async function runScoreboard(conn: PostgresConnection | undefined, board: Scoreboard, only?: string[]): Promise<Record<string, StatResult>> {
  const computedAt = new Date().toISOString();
  const results: Record<string, StatResult> = {};
  const targets = board.stats.filter((s) => !only || only.includes(s.id));
  for (const s of targets) if (s.kind === "assert") results[s.id] = normalize(s, [], [], board.timezone, computedAt, 0);
  const sqlStats = targets.filter((s) => s.kind !== "assert");
  if (!sqlStats.length) return results;
  if (!conn) {
    for (const s of sqlStats) results[s.id] = { specId: s.id, ok: false, computedAt, error: "No database is connected" };
    return results;
  }
  const t0 = Date.now();
  // The SQL-level limit keeps the FIRST rows; a series is ascending, so a tight limit would keep the oldest days.
  const batch = await runReadOnlyBatch(conn, sqlStats.map((s) => ({ id: s.id, sql: s.sql ?? "", limit: s.kind === "series" ? 2000 : 200 })), TIME_BUDGET_MS);
  for (const s of sqlStats) {
    const r = batch[s.id];
    if (!r) { results[s.id] = { specId: s.id, ok: false, computedAt, error: "Not run" }; continue; }
    if (r.error) { results[s.id] = { specId: s.id, ok: false, computedAt, error: r.error, ms: r.ms }; continue; }
    const res = normalize(s, r.rows, r.columns, board.timezone, computedAt, r.ms);
    if (r.truncated) res.notes = [...(res.notes ?? []), `The query returned more rows than the cap; the first ${r.rows.length} were used.`];
    results[s.id] = res;
  }
  void t0;
  return results;
}

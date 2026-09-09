import type { PostgresConnection, Scoreboard, StatResult, StatSpec } from "../../shared/types.js";
import { runReadOnlyBatch } from "../db/postgres.js";

/**
 * Runs every stat on the scoreboard through the read-only gate and normalizes the rows into the shape
 * the kind promises. The honesty rules from the brain's metric conventions are applied here, not left
 * to the model: today is dropped from daily series, and a share with a numerator under 5 or a
 * denominator under 100 is marked small-n so it is shown as counts, never as a percentage.
 */

const MAX_SERIES_POINTS = 120;
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
      return { ...base, value, n: n ?? undefined };
    }
    case "rate": {
      const r = rows[0];
      if (!r) return fail("The query returned no row; a rate stat must return one row with numerator and denominator.");
      const numerator = num(pick(r, "numerator", "num"));
      const denominator = num(pick(r, "denominator", "den"));
      if (numerator == null || denominator == null) return fail(`A rate needs numerator and denominator columns (got: ${columns.join(", ") || "none"}).`);
      const smallN = numerator < 5 || denominator < 100;
      const value = denominator > 0 ? numerator / denominator : 0;
      return { ...base, numerator, denominator, value, smallN };
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
      return { ...base, points: points.slice(-MAX_SERIES_POINTS), droppedToday };
    }
    case "funnel": {
      const raw = rows.map((r) => ({ step: str(pick(r, "step", "name", "label")), count: num(pick(r, "count", "value", "n")) })).filter((s): s is { step: string; count: number } => !!s.step && s.count != null);
      if (!raw.length) return fail("A funnel needs step and count columns, one row per step in path order.");
      const steps = raw.slice(0, MAX_STEPS).map((s, i, arr) => ({
        step: s.step,
        count: s.count,
        fromPrev: i > 0 && arr[i - 1].count > 0 ? s.count / arr[i - 1].count : undefined,
        fromFirst: i > 0 && arr[0].count > 0 ? s.count / arr[0].count : undefined,
      }));
      return { ...base, steps };
    }
    case "breakdown": {
      const items: { label: string; value: number; n?: number }[] = [];
      for (const r of rows) {
        const label = str(pick(r, "label", "name", "key", "bucket"));
        const value = num(pick(r, "value", "count", "rate"));
        const n = num(pick(r, "n", "denominator"));
        if (label && value != null) items.push(n == null ? { label, value } : { label, value, n });
      }
      if (!items.length) return fail("A breakdown needs label and value columns.");
      return { ...base, items: items.slice(0, MAX_ITEMS) };
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
  const batch = await runReadOnlyBatch(conn, sqlStats.map((s) => ({ id: s.id, sql: s.sql ?? "", limit: s.kind === "series" ? MAX_SERIES_POINTS + 1 : 200 })), TIME_BUDGET_MS);
  for (const s of sqlStats) {
    const r = batch[s.id];
    if (!r) { results[s.id] = { specId: s.id, ok: false, computedAt, error: "Not run" }; continue; }
    results[s.id] = r.error ? { specId: s.id, ok: false, computedAt, error: r.error, ms: r.ms } : normalize(s, r.rows, r.columns, board.timezone, computedAt, r.ms);
  }
  void t0;
  return results;
}

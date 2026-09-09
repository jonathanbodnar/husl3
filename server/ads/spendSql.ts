import type { AdDataset } from "../../shared/types.js";

/**
 * Makes the uploaded ad spend joinable to the founder's own tables.
 *
 * Spend lives in a file and outcomes live in Postgres, so the two look unjoinable. They are not: a
 * `values` list is a table, and the read-only gate already accepts one. The model writes `{{ad_spend}}`
 * where a table belongs and the SERVER pastes the rows in — the model never retypes the numbers, which
 * is how numbers get invented, and never spends tokens on them either.
 *
 * Everything spliced in is escaped and type-checked here, because a campaign name is attacker-adjacent
 * text: it comes from a file, and someone naming a campaign `x') union select …` must not be able to
 * write SQL. Strings are single-quoted with their quotes doubled, days are checked against a date
 * shape, and numbers must be finite.
 */

export const AD_SPEND_TOKEN = "{{ad_spend}}";
/** Columns the spliced table exposes, in order. */
export const AD_SPEND_COLUMNS = "platform, campaign, campaign_id, day, spend, impressions, clicks";

const MAX_ROWS = 3000;
const MAX_SQL_BYTES = 400_000;

const lit = (s: string) => `'${String(s).replace(/'/g, "''")}'`;
const numOrNull = (n: number | undefined) => (typeof n === "number" && Number.isFinite(n) ? String(n) : "null");
const DAY_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

export function hasAdSpendToken(sql: string | undefined): boolean {
  return !!sql && sql.includes(AD_SPEND_TOKEN);
}

/** The bare `(…),(…)` rows of the values list, escaped and type-checked. */
export function adSpendValues(ads: AdDataset): string {
  const rows = ads.rows.filter((r) => DAY_SHAPE.test(r.day) && Number.isFinite(r.spend));
  if (!rows.length) throw new Error("The uploaded ad spend has no usable rows to join.");
  if (rows.length > MAX_ROWS) throw new Error(`The uploaded ad spend has ${rows.length} rows, more than the ${MAX_ROWS} that can be joined in one query. Narrow the date range in the export, or aggregate before joining.`);
  const values = rows
    .map((r) => `(${lit(r.platform)},${lit(r.campaign)},${r.campaignId ? lit(r.campaignId) : "null"},date ${lit(r.day)},${numOrNull(r.spend)},${numOrNull(r.impressions)},${numOrNull(r.clicks)})`)
    .join(",");
  if (Buffer.byteLength(values, "utf8") > MAX_SQL_BYTES) throw new Error("The uploaded ad spend is too large to splice into a query. Narrow the date range in the export.");
  return values;
}

/** The full `(values …) as ad_spend(…)` table expression. */
export function adSpendTable(ads: AdDataset): string {
  return `(values ${adSpendValues(ads)}) as ad_spend(${AD_SPEND_COLUMNS})`;
}

/** Words that follow a table reference, so they are never the alias the writer meant. */
const NOT_AN_ALIAS = new Set([
  "where", "group", "order", "limit", "offset", "having", "join", "left", "right", "inner", "outer",
  "full", "cross", "lateral", "on", "using", "union", "intersect", "except", "window", "fetch", "for", "natural",
]);

/**
 * Replaces every {{ad_spend}} with the table expression, adopting an alias the writer put after the
 * token — `from {{ad_spend}} s` has to become one aliased table, not two. Without an alias the table
 * is called ad_spend.
 */
export function spliceAdSpend(sql: string, ads: AdDataset | null | undefined): string {
  if (!hasAdSpendToken(sql)) return sql;
  if (!ads || !ads.rows.length) throw new Error("This query joins {{ad_spend}}, but no ad spend has been uploaded. Ask the founder for an ad platform export, or write the query without it.");
  const values = adSpendValues(ads);
  return sql.replace(/\{\{ad_spend\}\}(\s+(?:as\s+)?([A-Za-z_][A-Za-z0-9_]*))?/gi, (_all, _tail, alias?: string) => {
    const name = alias && !NOT_AN_ALIAS.has(alias.toLowerCase()) ? alias : null;
    if (name) return `(values ${values}) as ${name}(${AD_SPEND_COLUMNS})`;
    // No alias of their own: keep the token's own trailing word (a keyword) after the table.
    const trailing = alias ? ` ${alias}` : "";
    return `(values ${values}) as ad_spend(${AD_SPEND_COLUMNS})${trailing}`;
  });
}

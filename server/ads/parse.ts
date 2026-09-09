import type { AdDataset, AdRow } from "../../shared/types.js";

/**
 * Parses an ad platform's own export into campaign-day spend.
 *
 * The founder downloads a report from Ads Manager or Google Ads and drops the file in. That path needs
 * no app registered with anyone, no API access review, and no credential: it is the same data the
 * platform would return over its API, exported by the person who owns it.
 *
 * Everything here exists because a real export broke it. Google puts its report title and date range
 * above the header row and a Total row below; Meta names the spend column after the currency and, when
 * the founder forgets the By Day breakdown, still ships a "Reporting starts" column that would silently
 * stamp a month of spend onto one day; UK and German accounts write 01/09/2026 and 1.240 meaning the
 * opposite of what a US account means. Where the file is ambiguous this refuses or says so rather than
 * guessing, because a wrong number here becomes a wrong cost per payer.
 */

const MAX_ROWS = 5000;

// ── column aliases (lowercased, punctuation-stripped) ────────────────────────
// Ad accounts export in the account's own language, so the columns that decide whether a file can be
// read at all carry their common translations. Anything beyond these still fails loudly, by name.
const CAMPAIGN = ["campaign name", "campaign", "campaign campaign", "kampagne", "kampagnenname", "campana", "nombre de la campana", "campagne", "nom de la campagne", "campanha", "nome da campanha", "campagna"];
const CAMPAIGN_ID = ["campaign id", "campaign identifier", "campaignid"];
const ADSET = ["ad set name", "adset name", "ad group", "ad group name"];
const AD = ["ad name"];
/** Exact only: a prefix match would let "Cost / conv." win when the founder removed the Cost column. */
const SPEND = ["amount spent", "spend", "cost", "total spent", "money spent", "amount",
  "ausgegebener betrag", "kosten", "betrag", "importe gastado", "coste", "costo", "gasto",
  "montant depense", "cout", "valor gasto", "custo", "importo speso"];
const DAY = ["day", "date", "date day", "reporting starts", "tag", "datum", "dia", "fecha", "jour", "giorno", "beginn der berichterstattung"];
/** A weekly or monthly export is a range per row, never a day. */
const PERIOD = ["week", "month", "week of", "month of"];
const DAY_END = ["reporting ends"];
const IMPRESSIONS = ["impressions", "impr", "impressionen", "impresiones", "impressoes", "impressioni"];
const CLICKS = ["link clicks", "clicks", "clicks all", "outbound clicks", "unique link clicks", "interactions", "klicks", "link klicks", "clics", "clics en el enlace", "cliques", "clic"];
const CONVERSIONS = ["results", "conversions", "purchases", "conv", "all conv", "website purchases", "leads"];
const RESULT_LABEL = ["result indicator", "result type"];
const CURRENCY_COL = ["currency code", "currency"];
const PLATFORM_HINT = ["platform", "publisher platform", "network", "ad network type"];

const norm = (s: string) =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\(.*?\)/g, " ").replace(/[^a-z0-9]+/g, " ").trim();

/** Exact alias match only. */
function findExact(headers: string[], aliases: string[]): number {
  const n = headers.map(norm);
  for (const a of aliases) { const i = n.indexOf(a); if (i >= 0) return i; }
  return -1;
}
/**
 * The spend column must match exactly, or match with only a currency code after it ("Cost USD").
 * A general prefix match would let "Cost / conv." win whenever the founder removed the Cost column,
 * and cost-per-conversion silently standing in for spend is a wrong number nobody would notice.
 */
function findSpendColumn(headers: string[]): number {
  const exact = findExact(headers, SPEND);
  if (exact >= 0) return exact;
  const n = headers.map(norm);
  for (const a of SPEND) {
    const i = n.findIndex((h) => new RegExp(`^${a} [a-z]{3}$`).test(h));
    if (i >= 0) return i;
  }
  return -1;
}

/** Exact first, then a prefix match. */
function findColumn(headers: string[], aliases: string[]): number {
  const exact = findExact(headers, aliases);
  if (exact >= 0) return exact;
  const n = headers.map(norm);
  for (const a of aliases) { const i = n.findIndex((h) => h.startsWith(a + " ")); if (i >= 0) return i; }
  return -1;
}

// ── CSV / TSV ────────────────────────────────────────────────────────────────
function detectDelimiter(text: string): string {
  const head = text.slice(0, 5000);
  const counts = [",", "\t", ";"].map((d) => ({ d, n: (head.match(new RegExp(`\\${d}`, "g")) ?? []).length }));
  counts.sort((a, b) => b.n - a.n);
  return counts[0].n > 0 ? counts[0].d : ",";
}

/** RFC4180-ish: quoted fields, doubled quotes, embedded delimiters and newlines. */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === delimiter) { row.push(field); field = ""; continue; }
    if (c === "\r") continue;
    if (c === "\n") { row.push(field); field = ""; rows.push(row); row = []; continue; }
    field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

// ── values ───────────────────────────────────────────────────────────────────
const CURRENCY_SYMBOL: Record<string, string> = { $: "USD", "£": "GBP", "€": "EUR", "¥": "JPY", "₹": "INR" };

/**
 * A lone separator before three digits is genuinely ambiguous: "1.234" is 1234 in Berlin and 1.234 in
 * Boston. It cannot be settled per cell, so it is settled once per FILE (see detectDecimalComma) and
 * passed down; otherwise a German export reads 1.240 as 1.24, a thousandfold error.
 */
export function parseNumber(raw: string, decimalComma = false): number | null {
  let s = (raw ?? "").trim();
  if (!s || /^(--|-|n\/?a|—)$/i.test(s)) return null;
  s = s.replace(/[^\d,.\-]/g, "");
  if (!s || s === "-") return null;
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) {
    if (lastComma > lastDot) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if (decimalComma) {
    s = lastComma >= 0 ? s.replace(/\./g, "").replace(",", ".") : s.replace(/\./g, "");
  } else if (lastComma >= 0) {
    s = /,\d{2}$/.test(s) ? s.replace(",", ".") : s.replace(/,/g, "");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** True when the file writes decimals with a comma, decided from every numeric-looking cell at once. */
export function detectDecimalComma(grid: string[][]): boolean {
  let comma = 0, dot = 0;
  for (const row of grid) {
    for (const cell of row) {
      const s = (cell ?? "").trim();
      if (!/\d/.test(s) || s.length > 24) continue;
      // Decimal evidence.
      if (/[.]\d{3}(?:[.]\d{3})*,\d+$/.test(s) || /^\D*\d+,\d{1,2}$/.test(s)) comma++;
      if (/[,]\d{3}(?:[,]\d{3})*\.\d+$/.test(s) || /^\D*\d+\.\d{1,2}$/.test(s)) dot++;
      // Grouping evidence: 1.240 or 1.240.500 with no decimal part means dots group thousands.
      if (/^\D*\d{1,3}(?:[.]\d{3})+$/.test(s)) comma++;
      if (/^\D*\d{1,3}(?:[,]\d{3})+$/.test(s)) dot++;
    }
  }
  return comma > dot;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n: number) => String(n).padStart(2, "0");

export type SlashOrder = "mdy" | "dmy" | "unknown";

/** `slashOrder` settles M/D vs D/M; it is decided once per column (see detectSlashOrder). */
export function parseDay(raw: string, slashOrder: SlashOrder = "mdy"): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
  m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (m && MONTHS[m[1].slice(0, 3).toLowerCase()]) return `${m[3]}-${pad(MONTHS[m[1].slice(0, 3).toLowerCase()])}-${pad(+m[2])}`;
  m = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})$/.exec(s);
  if (m && MONTHS[m[2].slice(0, 3).toLowerCase()]) return `${m[3]}-${pad(MONTHS[m[2].slice(0, 3).toLowerCase()])}-${pad(+m[1])}`;
  m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(s);
  if (m) {
    const a = +m[1], b = +m[2];
    if (a > 12 && b <= 12) return `${m[3]}-${pad(b)}-${pad(a)}`;
    if (b > 12 && a <= 12) return `${m[3]}-${pad(a)}-${pad(b)}`;
    if (slashOrder === "dmy") return `${m[3]}-${pad(b)}-${pad(a)}`;
    if (slashOrder === "mdy") return `${m[3]}-${pad(a)}-${pad(b)}`;
    return null; // ambiguous, and the column gave no evidence: refuse rather than guess
  }
  return null;
}

/** Reads a whole date column to settle M/D vs D/M, instead of deciding cell by cell. */
export function detectSlashOrder(values: string[]): SlashOrder {
  let firstOver12 = 0, secondOver12 = 0, slashed = 0;
  for (const v of values) {
    const m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec((v ?? "").trim());
    if (!m) continue;
    slashed++;
    if (+m[1] > 12) firstOver12++;
    if (+m[2] > 12) secondOver12++;
  }
  if (!slashed) return "mdy";
  if (firstOver12 && !secondOver12) return "dmy";
  if (secondOver12 && !firstOver12) return "mdy";
  return "unknown";
}

function detectPlatform(text: string, headers: string[], fallback?: string): string {
  const blob = (text.slice(0, 2000) + " " + headers.join(" ")).toLowerCase();
  if (/amount spent|ad set name|facebook|instagram|meta ads|reporting starts/.test(blob)) return "Meta";
  if (/impr\.|google ads|ad group|conv\. rate|campaign type|currency code/.test(blob)) return "Google Ads";
  if (/linkedin/.test(blob)) return "LinkedIn";
  if (/tiktok/.test(blob)) return "TikTok";
  if (/reddit/.test(blob)) return "Reddit";
  if (/twitter|x ads/.test(blob)) return "X";
  return fallback?.trim() || "Ads";
}

export interface ParseOptions { source?: string; platform?: string }

export function parseAdExport(text: string, opts: ParseOptions = {}): AdDataset {
  if (!text || !text.trim()) throw new Error("The file is empty.");
  if (/^PK/.test(text) || text.includes("[Content_Types].xml")) {
    throw new Error("That looks like an .xlsx workbook. Export as CSV (Ads Manager: Reports → Export table data → .csv; Google Ads: the download icon → .csv) and try again.");
  }
  const delimiter = detectDelimiter(text);
  const grid = parseDelimited(text, delimiter).filter((r) => r.some((c) => c.trim() !== ""));
  if (!grid.length) throw new Error("No rows could be read from that file.");

  const isHeader = (cells: string[]) => cells.length >= 2 && findSpendColumn(cells) >= 0 && (findColumn(cells, CAMPAIGN) >= 0 || findColumn(cells, DAY) >= 0 || findColumn(cells, PERIOD) >= 0);
  let headerIdx = -1;
  for (let i = 0; i < Math.min(grid.length, 15); i++) if (isHeader(grid[i])) { headerIdx = i; break; }
  if (headerIdx < 0) {
    const seen = (grid.find((r) => r.length > 1) ?? []).slice(0, 8).map((c) => c.trim()).filter(Boolean).join(", ");
    throw new Error(`No spend column was found. The export needs a cost or spend column and a campaign or date column; if your ad account exports in a language this does not know, rename the spend and campaign columns in the file and upload it again. First row read: ${seen || "(blank)"}.`);
  }

  const headers = grid[headerIdx].map((h) => h.trim());
  const notes: string[] = [];
  if (headerIdx > 0) notes.push(`Skipped ${headerIdx} title row(s) above the column headers.`);

  const iCampaign = findColumn(headers, CAMPAIGN);
  const iCampaignId = findExact(headers, CAMPAIGN_ID);
  const iAdset = findColumn(headers, ADSET);
  const iAd = findColumn(headers, AD);
  const iDay = findColumn(headers, DAY);
  const iPeriod = findColumn(headers, PERIOD);
  const iDayEnd = findColumn(headers, DAY_END);
  const iSpend = findSpendColumn(headers);
  const iImpr = findColumn(headers, IMPRESSIONS);
  const iClicks = findColumn(headers, CLICKS);
  const iConv = findColumn(headers, CONVERSIONS);
  const iResultLabel = findColumn(headers, RESULT_LABEL);
  const iCurrency = findExact(headers, CURRENCY_COL);
  const iPlatform = findColumn(headers, PLATFORM_HINT);

  const platform = detectPlatform(text, headers, opts.platform);
  // A second header row means two exports were concatenated; rows below it have a different shape.
  let body = grid.slice(headerIdx + 1);
  const secondHeader = body.findIndex(isHeader);
  if (secondHeader >= 0) {
    notes.push(`This file holds more than one export (a second header row appeared ${secondHeader} rows in). Only the first was read — upload each platform's export separately.`);
    body = body.slice(0, secondHeader);
  }

  const decimalComma = detectDecimalComma(body.slice(0, 200));
  const num = (v: string | undefined) => parseNumber(v ?? "", decimalComma);
  const slashOrder: SlashOrder = iDay >= 0 ? detectSlashOrder(body.slice(0, 400).map((r) => r[iDay] ?? "")) : "mdy";
  if (slashOrder === "unknown") {
    throw new Error("The dates are written like 01/09/2026 and nothing in this file says whether that is 1 September or 9 January. Re-export with ISO dates (2026-09-01) so the days cannot be months apart.");
  }

  const currencies = new Set<string>();
  for (const h of headers) { const m = /\(([A-Z]{3})\)/.exec(h); if (m) { currencies.add(m[1]); break; } }

  // Weekly or monthly exports are a range per row and must never be charted as days.
  let grain: "day" | "range" = "day";
  if (iDay < 0 && iPeriod >= 0) { grain = "range"; notes.push(`This export is bucketed by ${norm(headers[iPeriod])}, not by day: each row covers a period. It can total spend but cannot show a daily trend — re-export with a day breakdown for that.`); }

  let fallbackDay: string | null = null;
  if (iDay < 0 && iPeriod < 0) {
    for (let i = 0; i < headerIdx; i++) {
      const line = grid[i].join(" ");
      const m = /(\d{4}-\d{2}-\d{2}|[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})\s*[-–—to]+\s*(\d{4}-\d{2}-\d{2}|[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})/.exec(line);
      if (m) { fallbackDay = parseDay(m[1]); if (fallbackDay) { grain = "range"; notes.push(`The export has no per-day column, so every row is dated ${fallbackDay}, the first day of the report's range (${m[1]} to ${m[2]}). Totals are right; a daily trend is not available from this file, and any cost-per-outcome figure covers that whole range.`); } break; }
    }
    if (!fallbackDay) { grain = "range"; notes.push("The export has no per-day column and no date range in the file, so rows are dated by upload day. Re-export with a day breakdown before reading anything time-based."); }
  }

  interface Staged extends AdRow { resultLabel?: string }
  const parsed: Staged[] = [];
  let skippedNoSpend = 0, skippedNoDay = 0, totals = 0, rangeRows = 0;
  const resultLabels = new Set<string>();
  for (const cells of body) {
    const first = (cells[0] ?? "").trim();
    const campaignCell = (iCampaign >= 0 ? cells[iCampaign] ?? "" : "").trim();
    if (/^(total|totals|grand total|—|-)\b/i.test(first) || /^total\b/i.test(campaignCell)) { totals++; continue; }
    const spend = num(cells[iSpend]);
    if (spend == null) { if (cells.some((c) => c.trim())) skippedNoSpend++; continue; }

    let day: string | null;
    if (iDay >= 0) {
      day = parseDay(cells[iDay] ?? "", slashOrder);
      // "Reporting starts" with a different "Reporting ends" is a RANGE, not a day: without the By Day
      // breakdown Meta still ships the start column, which would stamp a whole month onto one date.
      if (iDayEnd >= 0 && day) { const end = parseDay(cells[iDayEnd] ?? "", slashOrder); if (end && end !== day) { rangeRows++; grain = "range"; } }
    } else day = fallbackDay ?? new Date().toISOString().slice(0, 10);
    if (!day) { skippedNoDay++; continue; }

    const row: Staged = {
      platform: (iPlatform >= 0 && cells[iPlatform]?.trim()) || platform,
      campaign: campaignCell || "(all campaigns)",
      day,
      spend: Math.round(spend * 100) / 100,
    };
    const campaignId = iCampaignId >= 0 ? (cells[iCampaignId] ?? "").trim() : "";
    if (campaignId) row.campaignId = campaignId;
    const impressions = iImpr >= 0 ? num(cells[iImpr]) : null;
    const clicks = iClicks >= 0 ? num(cells[iClicks]) : null;
    const conv = iConv >= 0 ? num(cells[iConv]) : null;
    if (impressions != null) row.impressions = impressions;
    if (clicks != null) row.clicks = clicks;
    if (conv != null) row.platformConversions = conv;
    if (iResultLabel >= 0 && cells[iResultLabel]?.trim()) resultLabels.add(cells[iResultLabel].trim());
    if (iCurrency >= 0 && cells[iCurrency]?.trim()) currencies.add(cells[iCurrency].trim().toUpperCase());
    parsed.push(row);
    if (parsed.length >= MAX_ROWS) { notes.push(`Only the first ${MAX_ROWS} rows were read.`); break; }
  }

  if (!parsed.length) throw new Error(`No spend rows could be read. ${skippedNoSpend} row(s) had no usable amount in the "${headers[iSpend]}" column.`);

  // A totals row whose label is not English slips past the word test; it is the row whose amount is
  // about the sum of all the others.
  const grand = parsed.reduce((a, r) => a + r.spend, 0);
  const suspect = parsed.findIndex((r) => r.spend > 0 && Math.abs(r.spend - (grand - r.spend)) / Math.max(r.spend, 1) < 0.01);
  let rows: Staged[] = parsed;
  if (suspect >= 0 && parsed.length > 2) {
    notes.push(`Dropped a row labelled "${parsed[suspect].campaign}" whose amount equals the sum of every other row: that is a totals row, not a campaign.`);
    rows = parsed.filter((_, i) => i !== suspect);
    totals++;
  }

  // An ad-level or ad-set-level export repeats a campaign-day; roll it up so keys are unique.
  const level: "campaign" | "adset" | "ad" = iAd >= 0 ? "ad" : iAdset >= 0 ? "adset" : "campaign";
  const byKey = new Map<string, AdRow>();
  for (const r of rows) {
    const key = `${r.platform} ${r.campaign} ${r.day}`;
    const seen = byKey.get(key);
    if (!seen) { byKey.set(key, { platform: r.platform, campaign: r.campaign, day: r.day, spend: r.spend, ...(r.campaignId ? { campaignId: r.campaignId } : {}), ...(r.impressions != null ? { impressions: r.impressions } : {}), ...(r.clicks != null ? { clicks: r.clicks } : {}), ...(r.platformConversions != null ? { platformConversions: r.platformConversions } : {}) }); continue; }
    seen.spend = Math.round((seen.spend + r.spend) * 100) / 100;
    if (r.impressions != null) seen.impressions = (seen.impressions ?? 0) + r.impressions;
    if (r.clicks != null) seen.clicks = (seen.clicks ?? 0) + r.clicks;
    if (r.platformConversions != null) seen.platformConversions = (seen.platformConversions ?? 0) + r.platformConversions;
    if (!seen.campaignId && r.campaignId) seen.campaignId = r.campaignId;
  }
  const finalRows = [...byKey.values()];
  if (level !== "campaign") notes.push(`This is an ${level}-level export; rows were added up to one per campaign per day.`);
  else if (finalRows.length < rows.length) notes.push(`${rows.length - finalRows.length} duplicate campaign-day row(s) were added together.`);

  if (rangeRows) notes.push(`${rangeRows} row(s) cover a date RANGE, not one day: this export was taken without the By Day breakdown. The totals are right, but every row is dated at the start of its range, so a daily trend from this file would be wrong. Re-export with Breakdown → Time → By Day.`);
  if (totals) notes.push(`Ignored ${totals} total row(s).`);
  if (skippedNoSpend) notes.push(`${skippedNoSpend} row(s) had no usable amount and were skipped.`);
  if (skippedNoDay) notes.push(`${skippedNoDay} row(s) had a date this parser could not read and were skipped.`);
  if (iCampaign < 0) notes.push("No campaign column: everything is grouped as one campaign, so spend cannot be split by audience.");
  if (iCampaignId < 0 && iCampaign >= 0) notes.push("No campaign ID column: spend can only be matched to accounts by campaign name, which breaks if a campaign was ever renamed. Add the campaign ID column and re-export for a durable match.");
  if (iClicks < 0 && iImpr < 0) notes.push("No clicks or impressions column: only spend is available from this export.");
  if (decimalComma) notes.push("Numbers were read with a comma decimal separator (1.234,56 = 1234.56), matching the rest of this file.");
  if (iConv >= 0) notes.push(`The platform's own conversion column ("${headers[iConv]}") was read, but it is the platform marking its own homework${resultLabels.size > 1 ? `, and its meaning changes per campaign (${[...resultLabels].slice(0, 3).join(", ")}), so those values must not be added up across campaigns` : ""}. It is never a signup or a payer.`);

  if (!currencies.size) {
    const blob = body.slice(0, 20).map((r) => r[iSpend] ?? "").join(" ");
    for (const [sym, code] of Object.entries(CURRENCY_SYMBOL)) if (blob.includes(sym)) { currencies.add(code); break; }
  }
  if (currencies.size > 1) notes.push(`This export mixes ${[...currencies].join(" and ")}. Amounts in different currencies must not be added together, and no ratio can be read from them until they are converted.`);
  const currency = currencies.size === 1 ? [...currencies][0] : "";
  if (!currency) notes.push(currencies.size > 1 ? "Because the currencies differ, the total below is not meaningful." : "The export does not name a currency, so amounts are plain numbers in whatever currency the ad account bills in.");

  const days = finalRows.map((r) => r.day).sort();
  return {
    rows: finalRows,
    currency,
    source: opts.source?.slice(0, 120) || "pasted",
    uploadedAt: new Date().toISOString(),
    platforms: [...new Set(finalRows.map((r) => r.platform))],
    firstDay: days[0],
    lastDay: days[days.length - 1],
    totalSpend: Math.round(finalRows.reduce((a, r) => a + r.spend, 0) * 100) / 100,
    grain,
    notes,
  };
}

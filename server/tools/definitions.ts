import type { Tool } from "../llm/client.js";
import { AD_SPEND_COLUMNS } from "../ads/spendSql.js";
import { bindingCatalog } from "../stats/readiness.js";

const STAGES = ["s0", "s1", "s2", "s3", "s4", "s5", "s6"];

export function toolsFor(opts: { db: boolean; github: boolean; ads: boolean }): Tool[] {
  const tools: Tool[] = [
    {
      type: "function",
      function: {
        name: "update_todos",
        description:
          "Add, change, remove or reorder items on the founder's what-to-do list (shown in a side panel; each item later gets a coding-agent prompt). Keep 3–7 active items. Titles are concrete actions. Never change an item's status unless the founder said it happened.",
        parameters: {
          type: "object",
          properties: {
            ops: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  op: { type: "string", enum: ["add", "update", "remove", "reorder"] },
                  id: { type: "string", description: "Existing item id (for update / remove)" },
                  ids: { type: "array", items: { type: "string" }, description: "Full new order of item ids (for reorder)" },
                  title: { type: "string", description: "Concrete action, at most 90 characters" },
                  why: { type: "string", description: "One or two sentences: why this, for this product, now" },
                  stage: { type: "string", enum: STAGES, description: "Journey stage the item belongs to" },
                  principle: { type: "string", description: "Principle id it leans on (p-*)" },
                  evidence: { type: "array", items: { type: "string" }, description: "Brain ids that back it: e-NN, t-NN, law-*, b-*, k-NN, a-*, pr-*, or metric ids" },
                  status: { type: "string", enum: ["todo", "doing", "done", "dismissed"] },
                },
                required: ["op"],
              },
            },
          },
          required: ["ops"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "fetch_page",
        description: "Fetch and read one public web page (their pricing page, signup flow, docs…). Returns title, headings, calls to action, prices, forms and text.",
        parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
      },
    },
  ];
  if (opts.ads) {
    tools.push({
      type: "function",
      function: {
        name: "read_ad_spend",
        description:
          "Read the ad spend the founder uploaded from their ad platform's own export. Use it to learn what campaigns exist, what was spent and over what dates, before binding cost_per_activated or gross_ltv. The platform's own conversion counts are its own attribution — never treat them as signups or payers; the founder's database is the source for outcomes. To relate spend to outcomes, read the campaign names here, then query the founder's database for the accounts whose attribution fields match them.",
        parameters: {
          type: "object",
          properties: {
            groupBy: { type: "string", enum: ["campaign", "platform", "day", "none"], description: "Default campaign" },
            measure: { type: "string", enum: ["spend", "impressions", "clicks", "platform_conversions"], description: "Default spend" },
            since: { type: "string", description: "Inclusive YYYY-MM-DD" },
            until: { type: "string", description: "Inclusive YYYY-MM-DD" },
            platform: { type: "string" },
          },
        },
      },
    });
  }
  if (opts.db) {
    tools.push({
      type: "function",
      function: {
        name: "update_scoreboard",
        description:
          `Build or change the founder's scoreboard: the brain's metric recipes bound to THEIR tables, run by the server, graded against the journey's readiness checks, and shown in a side panel. Set goal / activation / coreRequest and the IANA timezone the first time (the timezone is required: today is dropped and days are bucketed on it). Each stat has a kind with a strict SQL contract:
number: one row with a numeric column "value" (optional "n"). Unit percent always means a 0–1 fraction (0.083, not 8.3), for every kind.
Any SQL above may contain the token {{ad_spend}} where a table belongs: the server substitutes the uploaded ad rows as a table (${AD_SPEND_COLUMNS}). That is how cost per payer BY CAMPAIGN is built — one breakdown stat joining spend to the accounts whose attribution carries the campaign, returning label = campaign, value = spend ÷ payers, n = the payer count so the honesty rules can bite. Total the spend per campaign in a subquery BEFORE joining, or the join multiplies spend by the number of matching accounts. Never type the spend numbers yourself.
ads: no SQL. Aggregates the founder's uploaded ad spend: set ads.measure (spend/impressions/clicks/platform_conversions) and optionally ads.groupBy (campaign → breakdown, platform → breakdown, day → series; omit for a total), ads.since/ads.until, ads.platform, ads.campaignContains.
derived: no SQL. One stat divided by another: derived.numeratorStatId ÷ derived.denominatorStatId. This is how cost per payer and cost per activated user are built, because spend lives in the uploaded export and the outcome lives in the database, so no single query can hold both. Match the periods: give the ads stat the same since/until as the outcome query covers, or the ratio is meaningless.
rate: one row with integer columns "numerator" and "denominator" (the server computes the share and applies the small-n rule).
series: rows "day" (date) and "value", ascending, one per calendar day in the reporting timezone (the server drops today).
funnel: rows "step" (text) and "count", one per step in path order, first step = the widest.
breakdown: rows "label" and "value"; with unit percent, "n" (the denominator) is REQUIRED so the small-n rule can be applied.
assert: no SQL; a value the founder stated, with source. Shown as stated, never as measured.
Rules for every SQL: name the reporting timezone (AT TIME ZONE '<tz>'); day zero is the signup's calendar day in that zone; exclude internal accounts and bots where the schema lets you; never quote a share the small-n rule forbids (the server marks it). Bind metricId and field to the catalog below so readiness is graded; results and errors come back to you at once, so fix a failing stat in the same turn. Keep 4 to 12 stats: the money event first, then activation, then the stage's instrument_now list.
${bindingCatalog()}`,
        parameters: {
          type: "object",
          properties: {
            goal: { type: "string", description: "The money event, in the founder's words (set once, update when it changes)" },
            path: { type: "string", description: "Id of the funnel stat whose steps are the path from signup to the goal, in order; leaks are read between its steps" },
            activation: { type: "string", description: "What activated means for this product" },
            coreRequest: { type: "string", description: "What a core request is here" },
            timezone: { type: "string", description: "IANA reporting timezone, e.g. America/New_York" },
            ops: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  op: { type: "string", enum: ["add", "update", "remove", "reorder"] },
                  id: { type: "string", description: "Existing stat id (update / remove)" },
                  ids: { type: "array", items: { type: "string" }, description: "Full new order (reorder)" },
                  title: { type: "string" },
                  kind: { type: "string", enum: ["number", "rate", "series", "funnel", "breakdown", "assert", "ads", "derived"] },
                  unit: { type: "string", enum: ["percent", "count", "usd", "minutes", "days", "score"] },
                  sql: { type: "string" },
                  ads: {
                    type: "object",
                    description: "ads kind only",
                    properties: {
                      measure: { type: "string", enum: ["spend", "impressions", "clicks", "platform_conversions"] },
                      groupBy: { type: "string", enum: ["campaign", "platform", "day"] },
                      platform: { type: "string" },
                      since: { type: "string" },
                      until: { type: "string" },
                      campaignContains: { type: "string" },
                    },
                    required: ["measure"],
                  },
                  derived: {
                    type: "object",
                    description: "derived kind only",
                    properties: {
                      numeratorStatId: { type: "string" },
                      denominatorStatId: { type: "string" },
                      op: { type: "string", enum: ["divide"] },
                    },
                    required: ["numeratorStatId", "denominatorStatId"],
                  },
                  metricId: { type: "string" },
                  field: { type: "string" },
                  why: { type: "string", description: "One plain sentence for a non-technical founder: what this number means for them. No metric ids, column names or stage ids here." },
                  caveat: { type: "string" },
                  stage: { type: "string", enum: STAGES },
                  value: { type: "number", description: "assert only" },
                  source: { type: "string", description: "assert only: who said it and when" },
                },
                required: ["op"],
              },
            },
          },
          required: ["ops"],
        },
      },
    });
    tools.push(
      {
        type: "function",
        function: {
          name: "run_sql",
          description:
            `Run one read-only SQL statement (SELECT / WITH / EXPLAIN) against the founder's Postgres database. Rows are capped at 200. Prefer aggregates with explicit date boundaries; name the timezone (e.g. AT TIME ZONE 'America/New_York'); exclude today from daily series.\nWhen ad spend has been uploaded you may write the token {{ad_spend}} anywhere a table belongs; the server replaces it with the uploaded rows as a table (${AD_SPEND_COLUMNS}), so spend can be joined to the accounts whose attribution column carries the campaign. Never type the spend numbers yourself.`,
          parameters: {
            type: "object",
            properties: {
              sql: { type: "string" },
              purpose: { type: "string", description: "What this query is meant to show, in one sentence" },
            },
            required: ["sql", "purpose"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "db_describe_table",
          description: "List every column of one table (for tables the schema summary only named).",
          parameters: { type: "object", properties: { table: { type: "string", description: "schema.table or table" } }, required: ["table"] },
        },
      },
    );
  }
  if (opts.github) {
    tools.push(
      {
        type: "function",
        function: {
          name: "github_read_file",
          description: "Read one file from the connected repository (default branch unless ref is given). Use it before recommending changes to signup, pricing, checkout, limits or tracking code.",
          parameters: { type: "object", properties: { path: { type: "string" }, ref: { type: "string" } }, required: ["path"] },
        },
      },
      {
        type: "function",
        function: {
          name: "github_search_files",
          description: "Find files whose path contains every given term (space-separated), e.g. 'stripe webhook' or 'pricing'.",
          parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        },
      },
      {
        type: "function",
        function: {
          name: "github_list_commits",
          description: "List commits on the default branch, optionally within a date range or touching one path. Use it to learn what shipped recently and when.",
          parameters: {
            type: "object",
            properties: {
              since: { type: "string", description: "ISO date" },
              until: { type: "string", description: "ISO date" },
              path: { type: "string" },
              limit: { type: "integer", minimum: 1, maximum: 100 },
            },
          },
        },
      },
    );
  }
  return tools;
}

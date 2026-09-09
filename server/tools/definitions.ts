import type { Tool } from "../llm/client.js";
import { bindingCatalog } from "../stats/readiness.js";

const STAGES = ["s0", "s1", "s2", "s3", "s4", "s5", "s6"];

export function toolsFor(opts: { db: boolean; github: boolean }): Tool[] {
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
  if (opts.db) {
    tools.push({
      type: "function",
      function: {
        name: "update_scoreboard",
        description:
          `Build or change the founder's scoreboard: the brain's metric recipes bound to THEIR tables, run by the server, graded against the journey's readiness checks, and shown in a side panel. Set goal / activation / coreRequest / timezone the first time. Each stat has a kind with a strict SQL contract:
number: one row with a numeric column "value" (optional "n").
rate: one row with integer columns "numerator" and "denominator" (the server computes the share and applies the small-n rule).
series: rows "day" (date) and "value", ascending, one per calendar day in the reporting timezone (the server drops today).
funnel: rows "step" (text) and "count", one per step in path order, first step = the widest.
breakdown: rows "label" and "value" (optional "n").
assert: no SQL; a value the founder stated, with source. Shown as stated, never as measured.
Rules for every SQL: name the reporting timezone (AT TIME ZONE '<tz>'); day zero is the signup's calendar day in that zone; exclude internal accounts and bots where the schema lets you; never quote a share the small-n rule forbids (the server marks it). Bind metricId and field to the catalog below so readiness is graded; results and errors come back to you at once, so fix a failing stat in the same turn. Keep 4 to 12 stats: the money event first, then activation, then the stage's instrument_now list.
${bindingCatalog()}`,
        parameters: {
          type: "object",
          properties: {
            goal: { type: "string", description: "The money event, in the founder's words (set once, update when it changes)" },
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
                  kind: { type: "string", enum: ["number", "rate", "series", "funnel", "breakdown", "assert"] },
                  unit: { type: "string", enum: ["percent", "count", "usd", "minutes", "days", "score"] },
                  sql: { type: "string" },
                  metricId: { type: "string" },
                  field: { type: "string" },
                  why: { type: "string", description: "Why this number matters for this product now, and what it is bound to (tables, events, files)" },
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
            "Run one read-only SQL statement (SELECT / WITH / EXPLAIN) against the founder's Postgres database. Rows are capped at 200. Prefer aggregates with explicit date boundaries; name the timezone (e.g. AT TIME ZONE 'America/New_York'); exclude today from daily series.",
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

// Types shared by the server and the web client. The client is the only store
// (there are no accounts): every request carries the session state it needs.

export type StageId = "s0" | "s1" | "s2" | "s3" | "s4" | "s5" | "s6";

export type Confidence =
  | "deploy" | "holdout" | "correlation" | "quasi-experiment"
  | "measurement" | "confounded" | "benchmark" | "replay";

export type TodoStatus = "todo" | "doing" | "done" | "dismissed";

export interface Todo {
  id: string;
  title: string;
  /** One or two plain sentences: why this, for this product, now. */
  why: string;
  stage: StageId;
  /** Principle id (p-*) the item leans on. */
  principle?: string;
  /** Brain ids that back the item: e-NN, t-NN, law-*, b-*, k-NN, a-*, pr-*, metric ids. */
  evidence: string[];
  status: TodoStatus;
  order: number;
  /** Crafted coding-agent prompt (written by the prompt model). */
  prompt?: string;
  promptModel?: string;
  /** True when the item changed after its prompt was written. */
  promptStale?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SiteForm { action?: string; method?: string; fields: string[] }

export interface SitePage {
  url: string;
  status: number;
  title: string;
  description?: string;
  headings: string[];
  ctas: string[];
  prices: string[];
  forms: SiteForm[];
  text: string;
  kind: "home" | "pricing" | "signup" | "login" | "features" | "docs" | "about" | "faq" | "demo" | "checkout" | "other";
}

export interface SiteDigest {
  url: string;
  origin: string;
  domain: string;
  scannedAt: string;
  pages: SitePage[];
  stack: string[];
  notes: string[];
}

/** Supabase link obtained through OAuth: the Management API token runs read-only SQL on one project. */
export interface SupabaseLink { accessToken: string; refreshToken?: string; expiresAt?: number; projectRef: string; projectName?: string; orgName?: string }
export interface PostgresConnection { connectionString?: string; supabase?: SupabaseLink }
export interface GithubConnection { repo: string; token?: string; login?: string; via?: "oauth" | "pat" }
export interface GithubRepoItem { fullName: string; private: boolean; pushedAt?: string; description?: string; language?: string }
export interface SupabaseProjectItem { ref: string; name: string; region?: string; status?: string; orgName?: string }
export type OAuthRelay =
  | { type: "vd:oauth"; provider: "github"; ok: true; github: { token: string; login: string } }
  | { type: "vd:oauth"; provider: "supabase"; ok: true; supabase: { accessToken: string; refreshToken?: string; expiresAt?: number } }
  | { type: "vd:oauth"; provider: "github" | "supabase"; ok: false; error: string };
export interface Connections { postgres?: PostgresConnection; github?: GithubConnection }

export interface DbColumn { name: string; type: string; nullable: boolean }
export interface DbTable {
  schema: string;
  name: string;
  /** Planner estimate from pg_stat_user_tables; exact for auth.users when readable. */
  rows: number | null;
  columns: DbColumn[];
  timeColumns: string[];
}
export interface DbSchema {
  introspectedAt: string;
  tables: DbTable[];
  /** Compact text used in the model context. */
  summary: string;
  authUsers?: number | null;
}

export interface RepoCommit { sha: string; date: string; message: string; author?: string }
export interface RepoDigest {
  repo: string;
  defaultBranch: string;
  description?: string;
  language?: string;
  pushedAt?: string;
  isPrivate?: boolean;
  stack: string[];
  readme?: string;
  manifest?: string;
  manifestPath?: string;
  interestingFiles: string[];
  fileCount: number;
  treeTruncated?: boolean;
  recentCommits: RepoCommit[];
  commitsByWeek: { week: string; count: number }[];
  /** Live URLs named by the manifest or README, best first; used to scan the site when the audit starts from a repo. */
  siteCandidates: string[];
  fetchedAt: string;
}

// ── Scoreboard: the brain's metric recipes bound to the founder's own tables ──────────────────
/**
 * number    one row: value (numeric), optional n (count basis)
 * rate      one row: numerator, denominator (integers) — the server computes the share and applies the small-n rule
 * series    rows: day (YYYY-MM-DD), value — ascending; the server drops today in the reporting timezone
 * funnel    rows: step (text), count — in path order; per-step conversion is computed
 * breakdown rows: label (text), value (numeric), optional n
 * assert    no SQL: a value the founder stated in conversation (shown as stated, never as measured)
 */
export type StatKind = "number" | "rate" | "series" | "funnel" | "breakdown" | "assert";
export type StatUnit = "percent" | "count" | "usd" | "minutes" | "days" | "score";

export interface StatSpec {
  id: string;
  title: string;
  kind: StatKind;
  unit: StatUnit;
  /** SQL following the kind's contract. Absent for assert. */
  sql?: string;
  /** Brain metric recipe this implements (metrics[].id), when it does. */
  metricId?: string;
  /** Readiness field this stat measures (journey[].readiness[].check.field), when it does. */
  field?: string;
  /** One or two sentences: why this number matters for this product now, and what it is bound to (tables, events, files). */
  why: string;
  caveat?: string;
  stage?: StageId;
  order: number;
  /** assert only */
  value?: number;
  source?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StatResult {
  specId: string;
  ok: boolean;
  error?: string;
  computedAt: string;
  ms?: number;
  /** number / rate / assert */
  value?: number;
  n?: number;
  numerator?: number;
  denominator?: number;
  /** true when the small-n rule forbids quoting the share as a percentage */
  smallN?: boolean;
  /** series */
  points?: { day: string; value: number }[];
  droppedToday?: boolean;
  /** funnel: a conversion is present only when the small-n rule allows quoting it (step ≥ 5, previous ≥ 100) */
  steps?: { step: string; count: number; fromPrev?: number; fromFirst?: number; smallN?: boolean }[];
  /** breakdown: smallN is set for percent items whose n (or k = value·n) is too small to quote */
  items?: { label: string; value: number; n?: number; smallN?: boolean }[];
  /** Honest caveats the server attached (multi-row results used row 1, steps not monotone, truncation…). */
  notes?: string[];
}

export interface Scoreboard {
  /** The money event this product is judged by, in the founder's words. */
  goal?: string;
  /** What "activated" means for this product. */
  activation?: string;
  /** What a core request is here. */
  coreRequest?: string;
  /** Reporting timezone (IANA), used by the server to drop today from series. */
  timezone?: string;
  stats: StatSpec[];
  results: Record<string, StatResult>;
  computedAt?: string;
}

export type ReadinessStatus = "pass" | "fail" | "unmeasured" | "small_n" | "stated";
export interface ReadinessRow {
  stage: StageId;
  metric: string;
  field: string;
  op: string;
  value: number;
  threshold: string;
  note?: string;
  status: ReadinessStatus;
  actual?: number;
  /** counts behind a rate, so a small-n row can show them instead of a share */
  numerator?: number;
  denominator?: number;
  /** the value was stated by the founder, not measured */
  stated?: boolean;
  statId?: string;
}
export interface ScoreboardEval {
  /** Earliest stage with an unmet or unmeasured readiness check; null when nothing is measured yet. */
  stageByNumbers: StageId | null;
  rows: ReadinessRow[];
  /** Per stage, the instrument_now metric ids with no bound stat. */
  unbound: Record<string, string[]>;
  measuredCount: number;
}

export interface Usage { promptHit: number; promptMiss: number; completion: number; reasoning?: number }
export interface CostEvent { model: string; usage: Usage; usd: number; at: string; kind: "chat" | "prompts" }

export interface ToolUi {
  name: string;
  ok: boolean;
  summary: string;
  error?: string;
  sql?: string;
  columns?: string[];
  rows?: Record<string, unknown>[];
  rowCount?: number;
  truncated?: boolean;
  url?: string;
  path?: string;
  commits?: RepoCommit[];
  files?: string[];
  ms?: number;
}

export interface ToolCall { id: string; type: "function"; function: { name: string; arguments: string } }

export type TranscriptMessage =
  | { role: "user"; content: string; at?: string; hidden?: boolean }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[]; at?: string }
  | { role: "tool"; tool_call_id: string; name: string; content: string; ui?: ToolUi };

export type ChatEvent =
  | { type: "delta"; text: string }
  | { type: "tool_start"; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; id: string; name: string; ui: ToolUi }
  | { type: "todos"; todos: Todo[] }
  | { type: "scoreboard"; scoreboard: Scoreboard; eval: ScoreboardEval }
  | { type: "usage"; cost: CostEvent }
  | { type: "done"; messages: TranscriptMessage[]; todos: Todo[]; scoreboard?: Scoreboard }
  | { type: "error"; message: string };

export interface ChatRequest {
  /** null when the audit started from a repository and no live site was found. */
  site: SiteDigest | null;
  connections?: Connections;
  schema?: DbSchema | null;
  repo?: RepoDigest | null;
  todos: Todo[];
  scoreboard?: Scoreboard | null;
  transcript: TranscriptMessage[];
  message: string;
  /** First turn after the scan: the server supplies the opening instruction. */
  kickoff?: boolean;
  clientTime?: string;
  /** The founder's own local date and zone, so the model never reasons in UTC on their behalf. */
  clientDate?: string;
  clientTimezone?: string;
}

export interface PromptsRequest {
  site: SiteDigest | null;
  schema?: DbSchema | null;
  repo?: RepoDigest | null;
  todos: Todo[];
  scoreboard?: Scoreboard | null;
  transcript: TranscriptMessage[];
  /** Subset to (re)write; defaults to every active item without a fresh prompt. */
  todoIds?: string[];
}

export interface PromptsResponse {
  prompts: { todoId: string; prompt: string }[];
  cost: CostEvent;
  model: string;
  skipped?: string[];
}

export interface HealthResponse {
  ok: boolean;
  brainVersion: string;
  brainTokensApprox: number;
  chat: { configured: boolean; model: string; thinking: "on" | "off" };
  prompts: { configured: boolean; model: string; thinking: "on" | "off"; thinkingBudget: number };
  accessCodeRequired: boolean;
  /** Which OAuth brokers this server has client credentials for. */
  oauth: { github: boolean; supabase: boolean; /** public id, used to link to GitHub's "grant organization access" page */ githubClientId?: string };
  budget: { dailyUsd: number; spentTodayUsd: number };
}

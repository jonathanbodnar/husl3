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

export interface PostgresConnection { connectionString: string }
export interface GithubConnection { repo: string; token?: string }
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
  fetchedAt: string;
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
  | { type: "usage"; cost: CostEvent }
  | { type: "done"; messages: TranscriptMessage[]; todos: Todo[] }
  | { type: "error"; message: string };

export interface ChatRequest {
  site: SiteDigest;
  connections?: Connections;
  schema?: DbSchema | null;
  repo?: RepoDigest | null;
  todos: Todo[];
  transcript: TranscriptMessage[];
  message: string;
  /** First turn after the scan: the server supplies the opening instruction. */
  kickoff?: boolean;
  clientTime?: string;
}

export interface PromptsRequest {
  site: SiteDigest;
  schema?: DbSchema | null;
  repo?: RepoDigest | null;
  todos: Todo[];
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
  budget: { dailyUsd: number; spentTodayUsd: number };
}

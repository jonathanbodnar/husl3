import type { RepoCommit, RepoDigest } from "../../shared/types.js";

const API = "https://api.github.com";
const UA = "VibeDistributionAudit/0.1 (+https://github.com/jonathanbodnar/husl3)";

export function parseRepo(input: string): string {
  const t = input.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  const m = t.match(/github\.com[/:]([\w.-]+)\/([\w.-]+)/i) ?? t.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (!m) throw new Error("Give the repository as owner/name or a github.com URL");
  return `${m[1]}/${m[2]}`;
}

async function gh<T = unknown>(path: string, token?: string, raw = false): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: {
      accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
      "user-agent": UA,
      "x-github-api-version": "2022-11-28",
      ...(token ? { authorization: `Bearer ${token.trim()}` } : {}),
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 404) throw new Error(`GitHub: not found (${path.split("?")[0]}). Private repositories need a token with repo read access.`);
  if (res.status === 401) throw new Error("GitHub: the token was rejected");
  if (res.status === 403 || res.status === 429) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    throw new Error(remaining === "0" ? "GitHub: rate limit reached (add a token to raise it)" : `GitHub: forbidden (${res.status})`);
  }
  if (!res.ok) throw new Error(`GitHub: HTTP ${res.status} for ${path.split("?")[0]}`);
  return (raw ? await res.text() : await res.json()) as T;
}

const INTERESTING = /(pric|plan|billing|checkout|stripe|paddle|lemon|subscri|paywall|upgrade|limit|quota|credit|usage|entitle|signup|sign-up|sign_up|register|onboard|welcome|first-run|getting-started|login|sign-in|signin|auth|analytics|track|event|telemetry|posthog|gtag|segment|mixpanel|metric|funnel|email|resend|sendgrid|postmark|mailer|referr|invite|share|trial|cancel|churn|retention|notification|push|cron|webhook|landing|hero|cta|middleware|feature-flag|experiment)/i;
const CODE_EXT = /\.(tsx?|jsx?|mjs|cjs|vue|svelte|astro|py|rb|go|rs|java|kt|php|cs|sql|prisma|graphql|ex|exs|swift|dart|html|md)$/i;
const EXCLUDE = /(^|\/)(node_modules|vendor|dist|build|out|\.next|\.nuxt|coverage|__tests__|__snapshots__|__mocks__|fixtures|e2e|\.git|public|static|assets|locales?)\/|(^|\/|[-_.])(tests?|specs?)(\/|[-_.])|\.(test|spec|stories)\.|\.d\.ts$/i;

const STACK_DEPS: [RegExp, string][] = [
  [/^next$/, "Next.js"], [/^react$/, "React"], [/^vue$/, "Vue"], [/^nuxt$/, "Nuxt"], [/^svelte$|^@sveltejs\/kit$/, "SvelteKit"], [/^astro$/, "Astro"], [/^@remix-run\//, "Remix"],
  [/^express$/, "Express"], [/^hono$/, "Hono"], [/^fastify$/, "Fastify"], [/^@nestjs\//, "NestJS"], [/^koa$/, "Koa"],
  [/^stripe$|^@stripe\//, "Stripe"], [/^@paddle\//, "Paddle"], [/^@lemonsqueezy\//, "Lemon Squeezy"], [/^@polar-sh\//, "Polar"],
  [/^@supabase\//, "Supabase"], [/^firebase$|^firebase-admin$/, "Firebase"], [/^@prisma\/client$|^prisma$/, "Prisma"], [/^drizzle-orm$/, "Drizzle"], [/^mongoose$|^mongodb$/, "MongoDB"], [/^pg$|^postgres$/, "Postgres driver"],
  [/^@clerk\//, "Clerk"], [/^next-auth$|^@auth\//, "Auth.js"], [/^@auth0\//, "Auth0"], [/^lucia$/, "Lucia"],
  [/^posthog-js$|^posthog-node$/, "PostHog"], [/^mixpanel/, "Mixpanel"], [/^@segment\//, "Segment"], [/^@amplitude\//, "Amplitude"], [/^@vercel\/analytics$/, "Vercel Analytics"], [/^plausible-tracker$/, "Plausible"],
  [/^resend$/, "Resend"], [/^@sendgrid\//, "SendGrid"], [/^postmark$/, "Postmark"], [/^nodemailer$/, "Nodemailer"], [/^@react-email\//, "React Email"],
  [/^@sentry\//, "Sentry"], [/^tailwindcss$/, "Tailwind CSS"], [/^@capacitor\//, "Capacitor"], [/^electron$/, "Electron"], [/^expo$/, "Expo"], [/^react-native$/, "React Native"],
  [/^openai$/, "OpenAI SDK"], [/^@anthropic-ai\//, "Anthropic SDK"], [/^ai$/, "Vercel AI SDK"], [/^langchain$|^@langchain\//, "LangChain"], [/^@google\/generative-ai$/, "Gemini SDK"],
  [/^@upstash\//, "Upstash"], [/^ioredis$|^redis$/, "Redis"], [/^bullmq$/, "BullMQ"], [/^inngest$/, "Inngest"], [/^@trigger\.dev\//, "Trigger.dev"],
  [/^onesignal|^react-onesignal$/, "OneSignal"], [/^@intercom\//, "Intercom"], [/^@crisp/, "Crisp"],
];

interface TreeEntry { path: string; type: string; size?: number }
const treeCache = new Map<string, { at: number; paths: string[]; truncated: boolean }>();

async function tree(repo: string, branch: string, token?: string): Promise<{ paths: string[]; truncated: boolean }> {
  const key = `${repo}@${branch}`;
  const hit = treeCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit;
  const data = await gh<{ tree: TreeEntry[]; truncated: boolean }>(`/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`, token);
  const paths = (data.tree ?? []).filter((e) => e.type === "blob").map((e) => e.path);
  const entry = { at: Date.now(), paths, truncated: !!data.truncated };
  treeCache.set(key, entry);
  return entry;
}

function stackFromManifest(path: string, text: string): string[] {
  const out = new Set<string>();
  if (path.endsWith("package.json")) {
    try {
      const j = JSON.parse(text);
      const deps = Object.keys({ ...(j.dependencies ?? {}), ...(j.devDependencies ?? {}) });
      for (const d of deps) for (const [re, name] of STACK_DEPS) if (re.test(d)) out.add(name);
      if (j.scripts?.dev?.includes("vite") || deps.includes("vite")) out.add("Vite");
    } catch { /* ignore */ }
  } else if (/requirements\.txt|pyproject\.toml|Pipfile/.test(path)) {
    out.add("Python");
    for (const [re, name] of [[/django/i, "Django"], [/fastapi/i, "FastAPI"], [/flask/i, "Flask"], [/stripe/i, "Stripe"], [/supabase/i, "Supabase"], [/sqlalchemy/i, "SQLAlchemy"], [/celery/i, "Celery"]] as [RegExp, string][]) if (re.test(text)) out.add(name);
  } else if (path.endsWith("Gemfile")) { out.add("Ruby"); if (/rails/i.test(text)) out.add("Rails"); if (/stripe/i.test(text)) out.add("Stripe"); }
  else if (path.endsWith("go.mod")) out.add("Go");
  else if (path.endsWith("composer.json")) { out.add("PHP"); if (/laravel/i.test(text)) out.add("Laravel"); if (/stripe/i.test(text)) out.add("Stripe"); }
  else if (path.endsWith("Cargo.toml")) out.add("Rust");
  return [...out];
}

export async function introspectRepo(input: string, token?: string): Promise<RepoDigest> {
  const repo = parseRepo(input);
  const meta = await gh<{ default_branch: string; description: string | null; language: string | null; pushed_at: string; private: boolean }>(`/repos/${repo}`, token);
  const branch = meta.default_branch;
  const [t, readme, commits] = await Promise.all([
    tree(repo, branch, token),
    gh<string>(`/repos/${repo}/readme`, token, true).catch(() => ""),
    gh<{ sha: string; commit: { message: string; author?: { date?: string; name?: string } }; author?: { login?: string } }[]>(`/repos/${repo}/commits?sha=${encodeURIComponent(branch)}&per_page=100`, token).catch(() => []),
  ]);
  const manifestPath = ["package.json", "pyproject.toml", "requirements.txt", "Gemfile", "go.mod", "composer.json", "Cargo.toml", "Pipfile"].find((m) => t.paths.includes(m))
    ?? t.paths.find((p) => /^(apps|packages|frontend|web|app|client|server|api)\/[^/]+\/package\.json$/.test(p) || /^(frontend|web|app|client|server|api)\/package\.json$/.test(p));
  let manifest: string | undefined;
  if (manifestPath) manifest = await gh<string>(`/repos/${repo}/contents/${encodePath(manifestPath)}?ref=${encodeURIComponent(branch)}`, token, true).catch(() => undefined);
  const stack = manifest && manifestPath ? stackFromManifest(manifestPath, manifest) : [];
  const interesting = t.paths
    .filter((p) => CODE_EXT.test(p) && !EXCLUDE.test(p) && INTERESTING.test(p))
    .map((p) => ({ p, score: (p.match(INTERESTING) ? 2 : 0) + (/(pric|checkout|billing|stripe|signup|onboard|paywall|limit|track|event|analytics)/i.test(p) ? 3 : 0) - p.split("/").length * 0.1 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 80)
    .map((x) => x.p);
  const recent: RepoCommit[] = commits.map((c) => ({
    sha: c.sha.slice(0, 7),
    date: c.commit.author?.date ?? "",
    message: (c.commit.message ?? "").split("\n")[0].slice(0, 160),
    author: c.author?.login ?? c.commit.author?.name,
  }));
  const byWeek = new Map<string, number>();
  for (const c of recent) { if (!c.date) continue; const w = isoWeek(new Date(c.date)); byWeek.set(w, (byWeek.get(w) ?? 0) + 1); }
  return {
    repo,
    defaultBranch: branch,
    description: meta.description ?? undefined,
    language: meta.language ?? undefined,
    pushedAt: meta.pushed_at,
    isPrivate: meta.private,
    stack,
    readme: readme ? readme.slice(0, 8000) : undefined,
    manifest: manifest ? manifest.slice(0, 6000) : undefined,
    manifestPath,
    interestingFiles: interesting,
    fileCount: t.paths.length,
    treeTruncated: t.truncated,
    recentCommits: recent.slice(0, 60),
    commitsByWeek: [...byWeek.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([week, count]) => ({ week, count })),
    fetchedAt: new Date().toISOString(),
  };
}

function encodePath(p: string) { return p.split("/").map(encodeURIComponent).join("/"); }

function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const w = Math.ceil(((t.getTime() - y0.getTime()) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(w).padStart(2, "0")}`;
}

export async function readFile(repo: string, path: string, ref: string | undefined, token?: string): Promise<{ path: string; content: string; truncated: boolean; size: number }> {
  const clean = path.replace(/^\/+/, "");
  const text = await gh<string>(`/repos/${repo}/contents/${encodePath(clean)}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`, token, true);
  const cap = 14_000;
  return { path: clean, content: text.slice(0, cap), truncated: text.length > cap, size: text.length };
}

export async function searchFiles(repo: string, branch: string, query: string, token?: string): Promise<{ files: string[]; total: number; truncated: boolean }> {
  const t = await tree(repo, branch, token);
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = t.paths.filter((p) => { const lp = p.toLowerCase(); return terms.every((term) => lp.includes(term)); });
  return { files: hits.slice(0, 80), total: hits.length, truncated: t.truncated };
}

export async function listCommits(repo: string, opts: { since?: string; until?: string; path?: string; limit?: number; branch?: string }, token?: string): Promise<RepoCommit[]> {
  const q = new URLSearchParams();
  if (opts.branch) q.set("sha", opts.branch);
  if (opts.since) q.set("since", new Date(opts.since).toISOString());
  if (opts.until) q.set("until", new Date(opts.until).toISOString());
  if (opts.path) q.set("path", opts.path.replace(/^\/+/, ""));
  q.set("per_page", String(Math.min(100, Math.max(1, opts.limit ?? 50))));
  const commits = await gh<{ sha: string; commit: { message: string; author?: { date?: string; name?: string } }; author?: { login?: string } }[]>(`/repos/${repo}/commits?${q}`, token);
  return commits.map((c) => ({ sha: c.sha.slice(0, 7), date: c.commit.author?.date ?? "", message: (c.commit.message ?? "").split("\n")[0].slice(0, 160), author: c.author?.login ?? c.commit.author?.name }));
}

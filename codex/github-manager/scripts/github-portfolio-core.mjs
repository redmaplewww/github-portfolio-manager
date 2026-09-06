import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const STATE_SCHEMA_VERSION = 1;
const DEFAULT_STALE_DAYS = 7;
const MAX_GRAPHQL_PAGES = 20;

export class PortfolioError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "PortfolioError";
    this.code = code;
    this.details = details;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function unique(values) {
  return [...new Set(values)];
}

function assertPlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PortfolioError("INVALID_INPUT", `${name} must be an object.`);
  }
}

export function normalizeRepository(value) {
  const repository = String(value ?? "").trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new PortfolioError("INVALID_REPOSITORY", `Repository must use owner/name form: ${repository || "(empty)"}`);
  }
  return repository;
}

export function normalizeLogin(value) {
  const login = String(value ?? "").trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(login)) {
    throw new PortfolioError("INVALID_LOGIN", `Invalid GitHub login: ${login || "(empty)"}`);
  }
  return login;
}

function defaultState() {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    trackedRepositories: [],
    assignments: {},
    reporting: {
      enabled: false,
      cadence: "weekly",
      timezone: "Asia/Shanghai",
      destination: "current Codex task",
      lastSummaryAt: null,
    },
    auditLog: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

export function resolveDataDirectory(env = process.env) {
  if (env.GITHUB_PORTFOLIO_HOME) return path.resolve(env.GITHUB_PORTFOLIO_HOME);
  const base = env.LOCALAPPDATA || env.APPDATA || env.USERPROFILE;
  if (!base) throw new PortfolioError("DATA_DIRECTORY_UNAVAILABLE", "LOCALAPPDATA, APPDATA, or USERPROFILE is required.");
  return path.join(base, "Codex", "github-portfolio-manager");
}

export function resolveStatePath(env = process.env) {
  return path.join(resolveDataDirectory(env), "state.json");
}

function normalizeState(raw) {
  assertPlainObject(raw, "state");
  if (raw.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw new PortfolioError("STATE_SCHEMA_UNSUPPORTED", `Unsupported state schema: ${raw.schemaVersion}`);
  }
  const state = defaultState();
  state.createdAt = typeof raw.createdAt === "string" ? raw.createdAt : state.createdAt;
  state.updatedAt = typeof raw.updatedAt === "string" ? raw.updatedAt : state.updatedAt;
  state.trackedRepositories = unique((raw.trackedRepositories ?? []).map(normalizeRepository)).sort();
  state.assignments = {};
  for (const [repository, people] of Object.entries(raw.assignments ?? {})) {
    const normalizedRepository = normalizeRepository(repository);
    state.assignments[normalizedRepository] = (Array.isArray(people) ? people : []).map((person) => ({
      login: normalizeLogin(person.login),
      responsibility: String(person.responsibility ?? "contributor").trim() || "contributor",
      notes: String(person.notes ?? "").trim(),
    }));
  }
  state.reporting = {
    ...state.reporting,
    ...(raw.reporting ?? {}),
    enabled: Boolean(raw.reporting?.enabled),
    lastSummaryAt: typeof raw.reporting?.lastSummaryAt === "string" ? raw.reporting.lastSummaryAt : null,
  };
  state.auditLog = Array.isArray(raw.auditLog) ? raw.auditLog.slice(-200) : [];
  return state;
}

export async function loadState(env = process.env) {
  const statePath = resolveStatePath(env);
  try {
    const raw = JSON.parse(await fs.readFile(statePath, "utf8"));
    return { state: normalizeState(raw), statePath };
  } catch (error) {
    if (error?.code === "ENOENT") return { state: defaultState(), statePath };
    if (error instanceof PortfolioError) throw error;
    throw new PortfolioError("STATE_READ_FAILED", `Unable to read portfolio state: ${error.message}`);
  }
}

export async function saveState(state, env = process.env) {
  const normalized = normalizeState({ ...state, schemaVersion: STATE_SCHEMA_VERSION, updatedAt: nowIso() });
  const statePath = resolveStatePath(env);
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.${randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    await fs.rename(temporaryPath, statePath);
  } catch (error) {
    if (error?.code !== "EEXIST" && error?.code !== "EPERM") throw error;
    await fs.copyFile(temporaryPath, statePath);
    await fs.unlink(temporaryPath);
  }
  return { state: normalized, statePath };
}

function parseJsonOutput(stdout, args) {
  const text = String(stdout ?? "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new PortfolioError("GITHUB_RESPONSE_INVALID", `GitHub CLI returned invalid JSON for: gh ${args.join(" ")}`, { cause: error.message });
  }
}

export function createGhClient({ command = process.platform === "win32" ? "gh.exe" : "gh", environment = process.env } = {}) {
  async function run(args, { allowEmpty = false } = {}) {
    try {
      const result = await execFile(command, args, {
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
        env: environment,
      });
      if (!allowEmpty && !String(result.stdout ?? "").trim()) return null;
      return result;
    } catch (error) {
      const detail = String(error.stderr || error.stdout || error.message || "GitHub CLI call failed").trim();
      throw new PortfolioError("GITHUB_CLI_FAILED", detail, { args });
    }
  }

  return {
    async auth() {
      await run(["auth", "status"], { allowEmpty: true });
      const user = parseJsonOutput((await run(["api", "user"])).stdout, ["api", "user"]);
      return { authenticated: true, login: user?.login ?? null, host: environment.GH_HOST || "github.com" };
    },
    async json(args) {
      const result = await run(args, { allowEmpty: true });
      return parseJsonOutput(result.stdout, args);
    },
  };
}

export async function portfolioStatus({ env = process.env, gh = createGhClient() } = {}) {
  const { state, statePath } = await loadState(env);
  let authentication;
  try {
    authentication = await gh.auth();
  } catch (error) {
    authentication = { authenticated: false, error: error.message };
  }
  return {
    authentication,
    statePath,
    trackedRepositoryCount: state.trackedRepositories.length,
    trackedRepositories: state.trackedRepositories,
    assignmentRepositoryCount: Object.keys(state.assignments).length,
    reporting: state.reporting,
    notes: [
      "No GitHub token is stored in plugin state.",
      "Reporting stays disabled until repositories, cadence, and destination are explicitly selected.",
    ],
  };
}

function flattenPages(value) {
  if (!Array.isArray(value)) return [];
  return value.length > 0 && Array.isArray(value[0]) ? value.flat() : value;
}

export async function discoverRepositories({ visibility = "all", includeArchived = false, limit = 500, gh = createGhClient() } = {}) {
  if (!new Set(["all", "public", "private", "internal"]).has(visibility)) {
    throw new PortfolioError("INVALID_VISIBILITY", `Unsupported visibility: ${visibility}`);
  }
  const raw = flattenPages(await gh.json([
    "api",
    "--paginate",
    "--slurp",
    "/user/repos?affiliation=owner,collaborator,organization_member&per_page=100&sort=updated",
  ]));
  const repositories = raw
    .filter((repo) => includeArchived || !repo.archived)
    .filter((repo) => visibility === "all" || String(repo.visibility ?? (repo.private ? "private" : "public")).toLowerCase() === visibility)
    .map((repo) => ({
      nameWithOwner: repo.full_name,
      description: repo.description ?? "",
      visibility: String(repo.visibility ?? (repo.private ? "private" : "public")).toLowerCase(),
      archived: Boolean(repo.archived),
      fork: Boolean(repo.fork),
      updatedAt: repo.updated_at ?? null,
      defaultBranch: repo.default_branch ?? null,
      url: repo.html_url,
      permissions: repo.permissions ?? null,
    }))
    .filter((repo) => repo.nameWithOwner)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, Math.min(Math.max(Number(limit) || 100, 1), 1000));
  return { repositories, count: repositories.length, selectionRequired: true };
}

export async function updateTracking({ repositories, mode = "replace", verifyAccess = true, env = process.env, gh = createGhClient() }) {
  if (!new Set(["replace", "add", "remove"]).has(mode)) throw new PortfolioError("INVALID_MODE", `Unsupported tracking mode: ${mode}`);
  const requested = unique((repositories ?? []).map(normalizeRepository));
  if (verifyAccess && mode !== "remove") {
    for (const repository of requested) await gh.json(["api", `repos/${repository}`]);
  }
  const { state } = await loadState(env);
  const current = new Set(state.trackedRepositories);
  if (mode === "replace") {
    state.trackedRepositories = requested.sort();
  } else if (mode === "add") {
    for (const repository of requested) current.add(repository);
    state.trackedRepositories = [...current].sort();
  } else {
    for (const repository of requested) current.delete(repository);
    state.trackedRepositories = [...current].sort();
  }
  const saved = await saveState(state, env);
  return { mode, trackedRepositories: saved.state.trackedRepositories, count: saved.state.trackedRepositories.length, statePath: saved.statePath };
}

export async function manageAssignments({ repository, people = [], mode = "replace", env = process.env }) {
  const repo = normalizeRepository(repository);
  if (!new Set(["replace", "upsert", "remove"]).has(mode)) throw new PortfolioError("INVALID_MODE", `Unsupported assignment mode: ${mode}`);
  const normalizedPeople = people.map((person) => ({
    login: normalizeLogin(person.login),
    responsibility: String(person.responsibility ?? "contributor").trim() || "contributor",
    notes: String(person.notes ?? "").trim(),
  }));
  const { state } = await loadState(env);
  const current = new Map((state.assignments[repo] ?? []).map((person) => [person.login.toLowerCase(), person]));
  if (mode === "replace") current.clear();
  if (mode === "remove") {
    for (const person of normalizedPeople) current.delete(person.login.toLowerCase());
  } else {
    for (const person of normalizedPeople) current.set(person.login.toLowerCase(), person);
  }
  const next = [...current.values()].sort((a, b) => a.login.localeCompare(b.login));
  if (next.length === 0) delete state.assignments[repo];
  else state.assignments[repo] = next;
  const saved = await saveState(state, env);
  return { repository: repo, assignments: saved.state.assignments[repo] ?? [], statePath: saved.statePath };
}

export async function configureReporting({ enabled, cadence, timezone, destination, env = process.env }) {
  const { state } = await loadState(env);
  if (enabled !== undefined) state.reporting.enabled = Boolean(enabled);
  if (cadence !== undefined) state.reporting.cadence = String(cadence).trim();
  if (timezone !== undefined) state.reporting.timezone = String(timezone).trim();
  if (destination !== undefined) state.reporting.destination = String(destination).trim();
  if (state.reporting.enabled && state.trackedRepositories.length === 0) {
    throw new PortfolioError("NO_TRACKED_REPOSITORIES", "Select at least one tracked repository before enabling reporting.");
  }
  if (state.reporting.enabled && (!state.reporting.cadence || !state.reporting.timezone || !state.reporting.destination)) {
    throw new PortfolioError("REPORTING_CONFIGURATION_INCOMPLETE", "Cadence, timezone, and destination are required before enabling reporting.");
  }
  const saved = await saveState(state, env);
  return { reporting: saved.state.reporting, trackedRepositoryCount: saved.state.trackedRepositories.length, statePath: saved.statePath };
}

function splitRepository(repository) {
  const normalized = normalizeRepository(repository);
  const slash = normalized.indexOf("/");
  return { repository: normalized, owner: normalized.slice(0, slash), name: normalized.slice(slash + 1) };
}

const PR_QUERY = `query PortfolioPullRequests($owner:String!,$name:String!,$cursor:String){
  repository(owner:$owner,name:$name){
    nameWithOwner url isArchived
    pullRequests(first:100,after:$cursor,orderBy:{field:UPDATED_AT,direction:DESC},states:[OPEN,MERGED,CLOSED]){
      nodes{
        number title url state isDraft createdAt updatedAt mergedAt closedAt
        additions deletions changedFiles reviewDecision baseRefName headRefName
        commits{totalCount}
        author{login}
        labels(first:20){nodes{name}}
        reviews(first:100){nodes{author{login} state submittedAt}}
        reviewRequests(first:20){nodes{requestedReviewer{... on User{login} ... on Team{name slug}}}}
      }
      pageInfo{hasNextPage endCursor}
    }
  }
  rateLimit{remaining resetAt}
}`;

function asDate(value, field) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new PortfolioError("INVALID_DATE", `Invalid ${field}: ${value}`);
  return date;
}

function resolveWindow({ since, until, state }) {
  const end = until ? asDate(until, "until") : new Date();
  let start;
  if (!since) start = state.reporting.lastSummaryAt ? asDate(state.reporting.lastSummaryAt, "lastSummaryAt") : new Date(end.getTime() - 7 * 86_400_000);
  else if (/^\d{1,3}d$/.test(String(since))) start = new Date(end.getTime() - Number.parseInt(String(since), 10) * 86_400_000);
  else start = asDate(since, "since");
  if (start >= end) throw new PortfolioError("INVALID_WINDOW", "since must be earlier than until.");
  return { since: start.toISOString(), until: end.toISOString() };
}

function inWindow(value, sinceMs, untilMs) {
  if (!value) return false;
  const time = new Date(value).getTime();
  return time >= sinceMs && time <= untilMs;
}

export async function fetchRepositoryPullRequests(repository, { since, until, gh = createGhClient() }) {
  const { owner, name } = splitRepository(repository);
  const sinceMs = new Date(since).getTime();
  const untilMs = new Date(until).getTime();
  const pulls = [];
  let cursor = null;
  let repositoryInfo = null;
  let rateLimit = null;
  for (let page = 0; page < MAX_GRAPHQL_PAGES; page += 1) {
    const args = ["api", "graphql", "-f", `query=${PR_QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`];
    if (cursor) args.push("-f", `cursor=${cursor}`);
    const response = await gh.json(args);
    if (response?.errors?.length) throw new PortfolioError("GITHUB_GRAPHQL_FAILED", response.errors.map((item) => item.message).join("; "));
    const repo = response?.data?.repository;
    if (!repo) throw new PortfolioError("REPOSITORY_NOT_FOUND", `Repository not found or not authorized: ${repository}`);
    repositoryInfo = { nameWithOwner: repo.nameWithOwner, url: repo.url, archived: Boolean(repo.isArchived) };
    rateLimit = response?.data?.rateLimit ?? null;
    const nodes = repo.pullRequests?.nodes ?? [];
    for (const pull of nodes) {
      const hasWindowActivity = [pull.createdAt, pull.updatedAt, pull.mergedAt, pull.closedAt].some((value) => inWindow(value, sinceMs, untilMs));
      if (hasWindowActivity) pulls.push(pull);
    }
    const pageInfo = repo.pullRequests?.pageInfo;
    const oldestUpdatedAt = nodes.at(-1)?.updatedAt ? new Date(nodes.at(-1).updatedAt).getTime() : Number.POSITIVE_INFINITY;
    if (!pageInfo?.hasNextPage || !pageInfo.endCursor || oldestUpdatedAt < sinceMs) break;
    cursor = pageInfo.endCursor;
  }
  return { repository: repositoryInfo, pulls, rateLimit };
}

function newContributor(login) {
  return { login, touchedPullRequests: 0, opened: 0, merged: 0, currentlyOpen: 0, additions: 0, deletions: 0, changedFiles: 0, commits: 0, reviewsSubmitted: 0 };
}

function summarizeRepository(repositoryResult, window, assignments, staleDays = DEFAULT_STALE_DAYS) {
  const sinceMs = new Date(window.since).getTime();
  const untilMs = new Date(window.until).getTime();
  const staleCutoff = untilMs - staleDays * 86_400_000;
  const contributors = new Map();
  const getContributor = (login) => {
    const key = login || "ghost";
    if (!contributors.has(key)) contributors.set(key, newContributor(key));
    return contributors.get(key);
  };
  const prQueue = [];
  let opened = 0;
  let merged = 0;
  let closedWithoutMerge = 0;
  let currentlyOpen = 0;
  let draft = 0;
  let changesRequested = 0;
  let awaitingReview = 0;
  let stale = 0;
  for (const pull of repositoryResult.pulls) {
    const author = pull.author?.login ?? "ghost";
    const contribution = getContributor(author);
    contribution.touchedPullRequests += 1;
    contribution.additions += Number(pull.additions ?? 0);
    contribution.deletions += Number(pull.deletions ?? 0);
    contribution.changedFiles += Number(pull.changedFiles ?? 0);
    contribution.commits += Number(pull.commits?.totalCount ?? 0);
    if (inWindow(pull.createdAt, sinceMs, untilMs)) {
      opened += 1;
      contribution.opened += 1;
    }
    if (inWindow(pull.mergedAt, sinceMs, untilMs)) {
      merged += 1;
      contribution.merged += 1;
    }
    if (!pull.mergedAt && inWindow(pull.closedAt, sinceMs, untilMs)) closedWithoutMerge += 1;
    if (pull.state === "OPEN") {
      currentlyOpen += 1;
      contribution.currentlyOpen += 1;
      if (pull.isDraft) draft += 1;
      if (pull.reviewDecision === "CHANGES_REQUESTED") changesRequested += 1;
      const requestedReviewers = (pull.reviewRequests?.nodes ?? []).map((request) => request.requestedReviewer?.login || request.requestedReviewer?.slug || request.requestedReviewer?.name).filter(Boolean);
      if (!pull.isDraft && (pull.reviewDecision === "REVIEW_REQUIRED" || requestedReviewers.length > 0)) awaitingReview += 1;
      const isStale = new Date(pull.updatedAt).getTime() < staleCutoff;
      if (isStale) stale += 1;
      prQueue.push({
        number: pull.number,
        title: pull.title,
        url: pull.url,
        author,
        draft: Boolean(pull.isDraft),
        reviewDecision: pull.reviewDecision ?? "UNREVIEWED",
        requestedReviewers,
        updatedAt: pull.updatedAt,
        stale: isStale,
        labels: (pull.labels?.nodes ?? []).map((label) => label.name),
      });
    }
    for (const review of pull.reviews?.nodes ?? []) {
      if (review.author?.login && inWindow(review.submittedAt, sinceMs, untilMs)) getContributor(review.author.login).reviewsSubmitted += 1;
    }
  }
  const assignedLogins = new Set((assignments ?? []).map((person) => person.login.toLowerCase()));
  const activeLogins = new Set([...contributors.keys()].map((login) => login.toLowerCase()));
  return {
    repository: repositoryResult.repository,
    counts: { opened, merged, closedWithoutMerge, currentlyOpen, draft, changesRequested, awaitingReview, stale },
    contributors: [...contributors.values()].sort((a, b) => (b.touchedPullRequests - a.touchedPullRequests) || a.login.localeCompare(b.login)),
    prQueue: prQueue.sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt))),
    assignments: assignments ?? [],
    assignmentGaps: {
      activeButUnassigned: [...activeLogins].filter((login) => !assignedLogins.has(login)).sort(),
      assignedWithoutWindowActivity: [...assignedLogins].filter((login) => !activeLogins.has(login)).sort(),
    },
  };
}

function markdownCell(value) {
  return String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function renderSummaryMarkdown(summary) {
  const lines = [
    "# GitHub 开发组合摘要",
    "",
    `- 时间窗口：${summary.window.since} ～ ${summary.window.until}`,
    `- 已汇总仓库：${summary.repositories.length}/${summary.scope.length}`,
    `- 失败仓库：${summary.failures.length}`,
    `- PR：新开 ${summary.totals.opened}，合并 ${summary.totals.merged}，当前打开 ${summary.totals.currentlyOpen}，待审 ${summary.totals.awaitingReview}，变更请求 ${summary.totals.changesRequested}，超期 ${summary.totals.stale}`,
    "",
    "## 仓库进度",
    "",
    "| 仓库 | 新开 | 合并 | 当前打开 | 待审 | 变更请求 | 超期 |",
    "|---|---:|---:|---:|---:|---:|---:|",
  ];
  for (const repo of summary.repositories) {
    lines.push(`| [${markdownCell(repo.repository.nameWithOwner)}](${repo.repository.url}) | ${repo.counts.opened} | ${repo.counts.merged} | ${repo.counts.currentlyOpen} | ${repo.counts.awaitingReview} | ${repo.counts.changesRequested} | ${repo.counts.stale} |`);
  }
  lines.push("", "## 贡献事实（不等同绩效评分）", "", "| 成员 | 活跃 PR | 新开 | 合并 | 当前打开 | Reviews | 增加行 | 删除行 | 文件 | 提交 |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const contributor of summary.contributors) {
    lines.push(`| ${markdownCell(contributor.login)} | ${contributor.touchedPullRequests} | ${contributor.opened} | ${contributor.merged} | ${contributor.currentlyOpen} | ${contributor.reviewsSubmitted} | ${contributor.additions} | ${contributor.deletions} | ${contributor.changedFiles} | ${contributor.commits} |`);
  }
  lines.push("", "## 需要关注的打开 PR", "");
  const queue = summary.repositories.flatMap((repo) => repo.prQueue.map((pull) => ({ ...pull, repository: repo.repository.nameWithOwner })));
  if (queue.length === 0) lines.push("- 当前窗口内没有仍处于打开状态的 PR。");
  for (const pull of queue.slice(0, 50)) {
    const flags = [pull.draft ? "草稿" : null, pull.reviewDecision, pull.stale ? "超期" : null].filter(Boolean).join(" / ");
    lines.push(`- [${pull.repository}#${pull.number} ${pull.title}](${pull.url}) · ${pull.author} · ${flags}`);
  }
  if (summary.failures.length > 0) {
    lines.push("", "## 未完成读取", "");
    for (const failure of summary.failures) lines.push(`- ${failure.repository}: ${failure.error}`);
  }
  lines.push(
    "",
    "## 口径说明",
    "",
    "- 增删行、文件和提交来自当前 PR 的 GitHub 总量；长周期或重复活跃 PR 可能跨报告重复出现。",
    "- 代码量不能单独代表工时、质量、复杂度、协作贡献或个人绩效；请结合评审、缺陷、交付结果和职责判断。",
    "- 仓库读取失败会单独列出；存在失败时不会推进自动报告检查点。",
  );
  return `${lines.join("\n")}\n`;
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

export async function summarizePortfolio({ repositories, since, until, staleDays = DEFAULT_STALE_DAYS, advanceCheckpoint = false, env = process.env, gh = createGhClient() } = {}) {
  const loaded = await loadState(env);
  const scope = unique((repositories?.length ? repositories : loaded.state.trackedRepositories).map(normalizeRepository));
  if (scope.length === 0) throw new PortfolioError("NO_TRACKED_REPOSITORIES", "No repositories are tracked. Discover repositories and select the tracking scope first.");
  const window = resolveWindow({ since, until, state: loaded.state });
  const fetched = await mapLimit(scope, 4, async (repository) => {
    try {
      return { ok: true, repository, value: await fetchRepositoryPullRequests(repository, { ...window, gh }) };
    } catch (error) {
      return { ok: false, repository, error: error.message };
    }
  });
  const repositoriesSummary = fetched.filter((item) => item.ok).map((item) => summarizeRepository(item.value, window, loaded.state.assignments[item.repository], staleDays));
  const failures = fetched.filter((item) => !item.ok).map(({ repository, error }) => ({ repository, error }));
  const contributors = new Map();
  for (const repo of repositoriesSummary) {
    for (const entry of repo.contributors) {
      const aggregate = contributors.get(entry.login) ?? newContributor(entry.login);
      for (const key of Object.keys(aggregate).filter((key) => key !== "login")) aggregate[key] += entry[key];
      contributors.set(entry.login, aggregate);
    }
  }
  const totals = repositoriesSummary.reduce((sum, repo) => {
    for (const [key, value] of Object.entries(repo.counts)) sum[key] = (sum[key] ?? 0) + value;
    return sum;
  }, { opened: 0, merged: 0, closedWithoutMerge: 0, currentlyOpen: 0, draft: 0, changesRequested: 0, awaitingReview: 0, stale: 0 });
  const summary = {
    generatedAt: nowIso(),
    window,
    scope,
    repositories: repositoriesSummary,
    failures,
    totals,
    contributors: [...contributors.values()].sort((a, b) => (b.touchedPullRequests - a.touchedPullRequests) || a.login.localeCompare(b.login)),
    metricNotice: "PR line, file, and commit totals are activity facts, not a performance score.",
    checkpointAdvanced: false,
  };
  const dataDirectory = resolveDataDirectory(env);
  const reportsDirectory = path.join(dataDirectory, "reports");
  await fs.mkdir(reportsDirectory, { recursive: true });
  const stamp = summary.generatedAt.replaceAll(":", "-").replaceAll(".", "-");
  const markdownPath = path.join(reportsDirectory, `${stamp}.md`);
  const jsonPath = path.join(reportsDirectory, `${stamp}.json`);
  await fs.writeFile(markdownPath, renderSummaryMarkdown(summary), "utf8");
  await fs.writeFile(jsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  if (advanceCheckpoint && failures.length === 0 && repositoriesSummary.length > 0) {
    loaded.state.reporting.lastSummaryAt = window.until;
    await saveState(loaded.state, env);
    summary.checkpointAdvanced = true;
  }
  return { ...summary, reportFiles: { markdownPath, jsonPath } };
}

export async function listCollaborators({ repository, gh = createGhClient() }) {
  const repo = normalizeRepository(repository);
  const raw = flattenPages(await gh.json(["api", "--paginate", "--slurp", `repos/${repo}/collaborators?affiliation=all&per_page=100`]));
  return {
    repository: repo,
    collaborators: raw.map((item) => ({
      login: item.login,
      roleName: item.role_name ?? null,
      permissions: item.permissions ?? null,
      url: item.html_url ?? null,
    })).sort((a, b) => a.login.localeCompare(b.login)),
  };
}

export function collaboratorChangeToken({ repository, login, operation, permission, currentRole }) {
  const canonical = JSON.stringify({
    repository: normalizeRepository(repository),
    login: normalizeLogin(login),
    operation,
    permission: permission ?? null,
    currentRole: currentRole ?? null,
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 24);
}

export async function planCollaboratorChange({ repository, login, operation, permission = "push", gh = createGhClient() }) {
  const repo = normalizeRepository(repository);
  const user = normalizeLogin(login);
  if (!new Set(["add", "update", "remove"]).has(operation)) throw new PortfolioError("INVALID_OPERATION", `Unsupported collaborator operation: ${operation}`);
  if (operation !== "remove" && !new Set(["pull", "triage", "push", "maintain", "admin"]).has(permission)) {
    throw new PortfolioError("INVALID_PERMISSION", `Unsupported collaborator permission: ${permission}`);
  }
  const current = await listCollaborators({ repository: repo, gh });
  const existing = current.collaborators.find((item) => item.login.toLowerCase() === user.toLowerCase()) ?? null;
  if (operation === "add" && existing) throw new PortfolioError("COLLABORATOR_ALREADY_EXISTS", `${user} already collaborates on ${repo}; use update.`);
  if ((operation === "update" || operation === "remove") && !existing) throw new PortfolioError("COLLABORATOR_NOT_FOUND", `${user} is not a current collaborator on ${repo}.`);
  const currentRole = existing?.roleName ?? null;
  const confirmationToken = collaboratorChangeToken({ repository: repo, login: user, operation, permission: operation === "remove" ? null : permission, currentRole });
  return {
    repository: repo,
    login: user,
    operation,
    currentRole,
    requestedRole: operation === "remove" ? null : permission,
    confirmationToken,
    confirmationMessage: operation === "remove"
      ? `Remove ${user} from ${repo}. Repository access may be revoked immediately.`
      : `${operation === "add" ? "Add" : "Update"} ${user} on ${repo} with ${permission} permission. GitHub may create an invitation instead of immediate access.`,
    expiresWhenCurrentCollaboratorStateChanges: true,
  };
}

function appendAudit(state, entry) {
  state.auditLog.push({ at: nowIso(), ...entry });
  state.auditLog = state.auditLog.slice(-200);
}

export async function applyCollaboratorChange({ repository, login, operation, permission = "push", confirmationToken, syncAssignment = true, env = process.env, gh = createGhClient() }) {
  const plan = await planCollaboratorChange({ repository, login, operation, permission, gh });
  if (!confirmationToken || confirmationToken !== plan.confirmationToken) {
    throw new PortfolioError("CONFIRMATION_REQUIRED", "The collaborator change was not applied. Re-plan the change and provide its exact confirmation token after user approval.", { plan });
  }
  let response = null;
  if (operation === "remove") response = await gh.json(["api", "--method", "DELETE", `repos/${plan.repository}/collaborators/${plan.login}`]);
  else response = await gh.json(["api", "--method", "PUT", `repos/${plan.repository}/collaborators/${plan.login}`, "-f", `permission=${permission}`]);
  const { state } = await loadState(env);
  if (syncAssignment) {
    const current = new Map((state.assignments[plan.repository] ?? []).map((person) => [person.login.toLowerCase(), person]));
    if (operation === "remove") current.delete(plan.login.toLowerCase());
    else current.set(plan.login.toLowerCase(), { login: plan.login, responsibility: permission, notes: "Synchronized from confirmed GitHub collaborator change." });
    const next = [...current.values()].sort((a, b) => a.login.localeCompare(b.login));
    if (next.length) state.assignments[plan.repository] = next;
    else delete state.assignments[plan.repository];
  }
  appendAudit(state, { type: "github_collaborator_change", repository: plan.repository, login: plan.login, operation, permission: operation === "remove" ? null : permission, result: "submitted" });
  await saveState(state, env);
  const verification = await listCollaborators({ repository: plan.repository, gh });
  const collaborator = verification.collaborators.find((item) => item.login.toLowerCase() === plan.login.toLowerCase()) ?? null;
  return {
    applied: true,
    repository: plan.repository,
    login: plan.login,
    operation,
    requestedPermission: operation === "remove" ? null : permission,
    currentCollaborator: collaborator,
    invitationMayBePending: operation !== "remove" && !collaborator,
    githubResponse: response,
    assignmentSynchronized: Boolean(syncAssignment),
  };
}

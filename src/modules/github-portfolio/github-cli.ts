import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type {
  PullRequestBundle,
  PullRequestCheck,
  PullRequestFile,
  PullRequestListItem,
  RepositoryMergePolicy,
  SourceComparison,
} from "./contracts";

const execFileAsync = promisify(execFile);
const DEFAULT_PLUGIN_ROOT = "C:\\Users\\zzg\\plugins\\github-portfolio-manager";
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TEXT_EXTENSION_PATTERN = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|kts|rb|php|cs|cpp|cc|c|h|hpp|swift|scala|sql|html?|css|scss|sass|less|md|mdx|txt|json|ya?ml|toml|ini|env|xml|graphql|sh|ps1|bat)$/i;
const SKIPPED_SOURCE_PATTERN = /(?:^|\/)(?:node_modules|dist|build|coverage|vendor)\/|(?:package-lock|pnpm-lock|yarn\.lock|min\.js|\.map)$/i;

type UnknownRecord = Record<string, unknown>;

function assertRepository(repository: string) {
  if (!REPOSITORY_PATTERN.test(repository)) throw new Error("仓库格式无效");
}

function assertPullNumber(number: number) {
  if (!Number.isInteger(number) || number <= 0) throw new Error("PR 编号无效");
}

async function runJson(command: string, args: string[]) {
  const { stdout } = await execFileAsync(command, args, {
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    env: process.env,
  });
  return JSON.parse(String(stdout || "null"));
}

async function runText(command: string, args: string[]) {
  const { stdout } = await execFileAsync(command, args, {
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    env: process.env,
  });
  return String(stdout || "");
}

function normalizeChecks(value: unknown): PullRequestCheck[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const check = item as UnknownRecord;
    const name = String(check.name || check.context || "unnamed check");
    const status = String(check.status || check.state || "UNKNOWN").toUpperCase();
    const conclusion = String(check.conclusion || check.state || "UNKNOWN").toUpperCase();
    const passing = ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion) || status === "SUCCESS";
    return { name, status, conclusion, passing };
  });
}

function normalizeListItem(repository: string, raw: UnknownRecord): PullRequestListItem {
  const author = (raw.author || {}) as UnknownRecord;
  return {
    repository,
    number: Number(raw.number),
    title: String(raw.title || "Untitled PR"),
    author: String(author.login || "unknown"),
    headRefName: String(raw.headRefName || ""),
    baseRefName: String(raw.baseRefName || ""),
    headRefOid: String(raw.headRefOid || ""),
    isDraft: Boolean(raw.isDraft),
    reviewDecision: String(raw.reviewDecision || ""),
    mergeStateStatus: String(raw.mergeStateStatus || ""),
    additions: Number(raw.additions || 0),
    deletions: Number(raw.deletions || 0),
    changedFiles: Number(raw.changedFiles || 0),
    updatedAt: String(raw.updatedAt || ""),
    checks: normalizeChecks(raw.statusCheckRollup),
  };
}

export async function trackedRepositories(): Promise<string[]> {
  const root = process.env.GITHUB_PORTFOLIO_PLUGIN_ROOT || DEFAULT_PLUGIN_ROOT;
  const cli = path.join(root, "scripts", "portfolio-cli.mjs");
  const status = (await runJson(process.execPath, [cli, "status"])) as UnknownRecord;
  return Array.isArray(status.trackedRepositories)
    ? status.trackedRepositories.map(String).filter((repo) => REPOSITORY_PATTERN.test(repo))
    : [];
}

export async function listOpenPullRequests(repositories?: string[]): Promise<PullRequestListItem[]> {
  const scope = repositories?.length ? repositories : await trackedRepositories();
  const fields = "number,title,author,headRefName,baseRefName,headRefOid,isDraft,reviewDecision,statusCheckRollup,updatedAt,additions,deletions,changedFiles,mergeStateStatus";
  const results = await Promise.all(scope.map(async (repository) => {
    assertRepository(repository);
    const rows = await runJson("gh.exe", ["pr", "list", "--repo", repository, "--state", "open", "--limit", "100", "--json", fields]);
    return (Array.isArray(rows) ? rows : []).map((row) => normalizeListItem(repository, row as UnknownRecord));
  }));
  return results.flat().sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

async function pullFiles(repository: string, number: number): Promise<PullRequestFile[]> {
  const raw = await runJson("gh.exe", ["api", `repos/${repository}/pulls/${number}/files?per_page=100`]);
  return (Array.isArray(raw) ? raw : []).map((item) => {
    const file = item as UnknownRecord;
    return {
      path: String(file.filename || ""),
      status: String(file.status || "modified"),
      additions: Number(file.additions || 0),
      deletions: Number(file.deletions || 0),
      changes: Number(file.changes || 0),
      patch: typeof file.patch === "string" ? file.patch : null,
    };
  });
}

async function branchProtection(repository: string, branch: string) {
  try {
    const raw = await runJson("gh.exe", ["api", `repos/${repository}/branches/${encodeURIComponent(branch)}/protection`]) as UnknownRecord;
    const reviews = raw.required_pull_request_reviews as UnknownRecord | undefined;
    return {
      known: true,
      requiredApprovals: reviews ? Number(reviews.required_approving_review_count || 0) : 0,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : "保护规则不可读";
    return { known: false, requiredApprovals: null, reason: message };
  }
}

export async function getPullRequestBundle(repository: string, number: number): Promise<PullRequestBundle> {
  assertRepository(repository);
  assertPullNumber(number);
  const fields = "number,title,body,author,state,isDraft,reviewDecision,mergeable,mergeStateStatus,headRefName,headRefOid,baseRefName,baseRefOid,additions,deletions,changedFiles,commits,reviews,statusCheckRollup,updatedAt,createdAt";
  const [rawValue, files] = await Promise.all([
    runJson("gh.exe", ["pr", "view", String(number), "--repo", repository, "--json", fields]),
    pullFiles(repository, number),
  ]);
  const raw = rawValue as UnknownRecord;
  const base = normalizeListItem(repository, raw);
  const commits = Array.isArray(raw.commits) ? raw.commits.map((item) => {
    const commit = item as UnknownRecord;
    return { oid: String(commit.oid || ""), messageHeadline: String(commit.messageHeadline || ""), authoredDate: String(commit.authoredDate || "") };
  }) : [];
  const reviews = Array.isArray(raw.reviews) ? raw.reviews.map((item) => {
    const review = item as UnknownRecord;
    const author = (review.author || {}) as UnknownRecord;
    return {
      author: String(author.login || "unknown"),
      state: String(review.state || ""),
      submittedAt: review.submittedAt ? String(review.submittedAt) : null,
      body: String(review.body || ""),
    };
  }) : [];
  return {
    ...base,
    body: String(raw.body || ""),
    state: String(raw.state || ""),
    mergeable: String(raw.mergeable || "UNKNOWN"),
    baseRefOid: String(raw.baseRefOid || ""),
    createdAt: String(raw.createdAt || ""),
    commits,
    reviews,
    files,
    branchProtection: await branchProtection(repository, base.baseRefName),
  };
}

function encodedContentPath(filePath: string) {
  return filePath.split("/").map(encodeURIComponent).join("/");
}

async function readSource(repository: string, filePath: string, ref: string): Promise<string | null> {
  try {
    return await runText("gh.exe", ["api", `repos/${repository}/contents/${encodedContentPath(filePath)}?ref=${encodeURIComponent(ref)}`, "-H", "Accept: application/vnd.github.raw+json"]);
  } catch {
    return null;
  }
}

function truncateUtf8(value: string | null, maxBytes: number) {
  if (!value || maxBytes <= 0) return { text: null as string | null, bytes: 0, originalBytes: value ? Buffer.byteLength(value, "utf8") : 0 };
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) return { text: value, bytes: buffer.length, originalBytes: buffer.length };
  const text = buffer.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/u, "");
  return { text, bytes: Buffer.byteLength(text, "utf8"), originalBytes: buffer.length };
}

export async function collectSourceComparisons(bundle: PullRequestBundle, policy: RepositoryMergePolicy): Promise<SourceComparison[]> {
  const eligible = bundle.files.filter((file) => TEXT_EXTENSION_PATTERN.test(file.path) && !SKIPPED_SOURCE_PATTERN.test(file.path));
  const selected = eligible.slice(0, policy.sourceReadMaxFiles);
  const comparisons: SourceComparison[] = [];
  let remaining = policy.sourceReadMaxBytes;
  for (const file of selected) {
    if (remaining <= 0) break;
    const [base, head] = await Promise.all([
      readSource(bundle.repository, file.path, bundle.baseRefOid),
      readSource(bundle.repository, file.path, bundle.headRefOid),
    ]);
    const baseLimit = base && head ? Math.floor(remaining / 2) : remaining;
    const boundedBase = truncateUtf8(base, baseLimit);
    const boundedHead = truncateUtf8(head, remaining - boundedBase.bytes);
    comparisons.push({
      path: file.path,
      base: boundedBase.text,
      head: boundedHead.text,
      truncated: boundedBase.originalBytes > boundedBase.bytes || boundedHead.originalBytes > boundedHead.bytes,
      reason: base === null && head === null ? "源码内容不可读" : undefined,
    });
    remaining -= boundedBase.bytes + boundedHead.bytes;
  }
  return comparisons;
}

export async function mergePullRequest(repository: string, number: number, sha: string, method: string) {
  assertRepository(repository);
  assertPullNumber(number);
  const result = await runJson("gh.exe", [
    "api", "--method", "PUT", `repos/${repository}/pulls/${number}/merge`,
    "-f", `merge_method=${method}`, "-f", `sha=${sha}`,
  ]) as UnknownRecord;
  return {
    merged: Boolean(result.merged),
    message: String(result.message || ""),
    sha: String(result.sha || ""),
  };
}

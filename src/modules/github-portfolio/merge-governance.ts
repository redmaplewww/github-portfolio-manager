import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AiMergeReview, MergeGateEvaluation, MergeMethod, PullRequestBundle, RepositoryMergePolicy } from "./contracts";

function stateDirectory() {
  return process.env.GITHUB_PORTFOLIO_STATE_DIR
    || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Codex", "github-portfolio-manager");
}

const policyPath = () => path.join(stateDirectory(), "merge-policies.json");
const reviewPath = () => path.join(stateDirectory(), "ai-review-cache.json");
const planPath = () => path.join(stateDirectory(), "merge-plans.json");

export const DEFAULT_MERGE_POLICY: RepositoryMergePolicy = {
  mergeMethod: "squash",
  requireChecks: true,
  requireReview: true,
  blockDraft: true,
  blockChangesRequested: true,
  maxFiles: 40,
  maxChangedLines: 1500,
  minimumAiConfidence: 0.8,
  manualOnlyPaths: [".github/workflows/", "deploy/", "infra/", "migrations/", "auth/", "security/"],
  sourceReadMaxFiles: 12,
  sourceReadMaxBytes: 80_000,
};

type MergePlanRecord = {
  repository: string;
  number: number;
  headSha: string;
  method: MergeMethod;
  gateDigest: string;
  tokenHash: string;
  expiresAt: string;
  usedAt: string | null;
};

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(filePath: string, value: unknown) {
  await mkdir(stateDirectory(), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

function key(repository: string, number: number, sha: string) {
  return `${repository}#${number}#${sha}`;
}

export async function getMergePolicy(repository: string): Promise<RepositoryMergePolicy> {
  const policies = await readJson<Record<string, Partial<RepositoryMergePolicy>>>(policyPath(), {});
  return { ...DEFAULT_MERGE_POLICY, ...(policies[repository] || {}) };
}

export async function saveMergePolicy(repository: string, value: RepositoryMergePolicy) {
  const policies = await readJson<Record<string, Partial<RepositoryMergePolicy>>>(policyPath(), {});
  policies[repository] = value;
  await writeJson(policyPath(), policies);
  return value;
}

export async function saveAiReview(repository: string, number: number, review: AiMergeReview) {
  const cache = await readJson<Record<string, AiMergeReview>>(reviewPath(), {});
  cache[key(repository, number, review.reviewedHeadSha)] = review;
  await writeJson(reviewPath(), cache);
}

export async function getAiReview(repository: string, number: number, sha: string) {
  const cache = await readJson<Record<string, AiMergeReview>>(reviewPath(), {});
  return cache[key(repository, number, sha)] || null;
}

export async function listCachedAiReviews() {
  const cache = await readJson<Record<string, AiMergeReview>>(reviewPath(), {});
  return Object.fromEntries(Object.entries(cache).map(([cacheKey, review]) => [cacheKey, {
    verdict: review.verdict,
    confidence: review.confidence,
    summary: review.summary,
    findings: review.findings.slice(0, 3),
    reviewedHeadSha: review.reviewedHeadSha,
    reviewedAt: review.reviewedAt,
    model: review.model,
  }]));
}

export function evaluateMergeGates(bundle: PullRequestBundle, review: AiMergeReview | null, policy: RepositoryMergePolicy): MergeGateEvaluation {
  const changedLines = bundle.additions + bundle.deletions;
  const latestReviews = new Map<string, string>();
  for (const item of bundle.reviews) latestReviews.set(item.author, item.state.toUpperCase());
  const approvals = [...latestReviews.values()].filter((state) => state === "APPROVED").length;
  const hasChangesRequested = [...latestReviews.values()].some((state) => state === "CHANGES_REQUESTED") || bundle.reviewDecision === "CHANGES_REQUESTED";
  const sensitive = bundle.files.filter((file) => policy.manualOnlyPaths.some((prefix) => file.path.toLowerCase().startsWith(prefix.toLowerCase())));
  const checksPassing = bundle.checks.length > 0 && bundle.checks.every((check) => check.passing);
  const gates = [
    { id: "state", label: "PR 仍然开放", passed: bundle.state === "OPEN", detail: bundle.state || "未知" },
    { id: "draft", label: "不是草稿", passed: !policy.blockDraft || !bundle.isDraft, detail: bundle.isDraft ? "当前为 Draft" : "已就绪" },
    { id: "mergeable", label: "GitHub 判定可合并", passed: bundle.mergeable === "MERGEABLE", detail: `${bundle.mergeable} / ${bundle.mergeStateStatus || "UNKNOWN"}` },
    { id: "checks", label: "CI 检查通过", passed: !policy.requireChecks || checksPassing, detail: bundle.checks.length ? `${bundle.checks.filter((item) => item.passing).length}/${bundle.checks.length} 通过` : "没有可验证的 CI 检查" },
    { id: "review", label: "至少一位评审批准", passed: !policy.requireReview || approvals > 0, detail: `${approvals} 个有效批准` },
    { id: "changes", label: "没有未解决的修改请求", passed: !policy.blockChangesRequested || !hasChangesRequested, detail: hasChangesRequested ? "存在 CHANGES_REQUESTED" : "未发现阻塞请求" },
    { id: "size", label: "变更规模在策略内", passed: bundle.changedFiles <= policy.maxFiles && changedLines <= policy.maxChangedLines, detail: `${bundle.changedFiles}/${policy.maxFiles} 文件 · ${changedLines}/${policy.maxChangedLines} 行` },
    { id: "paths", label: "未触及人工专审路径", passed: sensitive.length === 0, detail: sensitive.length ? sensitive.slice(0, 3).map((file) => file.path).join("、") : "未命中敏感路径" },
    { id: "ai", label: "Codex 建议合并", passed: review?.verdict === "merge" && review.confidence >= policy.minimumAiConfidence, detail: review ? `${review.verdict} · ${Math.round(review.confidence * 100)}%` : "尚未运行 AI 审查" },
    { id: "sha", label: "AI 审查对应当前提交", passed: Boolean(review && review.reviewedHeadSha === bundle.headRefOid), detail: review?.reviewedHeadSha === bundle.headRefOid ? bundle.headRefOid.slice(0, 8) : "审查已过期或不存在" },
  ];
  return { allowed: gates.every((gate) => gate.passed), gates };
}

function digestGates(evaluation: MergeGateEvaluation) {
  return createHash("sha256").update(JSON.stringify(evaluation.gates)).digest("hex");
}

export async function createMergePlan(bundle: PullRequestBundle, review: AiMergeReview | null, policy: RepositoryMergePolicy) {
  const evaluation = evaluateMergeGates(bundle, review, policy);
  if (!evaluation.allowed) return { allowed: false, evaluation, token: null, expiresAt: null };
  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const plans = await readJson<Record<string, MergePlanRecord>>(planPath(), {});
  plans[key(bundle.repository, bundle.number, bundle.headRefOid)] = {
    repository: bundle.repository,
    number: bundle.number,
    headSha: bundle.headRefOid,
    method: policy.mergeMethod,
    gateDigest: digestGates(evaluation),
    tokenHash: createHash("sha256").update(token).digest("hex"),
    expiresAt,
    usedAt: null,
  };
  await writeJson(planPath(), plans);
  return { allowed: true, evaluation, token, expiresAt, method: policy.mergeMethod, headSha: bundle.headRefOid };
}

export async function consumeMergePlan(bundle: PullRequestBundle, review: AiMergeReview | null, policy: RepositoryMergePolicy, token: string) {
  const evaluation = evaluateMergeGates(bundle, review, policy);
  const plans = await readJson<Record<string, MergePlanRecord>>(planPath(), {});
  const planKey = key(bundle.repository, bundle.number, bundle.headRefOid);
  const plan = plans[planKey];
  const tokenHash = createHash("sha256").update(token).digest("hex");
  if (!plan || plan.usedAt || plan.tokenHash !== tokenHash) throw new Error("合并确认令牌无效或已使用");
  if (Date.parse(plan.expiresAt) <= Date.now()) throw new Error("合并确认已过期，请重新生成计划");
  if (!evaluation.allowed || digestGates(evaluation) !== plan.gateDigest) throw new Error("PR 状态或门禁已变化，请重新审查");
  plan.usedAt = new Date().toISOString();
  plans[planKey] = plan;
  await writeJson(planPath(), plans);
  return { evaluation, method: plan.method, headSha: plan.headSha };
}

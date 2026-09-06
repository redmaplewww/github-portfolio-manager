import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AiMergeReview, PullRequestBundle } from "@/src/modules/github-portfolio/contracts";
import {
  DEFAULT_MERGE_POLICY,
  consumeMergePlan,
  createMergePlan,
  evaluateMergeGates,
} from "@/src/modules/github-portfolio/merge-governance";

let temporaryState = "";

beforeAll(async () => {
  temporaryState = await mkdtemp(path.join(os.tmpdir(), "nexus-github-merge-test-"));
  process.env.GITHUB_PORTFOLIO_STATE_DIR = temporaryState;
});

afterAll(async () => {
  delete process.env.GITHUB_PORTFOLIO_STATE_DIR;
  if (temporaryState.startsWith(os.tmpdir())) await rm(temporaryState, { recursive: true, force: true });
});

function bundle(overrides: Partial<PullRequestBundle> = {}): PullRequestBundle {
  return {
    repository: "owner/repository",
    number: 7,
    title: "Safe change",
    body: "A bounded test change.",
    author: "developer",
    headRefName: "feature/safe",
    baseRefName: "main",
    headRefOid: "1234567890abcdef",
    baseRefOid: "abcdef1234567890",
    isDraft: false,
    reviewDecision: "APPROVED",
    mergeStateStatus: "CLEAN",
    mergeable: "MERGEABLE",
    state: "OPEN",
    additions: 20,
    deletions: 5,
    changedFiles: 1,
    updatedAt: "2026-08-31T00:00:00Z",
    createdAt: "2026-08-30T00:00:00Z",
    checks: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS", passing: true }],
    reviews: [{ author: "reviewer", state: "APPROVED", submittedAt: "2026-08-31T00:00:00Z", body: "" }],
    commits: [{ oid: "1234567890abcdef", messageHeadline: "safe", authoredDate: "2026-08-31T00:00:00Z" }],
    files: [{ path: "src/safe.ts", status: "modified", additions: 20, deletions: 5, changes: 25, patch: "+safe" }],
    branchProtection: { known: true, requiredApprovals: 1 },
    ...overrides,
  };
}

function review(overrides: Partial<AiMergeReview> = {}): AiMergeReview {
  return {
    verdict: "merge",
    confidence: 0.94,
    summary: "Evidence supports merge.",
    findings: [],
    sourceComparisons: [],
    requirements: [],
    unknowns: [],
    reviewedHeadSha: "1234567890abcdef",
    reviewedAt: "2026-08-31T00:00:00Z",
    model: "test",
    ...overrides,
  };
}

describe("GitHub AI merge governance", () => {
  it("allows a reviewed PR only when every deterministic gate passes", () => {
    const result = evaluateMergeGates(bundle(), review(), DEFAULT_MERGE_POLICY);
    expect(result.allowed).toBe(true);
    expect(result.gates.every((gate) => gate.passed)).toBe(true);
  });

  it("fails closed for missing CI, oversized changes, sensitive paths, and stale AI evidence", () => {
    const result = evaluateMergeGates(
      bundle({
        headRefOid: "new-head-sha",
        checks: [],
        changedFiles: 70,
        additions: 2_000,
        files: [{ path: ".github/workflows/release.yml", status: "modified", additions: 2_000, deletions: 0, changes: 2_000, patch: null }],
      }),
      review(),
      DEFAULT_MERGE_POLICY,
    );
    expect(result.allowed).toBe(false);
    expect(result.gates.filter((gate) => !gate.passed).map((gate) => gate.id)).toEqual(expect.arrayContaining(["checks", "size", "paths", "sha"]));
  });

  it("binds a one-time merge token to the exact PR head and current gate digest", async () => {
    const currentBundle = bundle();
    const currentReview = review();
    const plan = await createMergePlan(currentBundle, currentReview, DEFAULT_MERGE_POLICY);
    expect(plan.allowed).toBe(true);
    expect(plan.token).toBeTruthy();

    const consumed = await consumeMergePlan(currentBundle, currentReview, DEFAULT_MERGE_POLICY, plan.token!);
    expect(consumed.headSha).toBe(currentBundle.headRefOid);
    await expect(consumeMergePlan(currentBundle, currentReview, DEFAULT_MERGE_POLICY, plan.token!)).rejects.toThrow("无效或已使用");
  });
});

export type PullRequestListItem = {
  repository: string;
  number: number;
  title: string;
  author: string;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  isDraft: boolean;
  reviewDecision: string;
  mergeStateStatus?: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  updatedAt: string;
  checks: PullRequestCheck[];
};

export type PullRequestCheck = {
  name: string;
  status: string;
  conclusion: string;
  passing: boolean;
};

export type PullRequestFile = {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch: string | null;
};

export type PullRequestReview = {
  author: string;
  state: string;
  submittedAt: string | null;
  body: string;
};

export type SourceComparison = {
  path: string;
  base: string | null;
  head: string | null;
  truncated: boolean;
  reason?: string;
};

export type PullRequestBundle = PullRequestListItem & {
  body: string;
  state: string;
  mergeable: string;
  baseRefOid: string;
  createdAt: string;
  commits: Array<{ oid: string; messageHeadline: string; authoredDate: string }>;
  reviews: PullRequestReview[];
  files: PullRequestFile[];
  branchProtection: {
    known: boolean;
    requiredApprovals: number | null;
    reason?: string;
  };
};

export type AiReviewFinding = {
  severity: "blocking" | "high" | "medium" | "low" | "info";
  title: string;
  explanation: string;
  file?: string;
  line?: number;
  evidence: string;
};

export type AiMergeReview = {
  verdict: "merge" | "needs_changes" | "manual_review" | "insufficient_evidence";
  confidence: number;
  summary: string;
  findings: AiReviewFinding[];
  sourceComparisons: Array<{ path: string; reason: string; result: string }>;
  requirements: string[];
  unknowns: string[];
  reviewedHeadSha: string;
  reviewedAt: string;
  model: string;
};

export type MergeMethod = "merge" | "squash" | "rebase";

export type RepositoryMergePolicy = {
  mergeMethod: MergeMethod;
  requireChecks: boolean;
  requireReview: boolean;
  blockDraft: boolean;
  blockChangesRequested: boolean;
  maxFiles: number;
  maxChangedLines: number;
  minimumAiConfidence: number;
  manualOnlyPaths: string[];
  sourceReadMaxFiles: number;
  sourceReadMaxBytes: number;
};

export type MergeGate = {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
};

export type MergeGateEvaluation = {
  allowed: boolean;
  gates: MergeGate[];
};

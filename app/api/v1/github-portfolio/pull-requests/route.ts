import { z } from "zod";
import { cached, invalidateCache } from "@/src/modules/github-portfolio/web-cache";
import { runAiMergeReview } from "@/src/modules/github-portfolio/agent-review";
import {
  collectSourceComparisons,
  getPullRequestBundle,
  listOpenPullRequests,
  mergePullRequest,
  openPullRequestCounts,
} from "@/src/modules/github-portfolio/github-cli";
import {
  consumeMergePlan,
  createMergePlan,
  evaluateMergeGates,
  getAiReview,
  getMergePolicy,
  listCachedAiReviews,
  saveAiReview,
  saveMergePolicy,
} from "@/src/modules/github-portfolio/merge-governance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const aiReviewInFlight = new Map<string, Promise<Awaited<ReturnType<typeof runAiMergeReview>>>>();

const repositorySchema = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const pullNumberSchema = z.coerce.number().int().positive();
const policySchema = z.object({
  mergeMethod: z.enum(["merge", "squash", "rebase"]),
  requireChecks: z.boolean(),
  requireReview: z.boolean(),
  blockDraft: z.boolean(),
  blockChangesRequested: z.boolean(),
  maxFiles: z.number().int().min(1).max(500),
  maxChangedLines: z.number().int().min(1).max(100_000),
  minimumAiConfidence: z.number().min(0.5).max(1),
  manualOnlyPaths: z.array(z.string().min(1).max(200)).max(50),
  sourceReadMaxFiles: z.number().int().min(1).max(30),
  sourceReadMaxBytes: z.number().int().min(1_000).max(500_000),
});

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "PR 操作失败";
  const status = error instanceof z.ZodError ? 400 : 502;
  return Response.json({ ok: false, error: message }, { status });
}

function identity(input: URLSearchParams | Record<string, unknown>) {
  const get = (key: string) => input instanceof URLSearchParams ? input.get(key) : input[key];
  return {
    repository: repositorySchema.parse(String(get("repository") || "")),
    number: pullNumberSchema.parse(get("number")),
  };
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const action = url.searchParams.get("action") || "list";
    if (action === "list") {
      const result = await cached("pull-requests:list", 90_000, () => listOpenPullRequests());
      return Response.json({ ok: true, data: result.value, cache: { hit: result.cached, ageMs: result.ageMs } });
    }
    if (action === "overview-reviews") {
      return Response.json({ ok: true, data: await listCachedAiReviews() });
    }
    if (action === "open-counts") {
      const repositories = String(url.searchParams.get("repositories") || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .slice(0, 120);
      const result = await cached(`pull-requests:open-counts:${repositories.join(",")}`, 5 * 60_000, () => openPullRequestCounts(repositories));
      return Response.json({ ok: true, data: result.value, cache: { hit: result.cached, ageMs: result.ageMs } });
    }
    const { repository, number } = identity(url.searchParams);
    if (action === "policy") {
      return Response.json({ ok: true, data: await getMergePolicy(repository) });
    }
    if (action === "sources") {
      const bundle = await getPullRequestBundle(repository, number);
      const policy = await getMergePolicy(repository);
      const result = await cached(`pull-requests:sources:${repository}#${number}#${bundle.headRefOid}`, 10 * 60_000, () => collectSourceComparisons(bundle, policy));
      return Response.json({ ok: true, data: result.value, cache: { hit: result.cached, ageMs: result.ageMs } });
    }
    if (action !== "detail") return Response.json({ ok: false, error: "Unsupported action" }, { status: 400 });
    const bundleResult = await cached(`pull-requests:bundle:${repository}#${number}`, 90_000, () => getPullRequestBundle(repository, number));
    const bundle = bundleResult.value;
    const [policy, review] = await Promise.all([
      getMergePolicy(repository),
      getAiReview(repository, number, bundle.headRefOid),
    ]);
    return Response.json({
      ok: true,
      data: { bundle, policy, review, evaluation: evaluateMergeGates(bundle, review, policy) },
      cache: { hit: bundleResult.cached, ageMs: bundleResult.ageMs },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const action = String(body.action || "");
    const { repository, number } = identity(body);
    if (action === "save-policy") {
      const policy = policySchema.parse(body.policy);
      const result = await saveMergePolicy(repository, policy);
      await invalidateCache([`pull-requests:sources:${repository}`, `pull-requests:bundle:${repository}#${number}`]);
      return Response.json({ ok: true, data: result });
    }
    const bundle = await getPullRequestBundle(repository, number);
    const policy = await getMergePolicy(repository);
    if (action === "ai-review") {
      const reviewKey = `${repository}#${number}#${bundle.headRefOid}`;
      let reviewPromise = aiReviewInFlight.get(reviewKey);
      if (!reviewPromise) {
        reviewPromise = (async () => {
          const sources = await collectSourceComparisons(bundle, policy);
          const review = await runAiMergeReview(bundle, sources, policy);
          await saveAiReview(repository, number, review);
          return review;
        })();
        aiReviewInFlight.set(reviewKey, reviewPromise);
        void reviewPromise.then(() => aiReviewInFlight.delete(reviewKey), () => aiReviewInFlight.delete(reviewKey));
      }
      const review = await reviewPromise;
      return Response.json({
        ok: true,
        data: { review, evaluation: evaluateMergeGates(bundle, review, policy) },
      });
    }
    const review = await getAiReview(repository, number, bundle.headRefOid);
    if (action === "plan-merge") {
      return Response.json({ ok: true, data: await createMergePlan(bundle, review, policy) });
    }
    if (action === "apply-merge") {
      const token = z.string().min(20).parse(body.confirmationToken);
      const plan = await consumeMergePlan(bundle, review, policy, token);
      const result = await mergePullRequest(repository, number, plan.headSha, plan.method);
      if (!result.merged) throw new Error(result.message || "GitHub 未确认合并成功");
      await invalidateCache(["pull-requests:list", `pull-requests:bundle:${repository}#${number}`, `pull-requests:sources:${repository}`]);
      return Response.json({ ok: true, data: result });
    }
    return Response.json({ ok: false, error: "Unsupported action" }, { status: 400 });
  } catch (error) {
    return errorResponse(error);
  }
}

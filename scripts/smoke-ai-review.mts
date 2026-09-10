import { runAiMergeReview } from "../src/modules/github-portfolio/agent-review";
import { collectSourceComparisons, getPullRequestBundle } from "../src/modules/github-portfolio/github-cli";
import { getMergePolicy } from "../src/modules/github-portfolio/merge-governance";

const repository = process.argv[2] || "redmaplewww/psych-support-bot";
const number = Number(process.argv[3] || 2);
const bundle = await getPullRequestBundle(repository, number);
const policy = await getMergePolicy(repository);
const sources = await collectSourceComparisons(bundle, policy);
const review = await runAiMergeReview(bundle, sources, policy);
console.log(JSON.stringify({ verdict: review.verdict, confidence: review.confidence, model: review.model, head: review.reviewedHeadSha, summary: review.summary }, null, 2));

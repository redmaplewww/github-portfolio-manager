import { GithubPullRequestWorkbench } from "@/components/github-pr-review-workbench";

export const metadata = {
  title: "PR 审查台 · 代码版图",
  description: "在控制台内预览 Diff 与源码，运行 AI 审查并受控合并 GitHub PR。",
};

export default function GithubPullRequestReviewPage() {
  return <GithubPullRequestWorkbench />;
}

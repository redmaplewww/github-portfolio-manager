import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PullRequestBundle, RepositoryMergePolicy } from "@/src/modules/github-portfolio/contracts";

const HEAD_SHA = "1234567890abcdef1234567890abcdef12345678";

const policy: RepositoryMergePolicy = {
  mergeMethod: "squash",
  requireChecks: true,
  requireReview: true,
  blockDraft: true,
  blockChangesRequested: true,
  maxFiles: 40,
  maxChangedLines: 1500,
  minimumAiConfidence: 0.8,
  manualOnlyPaths: [".github/workflows/"],
  sourceReadMaxFiles: 12,
  sourceReadMaxBytes: 80_000,
};

function bundle(): PullRequestBundle {
  return {
    repository: "owner/repository",
    number: 7,
    title: "Bounded change",
    body: "A bounded test change.",
    author: "developer",
    headRefName: "feature/safe",
    baseRefName: "main",
    headRefOid: HEAD_SHA,
    baseRefOid: "abcdef1234567890abcdef1234567890abcdef12",
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
    checks: [],
    commits: [],
    reviews: [],
    files: [],
    branchProtection: { known: false, requiredApprovals: null },
  };
}

function validReview(overrides: Record<string, unknown> = {}) {
  return {
    verdict: "merge",
    confidence: 0.9,
    summary: "没有发现代码级阻断风险",
    findings: [],
    sourceComparisons: [],
    requirements: [],
    unknowns: [],
    reviewedHeadSha: HEAD_SHA,
    ...overrides,
  };
}

function chatCompletion(content: string) {
  const mid = Math.ceil(content.length / 2);
  const events = [content.slice(0, mid), content.slice(mid)]
    .map((part) => `data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`)
    .join("");
  return new Response(`${events}data: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function jsonCompletion(content: string) {
  return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), { status: 200, headers: { "content-type": "application/json" } });
}

type RecordedCall = { url: string; body: Record<string, unknown> };

function mockFetch(handlers: Array<(url: string) => Response | Promise<Response>>) {
  const calls: RecordedCall[] = [];
  let index = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    const handler = handlers[Math.min(index, handlers.length - 1)];
    index += 1;
    const result = handler(url);
    return result instanceof Response ? result : await result;
  }));
  return calls;
}

function socketDeath(): Promise<Response> {
  const error = new TypeError("fetch failed") as TypeError & { cause: { code: string } };
  error.cause = { code: "UND_ERR_SOCKET" };
  return Promise.reject(error);
}

async function importAgent() {
  vi.resetModules();
  return import("@/src/modules/github-portfolio/agent-review");
}

beforeEach(() => {
  vi.stubEnv("GITHUB_PR_REVIEW_API_KEY", "");
  vi.stubEnv("GITHUB_PR_REVIEW_BASE_URL", "");
  vi.stubEnv("GITHUB_PR_REVIEW_MODEL", "");
  vi.stubEnv("GITHUB_PR_REVIEW_REASONING_EFFORT", "");
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("OPENAI_BASE_URL", "");
  vi.stubEnv("OPENAI_MODEL", "");
  vi.stubEnv("LLM_API_KEY", "test-key");
  vi.stubEnv("LLM_BASE_URL", "https://llm.test/v1");
  vi.stubEnv("LLM_MODEL", "test-model");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("runAiMergeReview", () => {
  it("直连 chat completions 并解析结构化审查结论", async () => {
    const calls = mockFetch([() => chatCompletion(JSON.stringify(validReview()))]);
    const { runAiMergeReview } = await importAgent();
    const review = await runAiMergeReview(bundle(), [], policy);
    expect(review.verdict).toBe("merge");
    expect(review.reviewedHeadSha).toBe(HEAD_SHA);
    expect(review.model).toBe("test-model");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://llm.test/v1/chat/completions");
    expect(calls[0].body.model).toBe("test-model");
    expect(calls[0].body.stream).toBe(true);
    expect((calls[0].body.messages as Array<{ role: string }>)[0].role).toBe("system");
    expect((calls[0].body.response_format as Record<string, unknown>).type).toBe("json_schema");
    expect(calls[0].body.reasoning_effort).toBe("medium");
  });

  it("base URL 不带 /v1 时自动探测正确端点并缓存", async () => {
    vi.stubEnv("LLM_BASE_URL", "https://llm.test");
    const calls = mockFetch([
      () => new Response("<!doctype html><title>gateway home</title>", { status: 200, headers: { "content-type": "text/html" } }),
      () => chatCompletion(JSON.stringify(validReview())),
      () => chatCompletion(JSON.stringify(validReview())),
    ]);
    const { runAiMergeReview } = await importAgent();
    await runAiMergeReview(bundle(), [], policy);
    await runAiMergeReview(bundle(), [], policy);
    expect(calls).toHaveLength(3);
    expect(calls[0].url).toBe("https://llm.test/chat/completions");
    expect(calls[1].url).toBe("https://llm.test/v1/chat/completions");
    expect(calls[2].url).toBe("https://llm.test/v1/chat/completions");
  });

  it("json_schema 被拒绝时降级为 json_object", async () => {
    const calls = mockFetch([
      () => new Response("response_format not supported", { status: 400 }),
      () => chatCompletion(JSON.stringify(validReview())),
    ]);
    const { runAiMergeReview } = await importAgent();
    const review = await runAiMergeReview(bundle(), [], policy);
    expect(review.verdict).toBe("merge");
    expect(calls).toHaveLength(2);
    expect((calls[1].body.response_format as Record<string, unknown>).type).toBe("json_object");
    expect(calls[1].body.reasoning_effort).toBeUndefined();
  });

  it("json_object 也被拒绝时降级为纯提示请求（兼容非流式 JSON 响应）", async () => {
    const calls = mockFetch([
      () => new Response("bad", { status: 400 }),
      () => new Response("bad", { status: 400 }),
      () => jsonCompletion(JSON.stringify(validReview())),
    ]);
    const { runAiMergeReview } = await importAgent();
    const review = await runAiMergeReview(bundle(), [], policy);
    expect(review.verdict).toBe("merge");
    expect(calls).toHaveLength(3);
    expect(calls[2].body.response_format).toBeUndefined();
  });

  it("输出非法时追加一次修复调用并接受被代码块包裹的 JSON", async () => {
    const calls = mockFetch([
      () => chatCompletion("这个 PR 看起来没有问题，可以合并。"),
      () => chatCompletion("```json\n" + JSON.stringify(validReview()) + "\n```"),
    ]);
    const { runAiMergeReview } = await importAgent();
    const review = await runAiMergeReview(bundle(), [], policy);
    expect(review.verdict).toBe("merge");
    expect(calls).toHaveLength(2);
    const messages = calls[1].body.messages as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(4);
    expect(messages[2].role).toBe("assistant");
    expect(messages[3].role).toBe("user");
    expect(messages[3].content).toContain("未通过校验");
  });

  it("审查提交与当前 PR 不一致时失败关闭", async () => {
    mockFetch([() => chatCompletion(JSON.stringify(validReview({ reviewedHeadSha: "0000000000000000000000000000000000000000" })))]);
    const { runAiMergeReview } = await importAgent();
    await expect(runAiMergeReview(bundle(), [], policy)).rejects.toThrow("审查提交与当前 PR 不一致");
  });

  it("缺少 API Key 时给出明确配置错误且不发起请求", async () => {
    vi.stubEnv("LLM_API_KEY", "");
    const calls = mockFetch([() => chatCompletion(JSON.stringify(validReview()))]);
    const { runAiMergeReview } = await importAgent();
    await expect(runAiMergeReview(bundle(), [], policy)).rejects.toThrow("缺少 AI 配置");
    expect(calls).toHaveLength(0);
  });

  it("缺少模型名时给出明确配置错误", async () => {
    vi.stubEnv("LLM_MODEL", "");
    const { runAiMergeReview } = await importAgent();
    await expect(runAiMergeReview(bundle(), [], policy)).rejects.toThrow("GITHUB_PR_REVIEW_MODEL");
  });

  it("接口无响应超过时限后中止请求而不是永久挂起", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", (_input: string | URL, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const aborted = new Error("The operation was aborted");
        aborted.name = "AbortError";
        reject(aborted);
      });
    }));
    const { runAiMergeReview } = await importAgent();
    const pending = runAiMergeReview(bundle(), [], policy);
    const expectation = expect(pending).rejects.toThrow("超时");
    await vi.advanceTimersByTimeAsync(150_000);
    await expectation;
  });

  it("连接被中间层掐断时自动重试并成功", async () => {
    const calls = mockFetch([socketDeath, () => chatCompletion(JSON.stringify(validReview()))]);
    const { runAiMergeReview } = await importAgent();
    const review = await runAiMergeReview(bundle(), [], policy);
    expect(review.verdict).toBe("merge");
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.url === "https://llm.test/v1/chat/completions")).toBe(true);
  });

  it("连接重试耗尽后带原因失败关闭", async () => {
    const calls = mockFetch([socketDeath, socketDeath, socketDeath]);
    const { runAiMergeReview } = await importAgent();
    await expect(runAiMergeReview(bundle(), [], policy)).rejects.toThrow("UND_ERR_SOCKET");
    expect(calls).toHaveLength(3);
  });
});

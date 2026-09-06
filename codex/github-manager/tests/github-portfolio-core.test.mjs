import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyCollaboratorChange,
  collaboratorChangeToken,
  configureReporting,
  loadState,
  manageAssignments,
  renderSummaryMarkdown,
  updateTracking,
} from "../scripts/github-portfolio-core.mjs";

async function tempEnv() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "github-portfolio-manager-"));
  return { GITHUB_PORTFOLIO_HOME: directory };
}

test("tracking is empty by default and changes only after explicit selection", async () => {
  const env = await tempEnv();
  const before = await loadState(env);
  assert.deepEqual(before.state.trackedRepositories, []);
  const gh = { json: async () => ({ id: 1 }) };
  const added = await updateTracking({ repositories: ["acme/api", "acme/web"], mode: "add", env, gh });
  assert.deepEqual(added.trackedRepositories, ["acme/api", "acme/web"]);
  const removed = await updateTracking({ repositories: ["acme/api"], mode: "remove", env, gh });
  assert.deepEqual(removed.trackedRepositories, ["acme/web"]);
});

test("reporting cannot be enabled before repository selection", async () => {
  const env = await tempEnv();
  await assert.rejects(() => configureReporting({ enabled: true, cadence: "weekly", timezone: "Asia/Shanghai", destination: "thread", env }), /Select at least one/);
});

test("assignments are local and support upsert and removal", async () => {
  const env = await tempEnv();
  await manageAssignments({ repository: "acme/api", people: [{ login: "alice", responsibility: "maintainer" }], mode: "upsert", env });
  const afterAdd = await loadState(env);
  assert.equal(afterAdd.state.assignments["acme/api"][0].responsibility, "maintainer");
  await manageAssignments({ repository: "acme/api", people: [{ login: "alice" }], mode: "remove", env });
  const afterRemove = await loadState(env);
  assert.equal(afterRemove.state.assignments["acme/api"], undefined);
});

test("collaborator mutation rejects an unbound confirmation token without writing", async () => {
  const env = await tempEnv();
  const calls = [];
  const gh = {
    async json(args) {
      calls.push(args);
      if (args.includes("--method")) throw new Error("write should not happen");
      return [[{ login: "alice", role_name: "push", permissions: { push: true } }]];
    },
  };
  await assert.rejects(() => applyCollaboratorChange({ repository: "acme/api", login: "alice", operation: "update", permission: "maintain", confirmationToken: "wrong", env, gh }), /not applied/);
  assert.equal(calls.some((args) => args.includes("--method")), false);
});

test("collaborator token binds repository, login, operation, role, and requested permission", () => {
  const first = collaboratorChangeToken({ repository: "acme/api", login: "alice", operation: "update", permission: "maintain", currentRole: "push" });
  const changed = collaboratorChangeToken({ repository: "acme/api", login: "alice", operation: "update", permission: "admin", currentRole: "push" });
  assert.notEqual(first, changed);
});

test("markdown keeps contribution metrics explicitly non-evaluative", () => {
  const markdown = renderSummaryMarkdown({
    window: { since: "2026-08-01T00:00:00.000Z", until: "2026-08-08T00:00:00.000Z" },
    scope: ["acme/api"],
    failures: [],
    totals: { opened: 1, merged: 1, currentlyOpen: 0, awaitingReview: 0, changesRequested: 0, stale: 0 },
    repositories: [{ repository: { nameWithOwner: "acme/api", url: "https://github.com/acme/api" }, counts: { opened: 1, merged: 1, currentlyOpen: 0, awaitingReview: 0, changesRequested: 0, stale: 0 }, prQueue: [] }],
    contributors: [{ login: "alice", touchedPullRequests: 1, opened: 1, merged: 1, currentlyOpen: 0, reviewsSubmitted: 0, additions: 10, deletions: 2, changedFiles: 1, commits: 1 }],
  });
  assert.match(markdown, /不等同绩效评分/);
  assert.match(markdown, /不能单独代表工时/);
});

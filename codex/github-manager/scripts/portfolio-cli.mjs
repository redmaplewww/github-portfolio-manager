#!/usr/bin/env node
import {
  configureReporting,
  discoverRepositories,
  loadState,
  listCollaborators,
  manageAssignments,
  planCollaboratorChange,
  portfolioStatus,
  summarizePortfolio,
  applyCollaboratorChange,
  updateTracking,
} from "./github-portfolio-core.mjs";

function option(args, name, fallback = undefined) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function positional(args) {
  const result = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index].startsWith("--")) {
      if (index + 1 < args.length && !args[index + 1].startsWith("--")) index += 1;
      continue;
    }
    result.push(args[index]);
  }
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const command = args.shift() ?? "status";
  let result;
  if (command === "status") result = await portfolioStatus();
  else if (command === "discover") result = await discoverRepositories({ visibility: option(args, "--visibility", "all"), includeArchived: args.includes("--include-archived"), limit: Number(option(args, "--limit", 500)) });
  else if (command === "tracked") result = await updateTracking({ repositories: [], mode: "add", verifyAccess: false });
  else if (command === "track") result = await updateTracking({ repositories: positional(args), mode: option(args, "--mode", "replace"), verifyAccess: !args.includes("--no-verify") });
  else if (command === "summary") result = await summarizePortfolio({ since: option(args, "--since"), until: option(args, "--until"), staleDays: Number(option(args, "--stale-days", 7)), advanceCheckpoint: args.includes("--advance-checkpoint") });
  else if (command === "assignments") result = (await loadState()).state.assignments;
  else if (command === "collaborators") result = await listCollaborators({ repository: positional(args)[0] });
  else if (command === "plan-collaborator") result = await planCollaboratorChange({ repository: positional(args)[0], login: positional(args)[1], operation: option(args, "--operation", "add"), permission: option(args, "--permission", "push") });
  else if (command === "apply-collaborator") result = await applyCollaboratorChange({ repository: positional(args)[0], login: positional(args)[1], operation: option(args, "--operation", "add"), permission: option(args, "--permission", "push"), confirmationToken: option(args, "--confirmation-token"), syncAssignment: !args.includes("--no-sync") });
  else if (command === "assign") result = await manageAssignments({ repository: positional(args)[0], mode: option(args, "--mode", "upsert"), people: [{ login: positional(args)[1], responsibility: option(args, "--responsibility", "contributor"), notes: option(args, "--notes", "") }] });
  else if (command === "reporting") result = await configureReporting({ enabled: args.includes("--enable") ? true : args.includes("--disable") ? false : undefined, cadence: option(args, "--cadence"), timezone: option(args, "--timezone"), destination: option(args, "--destination") });
  else throw new Error(`Unknown command: ${command}`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ error: error.code ?? "CLI_FAILED", message: error.message, details: error.details }, null, 2)}\n`);
  process.exitCode = 1;
});

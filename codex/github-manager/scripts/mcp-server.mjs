import {
  PortfolioError,
  applyCollaboratorChange,
  configureReporting,
  discoverRepositories,
  listCollaborators,
  loadState,
  manageAssignments,
  planCollaboratorChange,
  portfolioStatus,
  summarizePortfolio,
  updateTracking,
} from "./github-portfolio-core.mjs";
import readline from "node:readline";

const tools = [
  {
    name: "portfolio_status",
    description: "Check GitHub authentication, tracked repositories, assignment coverage, reporting configuration, and the local state path without exposing tokens.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "discover_repositories",
    description: "List repositories the authenticated GitHub user can access. Discovery never adds repositories to tracking automatically.",
    inputSchema: {
      type: "object",
      properties: {
        visibility: { type: "string", enum: ["all", "public", "private", "internal"], default: "all" },
        includeArchived: { type: "boolean", default: false },
        limit: { type: "integer", minimum: 1, maximum: 1000, default: 500 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "update_tracking",
    description: "Replace, add, or remove the local list of repositories selected for ongoing tracking. Access is verified before adding by default.",
    inputSchema: {
      type: "object",
      required: ["repositories"],
      properties: {
        repositories: { type: "array", items: { type: "string", pattern: "^[^/]+/[^/]+$" } },
        mode: { type: "string", enum: ["replace", "add", "remove"], default: "replace" },
        verifyAccess: { type: "boolean", default: true },
      },
      additionalProperties: false,
    },
  },
  {
    name: "summarize_portfolio",
    description: "Create Markdown and JSON summaries for tracked repositories, including PR queue, review state, stale PRs, assignments, and per-author PR/code-volume facts. Code volume is never a performance score.",
    inputSchema: {
      type: "object",
      properties: {
        repositories: { type: "array", items: { type: "string" }, description: "Optional one-off scope; defaults to the tracked list." },
        since: { type: "string", description: "ISO timestamp or relative value such as 7d. Defaults to last successful checkpoint or seven days." },
        until: { type: "string", description: "ISO timestamp. Defaults to now." },
        staleDays: { type: "integer", minimum: 1, maximum: 365, default: 7 },
        advanceCheckpoint: { type: "boolean", default: false, description: "Advance only when every repository succeeds." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "manage_assignments",
    description: "Maintain the local repository-to-person assignment map. This does not change GitHub access.",
    inputSchema: {
      type: "object",
      required: ["repository", "people"],
      properties: {
        repository: { type: "string" },
        mode: { type: "string", enum: ["replace", "upsert", "remove"], default: "replace" },
        people: {
          type: "array",
          items: {
            type: "object",
            required: ["login"],
            properties: {
              login: { type: "string" },
              responsibility: { type: "string", default: "contributor" },
              notes: { type: "string", default: "" },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "read_assignments",
    description: "Read the current local repository assignment map without calling GitHub.",
    inputSchema: { type: "object", properties: { repository: { type: "string" } }, additionalProperties: false },
  },
  {
    name: "list_collaborators",
    description: "Read the current GitHub collaborators and repository roles for one repository.",
    inputSchema: { type: "object", required: ["repository"], properties: { repository: { type: "string" } }, additionalProperties: false },
  },
  {
    name: "plan_collaborator_change",
    description: "Read current collaborator state and prepare a bound add, permission update, or removal plan. Planning does not change GitHub.",
    inputSchema: {
      type: "object",
      required: ["repository", "login", "operation"],
      properties: {
        repository: { type: "string" },
        login: { type: "string" },
        operation: { type: "string", enum: ["add", "update", "remove"] },
        permission: { type: "string", enum: ["pull", "triage", "push", "maintain", "admin"], default: "push" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "apply_collaborator_change",
    description: "Apply a previously planned GitHub collaborator change. Requires the exact confirmation token and interactive tool approval; never call from a scheduled report.",
    inputSchema: {
      type: "object",
      required: ["repository", "login", "operation", "confirmationToken"],
      properties: {
        repository: { type: "string" },
        login: { type: "string" },
        operation: { type: "string", enum: ["add", "update", "remove"] },
        permission: { type: "string", enum: ["pull", "triage", "push", "maintain", "admin"], default: "push" },
        confirmationToken: { type: "string" },
        syncAssignment: { type: "boolean", default: true },
      },
      additionalProperties: false,
    },
  },
  {
    name: "configure_reporting",
    description: "Store the intended reporting cadence, timezone, destination, and enabled state. This does not create a Codex automation by itself.",
    inputSchema: {
      type: "object",
      properties: {
        enabled: { type: "boolean" },
        cadence: { type: "string" },
        timezone: { type: "string" },
        destination: { type: "string" },
      },
      additionalProperties: false,
    },
  },
];

async function callTool(name, args) {
  switch (name) {
    case "portfolio_status": return portfolioStatus();
    case "discover_repositories": return discoverRepositories(args);
    case "update_tracking": return updateTracking(args);
    case "summarize_portfolio": return summarizePortfolio(args);
    case "manage_assignments": return manageAssignments(args);
    case "list_collaborators": return listCollaborators(args);
    case "plan_collaborator_change": return planCollaboratorChange(args);
    case "apply_collaborator_change": return applyCollaboratorChange(args);
    case "configure_reporting": return configureReporting(args);
    case "read_assignments": {
      const { state, statePath } = await loadState();
      if (!args.repository) return { assignments: state.assignments, statePath };
      return { repository: args.repository, assignments: state.assignments[args.repository] ?? [], statePath };
    }
    default: throw new PortfolioError("UNKNOWN_TOOL", `Unknown tool: ${name}`);
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(message) {
  const id = message.id;
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id, result: { protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "github-portfolio-manager", version: "0.1.0" } } });
    return;
  }
  if (message.method === "ping") {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools } });
    return;
  }
  if (message.method === "tools/call") {
    try {
      const result = await callTool(message.params?.name, message.params?.arguments ?? {});
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result } });
    } catch (error) {
      const payload = { error: error.code ?? "TOOL_FAILED", message: error.message, details: error.details };
      send({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], structuredContent: payload } });
    }
    return;
  }
  if (id !== undefined && !String(message.method ?? "").startsWith("notifications/")) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${message.method}` } });
  }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", async (line) => {
  if (!line.trim()) return;
  try {
    await handle(JSON.parse(line));
  } catch (error) {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: error.message } });
  }
});

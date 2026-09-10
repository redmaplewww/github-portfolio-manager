import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { cacheInfo, cached, invalidateCache } from "@/src/modules/github-portfolio/web-cache";

const execFileAsync = promisify(execFile);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_PLUGIN_ROOT = path.resolve(process.cwd(), "codex", "github-manager");
const COMMANDS = new Set([
  "status",
  "discover",
  "tracked",
  "summary",
  "assignments",
  "collaborators",
  "track",
  "assign",
  "reporting",
  "plan-collaborator",
  "apply-collaborator",
]);

type JsonRecord = Record<string, unknown>;

function pluginRoot() {
  return process.env.GITHUB_PORTFOLIO_PLUGIN_ROOT || DEFAULT_PLUGIN_ROOT;
}

function cliPath() {
  return path.join(pluginRoot(), "scripts", "portfolio-cli.mjs");
}

async function runCli(args: string[]) {
  const { stdout } = await execFileAsync(process.execPath, [cliPath(), ...args], {
    cwd: pluginRoot(),
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    env: process.env,
  });
  return JSON.parse(String(stdout || "null"));
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "GitHub portfolio operation failed";
  return Response.json({ ok: false, error: message }, { status: 502 });
}

function commandFromUrl(request: Request) {
  const url = new URL(request.url);
  const action = url.searchParams.get("action") || "status";
  if (!COMMANDS.has(action)) throw new Error(`Unsupported action: ${action}`);
  const args = [action];
  if (action === "discover") {
    args.push("--visibility", url.searchParams.get("visibility") || "all", "--limit", url.searchParams.get("limit") || "100");
    if (url.searchParams.get("includeArchived") === "true") args.push("--include-archived");
  }
  if (action === "summary") args.push("--since", url.searchParams.get("since") || "30d");
  if (action === "collaborators" && url.searchParams.get("repository")) args.push(url.searchParams.get("repository")!);
  return args;
}

export async function GET(request: Request) {
  try {
    const args = commandFromUrl(request);
    const action = args[0];
    // Authentication and repository discovery are stable enough for a warm
    // console session; keep them local for minutes instead of re-running `gh`
    // on every page mount. Mutations below invalidate the affected keys.
    const ttl = action === "status" ? 5 * 60_000 : action === "discover" ? 10 * 60_000 : action === "summary" ? 5 * 60_000 : 60_000;
    const result = await cached(`portfolio:${action}:${args.slice(1).join("|")}`, ttl, () => runCli(args));
    return Response.json({ ok: true, data: result.value, cache: { hit: result.cached, ageMs: result.ageMs, path: cacheInfo().path } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as JsonRecord;
    const action = String(body.action || "");
    if (!COMMANDS.has(action) || ["status", "discover", "summary", "collaborators", "tracked", "assignments"].includes(action)) {
      return Response.json({ ok: false, error: "Unsupported write action" }, { status: 400 });
    }
    const args = [action];
    const text = (key: string, fallback = "") => String(body[key] ?? fallback).trim();
    const add = (key: string) => { const value = text(key); if (value) args.push(value); };
    if (action === "track") {
      const repositories = Array.isArray(body.repositories) ? body.repositories.map(String).filter(Boolean) : [];
      args.push(...repositories, "--mode", text("mode", "replace"));
      if (body.verifyAccess === false) args.push("--no-verify");
    } else if (action === "assign") {
      add("repository"); add("login"); args.push("--mode", text("mode", "upsert"), "--responsibility", text("responsibility", "contributor"), "--notes", text("notes"));
    } else if (action === "reporting") {
      if (body.enabled === true) args.push("--enable");
      if (body.enabled === false) args.push("--disable");
      args.push("--cadence", text("cadence", "weekly"), "--timezone", text("timezone", "Asia/Shanghai"), "--destination", text("destination", "current Codex task"));
    } else if (action === "plan-collaborator" || action === "apply-collaborator") {
      add("repository"); add("login"); args.push("--operation", text("operation", "add"), "--permission", text("permission", "push"));
      if (action === "apply-collaborator") args.push("--confirmation-token", text("confirmationToken"));
    }
    const result = await runCli(args);
    await invalidateCache(["portfolio:status", "portfolio:tracked", "portfolio:assignments", "portfolio:summary"]);
    return Response.json({ ok: true, data: result });
  } catch (error) {
    return errorResponse(error);
  }
}

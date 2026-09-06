import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));

test("MCP server initializes and exposes portfolio tools", async () => {
  const child = spawn(process.execPath, [path.resolve(directory, "../scripts/mcp-server.mjs")], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const lines = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => lines.push(...chunk.trim().split(/\r?\n/).filter(Boolean)));
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("MCP response timeout")), 3000);
    const interval = setInterval(() => {
      if (lines.length >= 2) {
        clearInterval(interval);
        clearTimeout(timeout);
        resolve();
      }
    }, 20);
  });
  child.kill();
  const messages = lines.map((line) => JSON.parse(line));
  assert.equal(messages[0].result.serverInfo.name, "github-portfolio-manager");
  const names = messages[1].result.tools.map((tool) => tool.name);
  assert.ok(names.includes("summarize_portfolio"));
  assert.ok(names.includes("apply_collaborator_change"));
  assert.ok(names.includes("configure_reporting"));
});

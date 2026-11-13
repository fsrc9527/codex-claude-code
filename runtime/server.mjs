import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import packageInfo from "./package.json" with { type: "json" };
import { openRuns, summarizeRun } from "./runs.mjs";
import { createTurns, errorMessage } from "./turns.mjs";

const runId = z.uuid().describe("Run ID from run, follow_up, or trace");
const turnOptions = {
  task: z.string().trim().min(1).describe("One scoped task or follow-up for Claude Code"),
  edit: z.boolean().default(false).describe("Allow workspace file edits when authorized"),
  timeout_seconds: z.number().int().min(1).max(600).default(180),
};
const turnAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

function reply(data, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    ...(isError ? { isError: true } : {}),
  };
}

const databasePath = process.env.CLAUDE_CODE_MCP_DB;
if (!databasePath) throw new Error("Start the MCP server with the installed launch.mjs.");

const runs = openRuns(databasePath);
const turns = createTurns(runs, process.env.CLAUDE_CODE_MCP_CLI_HINT, process.env.CLAUDE_CODE_MCP_PROVIDER);
const server = new McpServer({ name: "claude_code", version: packageInfo.version }, {
  instructions: "Delegate run and follow_up to the native claude_code subagent to keep each turn visible and stoppable. Use trace for run history and tool outcomes. Use cancel to stop a turn by ID. Enable edit only when authorized.",
});

function register(name, options, handler) {
  server.registerTool(name, options, async (args, extra) => {
    try {
      runs.recoverDisconnected();
      return await handler(args, extra);
    } catch (error) {
      return reply({ error: errorMessage(error) }, true);
    }
  });
}

async function run(options, extra, resume) {
  const result = await turns.execute(options, extra, resume);
  return reply(result, result.status !== "succeeded");
}

register("run", {
  title: "Run a Claude Code task",
  description: "Send a task to Claude Code and save its session for follow-up. The call stays open until the task stops.",
  inputSchema: {
    cwd: z.string().trim().min(1).describe("Absolute directory of the selected project"),
    model: z.string().trim().min(1).optional().describe("Explicit model on the configured provider. Omit to use the bridge's provider default."),
    ...turnOptions,
  },
  annotations: turnAnnotations,
}, run);

register("follow_up", {
  title: "Continue a Claude Code session",
  description: "Continue the Claude Code session and model of a prior run with a new instruction.",
  inputSchema: { run_id: runId, ...turnOptions },
  annotations: turnAnnotations,
}, ({ run_id, ...options }, extra) => {
  const prior = runs.get(run_id);
  if (!prior) throw new Error("Claude Code run was not found.");
  return run({ ...options, cwd: prior.cwd, model: prior.model ?? undefined }, extra, prior.session_id);
});

register("trace", {
  title: "Inspect Claude Code runs",
  description: "Look up status and a page of recorded tool steps. Omit run_id to see active and recent runs.",
  inputSchema: {
    run_id: runId.optional(),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(50).default(10),
    include_answer: z.boolean().default(false),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
}, ({ run_id, offset, limit, include_answer }) => {
  if (!run_id) return reply({ runs: runs.recent(limit, offset).map(summarizeRun) });
  const row = runs.getDetails(run_id);
  if (!row) throw new Error("Claude Code run was not found.");
  const { steps: savedSteps, answer, ...run } = row;
  const steps = JSON.parse(savedSteps);
  const page = steps.slice(offset, offset + limit);
  const next = offset + page.length;
  return reply({
    ...summarizeRun(run),
    steps: page.map((step, index) => ({ step: offset + index + 1, ...step })),
    next_offset: next < steps.length ? next : null,
    ...(include_answer && answer !== null ? { answer } : {}),
  });
});

register("cancel", {
  title: "Stop a Claude Code turn",
  description: "Interrupt an active Claude Code turn by run ID. Returns its current status, including cancelling while it stops.",
  inputSchema: { run_id: runId },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ run_id }) => reply(await turns.cancel(run_id)));

process.stdin.once("end", turns.stopAll);
await server.connect(new StdioServerTransport());

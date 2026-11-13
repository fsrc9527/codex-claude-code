import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { findClaudeCli } from "./claude-cli.mjs";
import { providerOptions } from "./provider.mjs";
import { summarizeRun } from "./runs.mjs";

const readTools = ["Read", "Grep", "Glob"];
const editTools = [...readTools, "Edit", "Write"];

function compactText(value, limit) {
  const text = Array.isArray(value)
    ? value.map(item => typeof item === "string" ? item : item?.text ?? "").join(" ")
    : String(value ?? "");
  return text.replace(/\s+/g, " ").trim().slice(0, limit);
}

export function errorMessage(error) {
  const message = compactText(error instanceof Error ? error.message : error, 1200);
  return message || "Claude Code failed without an error message.";
}

function displayPath(cwd, path) {
  if (!isAbsolute(path)) return path;
  const local = relative(cwd, path);
  if (isAbsolute(local) || local === ".." || local.startsWith(".." + sep)) return path;
  return local || ".";
}

function recordSteps(steps, content, cwd) {
  if (!Array.isArray(content)) return [];
  const changed = [];
  for (const block of content) {
    if (block.type === "tool_use") {
      const step = { status: "running", ...steps.get(block.id), tool: block.name };
      for (const key of ["file_path", "path", "pattern", "glob"]) {
        const value = block.input?.[key];
        if (typeof value !== "string") continue;
        const detail = key === "file_path" || key === "path" ? displayPath(cwd, value) : value;
        step[key] = detail.slice(0, 240);
      }
      steps.set(block.id, step);
      changed.push(step);
    } else if (block.type === "tool_result") {
      const step = { tool: "unknown", ...steps.get(block.tool_use_id) };
      step.status = block.is_error ? "error" : "ok";
      if (block.is_error) step.error = compactText(block.content, 240);
      else delete step.error;
      steps.set(block.tool_use_id, step);
      changed.push(step);
    }
  }
  return changed;
}

function reportProgress(extra, id) {
  const progressToken = extra._meta?.progressToken;
  let progress = 0;
  return message => {
    if (progressToken === undefined || extra.signal.aborted) return;
    void extra.sendNotification({
      method: "notifications/progress",
      params: { progressToken, progress: ++progress, message: `Claude Code ${id} ${message}` },
    }).catch(() => {});
  };
}

function finalAnswer(result) {
  if (!result) throw new Error("Claude Code exited without a final result.");
  if (result.subtype !== "success" || result.is_error) {
    throw new Error(compactText(result.errors ?? result.result ?? result.subtype, 1200)
      || "Claude Code reported a failure.");
  }
  const answer = typeof result.result === "string" ? result.result.trim() : "";
  if (!answer) throw new Error("Claude Code returned an empty answer.");
  return answer;
}

function isAuthError(event) {
  return event.error === "authentication_failed" || event.error === "oauth_org_not_allowed" ||
    (event.type === "system" && event.subtype === "api_retry" && [401, 403].includes(event.error_status));
}

export function createTurns(runs, cliPath, provider) {
  const active = new Map();

  async function execute({ cwd, task, model, edit, timeout_seconds }, extra, resume) {
    if (extra.signal.aborted) return { status: "cancelled" };
    if (!isAbsolute(cwd)) throw new Error("Pass an absolute working directory.");
    cwd = realpathSync(cwd);
    if (!statSync(cwd).isDirectory()) throw new Error("The working directory must be a directory.");
    const claudePath = findClaudeCli(cliPath);
    if (!claudePath) {
      throw new Error("Install Claude Code and configure its provider. See https://code.claude.com/docs/en/setup.");
    }

    const connection = providerOptions(provider, model);
    const id = randomUUID();
    const sessionId = resume ?? randomUUID();
    runs.begin({ id, cwd, sessionId, model: connection.model });
    const steps = new Map();
    const tools = edit ? editTools : readTools;
    const progress = reportProgress(extra, id);
    const abortController = new AbortController();
    const input = Promise.withResolvers();
    let execution;
    let result;
    let outcome;
    let stopped;
    let cancelPoll;
    let deadline;
    let forceStop;

    function stop(status, error) {
      if (stopped || result) return;
      stopped = { status, error };
      forceStop = setTimeout(() => abortController.abort(), 2200);
      void execution.interrupt().catch(() => abortController.abort());
      try {
        runs.requestCancel(id);
      } catch (cause) {
        console.error("Could not record the Claude Code stop request.", errorMessage(cause));
      }
    }

    const cancel = () => stop("cancelled");
    try {
      execution = query({
        prompt: (async function* () {
          yield {
            type: "user",
            message: { role: "user", content: [{ type: "text", text: task }] },
            session_id: sessionId,
            parent_tool_use_id: null,
          };
          // Keep stdin available for the SDK interrupt command until the turn ends.
          await input.promise;
        })(),
        options: {
          pathToClaudeCodeExecutable: claudePath,
          abortController,
          cwd,
          ...connection,
          ...(resume ? { resume } : { sessionId }),
          strictMcpConfig: true,
          tools,
          allowedTools: tools,
          disallowedTools: ["mcp__*"],
          permissionMode: "dontAsk",
          extraArgs: { "safe-mode": null },
        },
      });
      active.set(id, cancel);
      extra.signal.addEventListener("abort", cancel, { once: true });
      // A cancellation can arrive through a separate Codex MCP process.
      cancelPoll = setInterval(() => {
        if (stopped || result) return;
        try {
          if (runs.cancelRequested(id)) cancel();
        } catch (error) {
          stop("failed", errorMessage(error));
        }
      }, 250);
      deadline = setTimeout(() => stop("timed_out", "Claude Code reached the requested time limit."), timeout_seconds * 1000);
      progress("started");

      for await (const event of execution) {
        if (isAuthError(event)) {
          stop("failed", "Claude Code's provider rejected authentication. Check the active provider's credentials and access.");
          break;
        }
        if (event.type === "result" || (event.type === "system" && event.subtype === "init")) {
          if (event.session_id !== sessionId) throw new Error("Claude Code returned a different session ID.");
          if (event.type === "result") {
            result = event;
            break;
          }
          if (event.model) runs.saveModel(id, event.model);
          continue;
        }
        if ((event.type !== "assistant" && event.type !== "user") || event.isReplay) continue;
        const changed = recordSteps(steps, event.message.content, cwd);
        if (!changed.length) continue;
        runs.saveSteps(id, [...steps.values()]);
        for (const step of changed) {
          progress([step.tool, step.file_path ?? step.path, step.status].filter(Boolean).join(" "));
        }
      }
      outcome = { status: "succeeded", answer: finalAnswer(result) };
    } catch (error) {
      outcome = { status: "failed", error: errorMessage(error) };
    } finally {
      input.resolve();
      clearInterval(cancelPoll);
      clearTimeout(deadline);
      extra.signal.removeEventListener("abort", cancel);
      active.delete(id);
      try {
        await execution?.return();
      } catch (error) {
        outcome = { status: "failed", error: errorMessage(error) };
      }
      clearTimeout(forceStop);
    }

    outcome = stopped ?? outcome;
    runs.finish(id, outcome);
    const errors = [...steps.values()].filter(step => step.status === "error");
    return {
      ...summarizeRun(runs.get(id)),
      ...(outcome.answer !== undefined ? { answer: outcome.answer } : {}),
      tool_steps: steps.size,
      tool_errors: errors.length,
      ...(errors.length ? { recent_errors: errors.slice(-2) } : {}),
    };
  }

  async function cancel(id) {
    let run = runs.get(id);
    if (!run) throw new Error("Claude Code run was not found.");
    if (run.status === "running") {
      const stop = active.get(id);
      if (stop) stop();
      else runs.requestCancel(id);

      for (let attempt = 0; attempt < 12 && run.status === "running"; attempt++) {
        await delay(250);
        run = runs.get(id);
      }
    }
    return summarizeRun(run);
  }

  return {
    execute,
    cancel,
    stopAll() {
      for (const stop of active.values()) stop();
    },
  };
}

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const install = JSON.parse(readFileSync(join(root, "current.json"), "utf8"));
if (typeof install.release !== "string" || !/^[0-9a-f]{16}$/.test(install.release)) {
  throw new Error("Invalid Claude Code installation state. Run the installer again.");
}

process.env.CLAUDE_CODE_MCP_DB ??= join(root, "runs.sqlite");
if (install.claudeCliPath) process.env.CLAUDE_CODE_MCP_CLI_HINT = install.claudeCliPath;
process.env.CLAUDE_CODE_MCP_PROVIDER = install.provider ?? "cli";
await import(pathToFileURL(join(root, "releases", install.release, "server.mjs")).href);

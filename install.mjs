#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { findClaudeCli } from "./runtime/claude-cli.mjs";

const source = dirname(fileURLToPath(import.meta.url));
const packageInfo = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));

function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

function writeAtomic(path, content) {
  if (readText(path) === content) return;
  mkdirSync(dirname(path), { recursive: true });
  const staged = join(dirname(path), ".claude-code-" + randomUUID() + ".tmp");
  try {
    writeFileSync(staged, content, { encoding: "utf8", flag: "wx" });
    renameSync(staged, path);
  } finally {
    rmSync(staged, { force: true });
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function installDependencies(directory) {
  const npmArguments = ["ci", "--omit=dev", "--omit=optional", "--ignore-scripts", "--no-audit", "--no-fund"];
  const npmEntry = [
    process.env.npm_execpath,
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ].find(path => path && isAbsolute(path) && path.endsWith("npm-cli.js") && existsSync(path));

  const options = { cwd: directory, stdio: "inherit", windowsHide: true };
  let result;
  if (npmEntry) {
    result = spawnSync(process.execPath, [npmEntry, ...npmArguments], options);
  } else if (process.platform === "win32") {
    result = spawnSync(process.env.ComSpec ?? "cmd.exe", [
      "/d", "/s", "/c", "npm " + npmArguments.join(" "),
    ], options);
  } else {
    result = spawnSync("npm", npmArguments, options);
  }
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("npm ci did not finish successfully.");
}

function prepareRuntime(releases) {
  const runtimeFiles = packageInfo.files.filter(path => path.startsWith("runtime/")).map(path => ({
    name: path.slice("runtime/".length),
    content: readFileSync(join(source, path)),
  }));
  const hash = createHash("sha256");
  for (const { name, content } of runtimeFiles) {
    hash.update(name).update("\0").update(content).update("\0");
  }
  const release = hash.digest("hex").slice(0, 16);

  mkdirSync(releases, { recursive: true });
  const releaseRoot = realpathSync(releases);
  const installed = join(releaseRoot, release);
  if (existsSync(installed)) {
    if (dirname(realpathSync(installed)) !== releaseRoot) {
      throw new Error("The installed runtime is outside its release directory.");
    }
    return { directory: installed, release };
  }

  const staging = mkdtempSync(join(releaseRoot, ".install-"));
  try {
    for (const { name, content } of runtimeFiles) {
      writeFileSync(join(staging, name), content);
    }
    installDependencies(staging);
    renameSync(staging, installed);
  } finally {
    if (existsSync(staging)) {
      const target = realpathSync(staging);
      if (dirname(target) !== releaseRoot) {
        throw new Error("Could not verify the temporary installation directory.");
      }
      rmSync(target, { recursive: true, force: true });
    }
  }
  return { directory: installed, release };
}

function acquireInstallLock(root) {
  const lockPath = join(root, ".install.lock");
  try {
    writeFileSync(lockPath, String(process.pid) + "\n", { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    throw new Error("Another installation may be active. Check " + lockPath + " before retrying.");
  }
  return lockPath;
}

function install(profile, provider) {
  const root = join(profile, "claude-code");
  const manifestPath = join(root, "current.json");
  const launcher = join(root, "launch.mjs");
  const configPath = join(profile, "config.toml");
  const files = [
    ["launch.mjs", launcher],
    ["codex/agents/claude_code.toml", join(profile, "agents", "claude_code.toml")],
    ["codex/skills/claude-code-delegate/SKILL.md", join(profile, "skills", "claude-code-delegate", "SKILL.md")],
  ];

  mkdirSync(root, { recursive: true });
  const lock = acquireInstallLock(root);
  try {
    const previous = JSON.parse(readText(manifestPath) ?? "{}");
    const selectedProvider = provider ?? previous.provider ?? "cli";
    const sources = files.map(([name, path]) => {
      const content = readFileSync(join(source, name), "utf8");
      return { name, path, content, hash: sha256(content) };
    });
    for (const file of sources) {
      const installed = readText(file.path);
      if (installed !== undefined && installed !== file.content && sha256(installed) !== previous.files?.[file.name]) {
        throw new Error("已有同名配置，请先处理冲突再安装。\n" + file.path);
      }
    }

    const claudeCliPath = findClaudeCli(undefined, { searchNpm: true });
    const { directory, release } = prepareRuntime(join(root, "releases"));
    const requireFromRuntime = createRequire(join(directory, "package.json"));
    const { parse, stringify } = requireFromRuntime("smol-toml");
    const config = readText(configPath) ?? "";
    const configured = parse(config).mcp_servers?.claude_code;
    if (configured !== undefined &&
        (typeof configured.command !== "string" || configured.args?.length !== 1 || configured.args[0] !== launcher)) {
      throw new Error("Codex 已配置名为 claude_code 的其他 MCP 服务，请先处理同名配置。\n" + configPath);
    }

    let updatedConfig;
    if (configured === undefined) {
      const entry = "[mcp_servers.claude_code]\n" + stringify({
        command: process.execPath,
        args: [launcher],
        tool_timeout_sec: 660,
        default_tools_approval_mode: "approve",
      });
      const separator = config.endsWith("\n") ? "\n" : "\n\n";
      updatedConfig = config ? config + separator + entry : entry;
      parse(updatedConfig);
    }

    const installed = {
      release,
      claudeCliPath,
      provider: selectedProvider,
      files: Object.fromEntries(sources.map(file => [file.name, file.hash])),
    };
    for (const file of sources) writeAtomic(file.path, file.content);
    writeAtomic(manifestPath, JSON.stringify(installed, null, 2) + "\n");

    if (updatedConfig !== undefined) {
      if ((readText(configPath) ?? "") !== config) {
        throw new Error("Codex 配置在安装时发生变化，请重新运行安装命令。");
      }
      writeAtomic(configPath, updatedConfig);
    }
    return installed;
  } finally {
    unlinkSync(lock);
  }
}

function showNextStep({ claudeCliPath, provider }) {
  if (!claudeCliPath) {
    console.log("请安装 Claude Code 并配置模型供应商。https://code.claude.com/docs/en/setup");
  }
  if (provider === "cc-switch-desktop") {
    console.log("使用 CC Switch 的 Claude Desktop 本地网关，运行任务时保持路由服务开启。");
  }
  console.log("重启 Codex 后，在本地项目对话中使用 $claude-code-delegate。");
}

function main() {
  const { values } = parseArgs({
    options: {
      "codex-home": { type: "string" },
      provider: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log("Usage: node install.mjs [--codex-home <directory>] [--provider cli|cc-switch-desktop]");
    return;
  }

  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 13)) {
    throw new Error("需要 Node.js 22.13 或更高版本。");
  }
  if (values.provider !== undefined && !["cli", "cc-switch-desktop"].includes(values.provider)) {
    throw new Error("请选择 --provider cli 或 --provider cc-switch-desktop。");
  }
  const profile = resolve(values["codex-home"] ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"));
  const installed = install(profile, values.provider);
  console.log("Claude Code 集成已安装到 " + profile);
  showNextStep(installed);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

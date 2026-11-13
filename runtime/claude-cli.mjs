import { spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

const windows = process.platform === "win32";
const executable = windows ? "claude.exe" : "claude";

function canExecute(path) {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function npmExecutable(prefix) {
  const root = windows ? prefix : join(prefix, "lib");
  return join(root, "node_modules", "@anthropic-ai", "claude-code", "bin", executable);
}

export function findClaudeCli(installedPath, { searchNpm = false } = {}) {
  const override = process.env.CLAUDE_CODE_EXECUTABLE;
  if (override) {
    if (!isAbsolute(override) || (windows && !override.toLowerCase().endsWith(".exe")) || !canExecute(override)) {
      throw new Error("CLAUDE_CODE_EXECUTABLE must point to an absolute Claude Code executable path.");
    }
    return override;
  }
  if (installedPath && canExecute(installedPath)) return installedPath;

  const directories = (process.env.PATH ?? "").split(delimiter).filter(isAbsolute);
  directories.push(join(homedir(), ".local", "bin"));
  for (const directory of directories) {
    const direct = join(directory, executable);
    if (canExecute(direct)) return direct;
    // npm on Windows puts a .cmd shim on PATH next to the native package.
    if (windows && canExecute(join(directory, "claude.cmd"))) {
      const native = npmExecutable(directory);
      if (canExecute(native)) return native;
    }
  }

  if (searchNpm) {
    const options = { encoding: "utf8", timeout: 5000, windowsHide: true };
    const result = windows
      ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npm prefix -g"], options)
      : spawnSync("npm", ["prefix", "-g"], options);
    const prefix = result.status === 0 ? result.stdout.trim() : "";
    if (isAbsolute(prefix)) {
      const native = npmExecutable(prefix);
      if (canExecute(native)) return native;
    }
  }
}

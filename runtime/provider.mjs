import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

function desktopLibrary() {
  const home = homedir();
  const roots = {
    win32: process.env.LOCALAPPDATA || join(home, "AppData", "Local"),
    darwin: join(home, "Library", "Application Support"),
    linux: process.env.XDG_CONFIG_HOME || join(home, ".config"),
  };
  const root = roots[process.platform];
  if (!root) throw new Error("CC Switch Desktop mode requires Windows, macOS, or Linux.");
  return join(root, "Claude-3p", "configLibrary");
}

function desktopProfile() {
  try {
    const directory = desktopLibrary();
    const read = name => JSON.parse(readFileSync(join(directory, name), "utf8").replace(/^\uFEFF/, ""));
    const { appliedId } = read("_meta.json");
    if (typeof appliedId === "string" && /^[0-9a-f-]{36}$/i.test(appliedId)) {
      return read(appliedId + ".json");
    }
  } catch {
    // Report how to select the profile without including settings or credentials.
  }
  throw new Error("Select a Claude Desktop provider in CC Switch with Model Mapping enabled.");
}

function gatewayToken() {
  try {
    const database = new DatabaseSync(join(homedir(), ".cc-switch", "cc-switch.db"), { readOnly: true });
    try {
      const row = database.prepare("SELECT value FROM settings WHERE key = ?").get("claude_desktop_gateway_token");
      if (row?.value?.trim()) return row.value.trim();
    } finally {
      database.close();
    }
  } catch {
    // The gateway credential belongs to the local CC Switch installation.
  }
  throw new Error("CC Switch Desktop gateway authentication is unavailable. Reapply the Desktop provider in CC Switch.");
}

export function desktopModelIds(profile = desktopProfile()) {
  return [...new Set((Array.isArray(profile.inferenceModels) ? profile.inferenceModels : [])
    .map(entry => typeof entry === "string" ? entry : entry?.name)
    .filter(name => typeof name === "string" && name))];
}

export function providerEfforts(provider, model, advertised) {
  if (provider !== "cc-switch-desktop" || !advertised.length) return advertised;
  try {
    const database = new DatabaseSync(join(homedir(), ".cc-switch", "cc-switch.db"), { readOnly: true });
    try {
      const row = database.prepare("SELECT settings_config, meta FROM providers WHERE app_type = 'claude-desktop' AND is_current = 1").get();
      const settings = JSON.parse(row?.settings_config ?? "{}");
      const meta = JSON.parse(row?.meta ?? "{}");
      const endpoint = URL.parse(settings.env?.ANTHROPIC_BASE_URL ?? "");
      const route = model.replace(/\s*\[1m\]$/i, "");
      const upstreamModel = meta.claudeDesktopModelRoutes?.[route]?.model;
      if (meta.apiFormat === "anthropic" && endpoint?.hostname === "api.deepseek.com" &&
          /^deepseek-(?:flash|v4-flash|v4-pro)$/.test(upstreamModel ?? "")) {
        // The official DeepSeek route maps medium and xhigh to high.
        return advertised.filter(level => ["low", "high", "max"].includes(level));
      }
    } finally {
      database.close();
    }
  } catch {
    // Other or older gateways can still use the Claude Code catalog.
  }
  return advertised;
}

export function providerOptions(provider, model) {
  const env = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "codex-claude-code" };
  if (provider !== "cc-switch-desktop") return { env, model, settingSources: ["user"] };

  const profile = desktopProfile();
  const endpoint = URL.parse(profile.inferenceGatewayBaseUrl ?? "");
  if (!endpoint || endpoint.protocol !== "http:" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname) ||
      !["/claude-desktop", "/claude-desktop/"].includes(endpoint.pathname) ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("CC Switch Desktop mode needs its local Model Mapping gateway.");
  }
  const models = desktopModelIds(profile);
  const selectedModel = model ?? models.find(name => /^(anthropic\/)?claude-haiku-/.test(name)) ?? models[0];
  if (!selectedModel) throw new Error("No model is configured on the CC Switch Desktop gateway.");

  const noProxy = env.NO_PROXY || env.no_proxy;
  for (const key of Object.keys(env)) {
    if (/^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_|NO_PROXY$)/i.test(key)) delete env[key];
  }
  // Keep the Desktop gateway credential on the local machine.
  env.NO_PROXY = [noProxy, "localhost", "127.0.0.1", "::1"].filter(Boolean).join(",");
  env.ANTHROPIC_BASE_URL = endpoint.origin + "/claude-desktop";
  env.ANTHROPIC_AUTH_TOKEN = gatewayToken();
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  return { env, model: selectedModel, settingSources: [] };
}

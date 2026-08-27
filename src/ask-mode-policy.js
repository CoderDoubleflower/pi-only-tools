import { MODE_PROTOCOL_PROMPT } from "./mode-cache-policy.js";
import {
  ASK_USER_QUESTION_TOOL,
  ENTER_PLAN_MODE_TOOL,
  LEGACY_EXIT_PLAN_MODE_TOOL,
  MODE_STATUS_KEY_PREFIX,
  PLAN_WRITE_TOOL,
  READ_ONLY_PLAN_TOOLS,
} from "./plan/constants.js";

export const ASK_MODE_PROFILE = "ask";
export const ASK_MODE_STATE_ENTRY = "pi-only-tools-ask-mode-state";
export const ASK_MODE_STATUS_KEY = `${MODE_STATUS_KEY_PREFIX}-ask`;
export const ASK_MODE_STATE_VERSION = 1;

export const DEFAULT_ASK_TOOLS = Object.freeze([
  ...READ_ONLY_PLAN_TOOLS,
  ASK_USER_QUESTION_TOOL,
]);

export const ASK_MODE_FORBIDDEN_TOOLS = Object.freeze([
  "shell_command",
  "apply_patch",
  "bash",
  "powershell",
  "edit",
  "write",
  ENTER_PLAN_MODE_TOOL,
  PLAN_WRITE_TOOL,
  LEGACY_EXIT_PLAN_MODE_TOOL,
]);

const ASK_MODE_FORBIDDEN_TOOL_SET = new Set(ASK_MODE_FORBIDDEN_TOOLS);

function uniqueToolNames(values) {
  const result = [];
  const seen = new Set();
  for (const value of values ?? []) {
    if (typeof value !== "string") continue;
    const name = value.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    result.push(name);
  }
  return result;
}

/**
 * Ask is an explicit user-maintained allowlist. Pi does not expose a generic
 * read-only annotation for custom tools, so /only-tools is the source of truth
 * for third-party and MCP tools. Known command/edit/control tools stay locked
 * off even if they appear in an older configuration.
 */
export function isAskToolConfigurable(value) {
  if (typeof value !== "string") return false;
  const name = value.trim();
  return Boolean(name) && !ASK_MODE_FORBIDDEN_TOOL_SET.has(name);
}

// Backward-compatible export for the first Ask Mode implementation.
export const isAskReadOnlyToolName = isAskToolConfigurable;

export function normalizeAskTools(values) {
  return uniqueToolNames(values).filter(isAskToolConfigurable);
}

export function getDefaultAskTools(allToolNames) {
  const selected = normalizeAskTools(DEFAULT_ASK_TOOLS);
  if (!(allToolNames instanceof Set)) return selected;
  return selected.filter((name) => allToolNames.has(name));
}

export function buildAskTools(configuredTools, allToolNames) {
  const selected = configuredTools ?? getDefaultAskTools(allToolNames);
  const allowed = normalizeAskTools(selected);
  if (!(allToolNames instanceof Set)) return allowed;
  return allowed.filter((name) => allToolNames.has(name));
}

export function isAskToolAllowed(toolName, configuredTools, allToolNames) {
  return buildAskTools(configuredTools, allToolNames).includes(toolName);
}

/**
 * Keep the provider-prefix system prompt byte-stable across Normal, Ask, and
 * Plan. The active mode and allowlist are emitted separately as a hidden
 * runtime state message by ToolProfileController.
 */
export function buildAskSystemPrompt(_allowedTools) {
  return MODE_PROTOCOL_PROMPT;
}

export const __test = {
  ASK_MODE_FORBIDDEN_TOOL_SET,
  uniqueToolNames,
};

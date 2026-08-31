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
 * for third-party and MCP tools. Known write/control tools stay locked off.
 * Native `bash` is the deliberate exception needed by skills; its no-write
 * contract is enforced as model policy rather than by the tool capability.
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

function formatToolNames(toolNames) {
  return toolNames.length > 0
    ? toolNames.map((name) => `\`${name}\``).join(", ")
    : "none";
}

export function buildAskSystemPrompt(allowedTools) {
  return `[ASK MODE ACTIVE]

You are answering the user's question in a strictly read-only investigation mode. You may inspect existing information and explain what you find, but you are not implementing, editing, or executing a plan.

Hard constraints:
- These Ask Mode constraints override any earlier planning, approved-plan, execution, or implementation instructions in the system prompt.
- Do not create, modify, move, rename, or delete files, including through bash, output redirection, tee, in-place flags, generated scripts, patch utilities, formatters, or code generators.
- Do not change configuration, dependencies, Git state, external systems, running services, or user data.
- bash may be used only for commands required by an enabled skill or for read-only inspection such as listing, searching, reading, and reporting existing state.
- Every bash command must be non-mutating. Do not install packages, write files, alter repositories, or run a command when its side effects are uncertain.
- Do not use bash to bypass a blocked editing or write tool.
- The Ask Profile configured in /only-tools is the explicit tool allowlist for this mode: ${formatToolNames(allowedTools)}.
- Use an allowed tool only for reading, searching, listing, fetching, inspecting, or asking a material clarification question.
- User configuration grants tool visibility, not permission to perform a write or side effect.
- Do not attempt to bypass a blocked or unavailable tool.
- Report command observations accurately, but do not claim that files or state were changed.

Answering process:
- Inspect the minimum relevant sources needed for an accurate answer.
- Clearly distinguish verified facts from inference.
- Answer the user's question directly and concisely after investigation.
- You may describe possible changes, but do not apply them and do not publish an implementation plan unless the user switches to Plan Mode.`;
}

export const __test = {
  ASK_MODE_FORBIDDEN_TOOL_SET,
  uniqueToolNames,
};

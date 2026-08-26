import {
  ASK_USER_QUESTION_TOOL,
  READ_ONLY_PLAN_TOOLS,
} from "./plan/constants.js";

export const ASK_MODE_PROFILE = "ask";
export const ASK_MODE_STATE_ENTRY = "pi-only-tools-ask-mode-state";
export const ASK_MODE_STATUS_KEY = "pi-only-tools-ask-mode";
export const ASK_MODE_STATE_VERSION = 1;

export const DEFAULT_ASK_TOOLS = Object.freeze([
  ...READ_ONLY_PLAN_TOOLS,
  ASK_USER_QUESTION_TOOL,
]);

const DEFAULT_ASK_TOOL_SET = new Set(DEFAULT_ASK_TOOLS);
const READ_ONLY_NAME_PATTERN =
  /(?:^|[_:./-])(read|get|list|search|find|grep|ls|show|view|fetch|inspect|lookup|status|diff|history|log|stat|count)(?:$|[_:./-])/i;

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
 * Ask Mode is fail-closed. A tool must either be one of Pi's known read-only
 * tools or have a clearly read-oriented name. Shell/command tools are therefore
 * never admitted merely because their prompt asks the model to behave safely.
 */
export function isAskReadOnlyToolName(value) {
  if (typeof value !== "string") return false;
  const name = value.trim();
  if (!name) return false;
  return DEFAULT_ASK_TOOL_SET.has(name) || READ_ONLY_NAME_PATTERN.test(name);
}

export function normalizeAskTools(values) {
  return uniqueToolNames(values).filter(isAskReadOnlyToolName);
}

export function getDefaultAskTools(allToolNames) {
  const selected = [...DEFAULT_ASK_TOOLS];
  if (!(allToolNames instanceof Set)) return selected;
  return selected.filter((name) => allToolNames.has(name));
}

export function buildAskTools(configuredTools, allToolNames) {
  const selected = configuredTools ?? getDefaultAskTools(allToolNames);
  const readOnly = normalizeAskTools(selected);
  if (!(allToolNames instanceof Set)) return readOnly;
  return readOnly.filter((name) => allToolNames.has(name));
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
- Do not create, modify, move, rename, or delete files.
- Do not change configuration, dependencies, Git state, external systems, running services, or user data.
- Do not run shell commands, scripts, builds, tests, installers, or any other operation that may have side effects.
- The only tools available in Ask Mode are: ${formatToolNames(allowedTools)}.
- Use those tools only for reading, searching, listing, fetching, inspecting, or asking a material clarification question.
- An allowed tool name does not grant permission to use it for a write or side effect.
- Do not attempt to bypass a blocked or unavailable tool.
- Do not claim that code was changed, commands were run, or tests passed.

Answering process:
- Inspect the minimum relevant sources needed for an accurate answer.
- Clearly distinguish verified facts from inference.
- Answer the user's question directly and concisely after investigation.
- You may describe possible changes, but do not apply them and do not publish an implementation plan unless the user switches to Plan Mode.`;
}

export const __test = {
  READ_ONLY_NAME_PATTERN,
  uniqueToolNames,
};

import { MODE_PROTOCOL_PROMPT } from "../mode-cache-policy.js";

/**
 * Planning and ready stages intentionally share one static protocol with
 * Normal and Ask. Dynamic plan paths, revisions, hashes, stages, and tool
 * allowlists live in the hidden mode-state message so they do not invalidate
 * the cached system-prompt prefix.
 */
export function buildPlanningSystemPrompt(state, _allowedToolsOrHasQuestionTool, _maybeHasQuestionTool) {
  return state?.plan ? MODE_PROTOCOL_PROMPT : "";
}

export function buildReadySystemPrompt(state) {
  return state?.plan ? MODE_PROTOCOL_PROMPT : "";
}

/**
 * Approved-plan metadata is already present in the hidden handoff and mode
 * state. Normal Mode's controller appends the shared protocol during execution.
 */
export function buildExecutionSystemPrompt(_state) {
  return "";
}

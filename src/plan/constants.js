export const ENTER_PLAN_MODE_TOOL = "EnterPlanMode";
export const PLAN_WRITE_TOOL = "plan_write";
export const ASK_USER_QUESTION_TOOL = "ask_user_question";

// Compatibility-only identifier for configurations and transcripts created by
// releases that exposed ExitPlanMode to the model. The tool is no longer
// registered or activated by the Plan workflow.
export const LEGACY_EXIT_PLAN_MODE_TOOL = "ExitPlanMode";
export const EXIT_PLAN_MODE_TOOL = LEGACY_EXIT_PLAN_MODE_TOOL;

export const READ_ONLY_PLAN_TOOLS = ["read", "grep", "find", "ls"];
export const PLAN_STATE_ENTRY = "claude-plan-mode-state";
export const PLAN_HANDOFF_MESSAGE = "claude-plan-mode-handoff";
export const PLAN_CONTINUE_MESSAGE = "claude-plan-mode-continuation";
export const MODE_STATUS_KEY_PREFIX = "00-pi-only-tools-mode";
export const PLAN_STATUS_KEY = `${MODE_STATUS_KEY_PREFIX}-plan`;
export const PLAN_WIDGET_KEY = "claude-plan-mode";
export const PLAN_TEMPLATE_MARKER = "<!-- pi-claude-plan-mode:template -->";
export const STATE_SCHEMA_VERSION = 1;

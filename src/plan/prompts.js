import {
  ASK_USER_QUESTION_TOOL,
  PLAN_WRITE_TOOL,
  READ_ONLY_PLAN_TOOLS,
} from "./constants.js";

let legacySystemPromptsDisabled = false;

export function disableLegacyModeSystemPrompts() {
  legacySystemPromptsDisabled = true;
}

function formatToolNames(toolNames) {
  return toolNames.length > 0
    ? toolNames.map((name) => `\`${name}\``).join(", ")
    : "none";
}

function planningInputs(state, allowedToolsOrHasQuestionTool, maybeHasQuestionTool) {
  const hasQuestionTool =
    typeof allowedToolsOrHasQuestionTool === "boolean"
      ? allowedToolsOrHasQuestionTool
      : maybeHasQuestionTool === true;
  const allowedTools =
    typeof allowedToolsOrHasQuestionTool === "boolean"
      ? state.planningTools ?? [
          ...READ_ONLY_PLAN_TOOLS,
          ...(hasQuestionTool ? [ASK_USER_QUESTION_TOOL] : []),
        ]
      : [...(allowedToolsOrHasQuestionTool ?? [])];
  return { allowedTools, hasQuestionTool };
}

// Compatibility entry points used by the legacy workflow hook. The integrated
// wrapper disables them and injects one cache-stable system protocol instead.
export function buildPlanningSystemPrompt(state, allowedToolsOrHasQuestionTool, maybeHasQuestionTool) {
  if (legacySystemPromptsDisabled) return "";
  return buildPlanningModeContext(state, allowedToolsOrHasQuestionTool, maybeHasQuestionTool);
}

export function buildReadySystemPrompt(state) {
  if (legacySystemPromptsDisabled) return "";
  return buildReadyModeContext(state);
}

export function buildExecutionSystemPrompt(state) {
  if (legacySystemPromptsDisabled) return "";
  return buildExecutionModeContext(state, state?.executionTools ?? state?.baseline?.tools ?? []);
}

export function buildPlanningModeContext(
  state,
  allowedToolsOrHasQuestionTool,
  maybeHasQuestionTool,
) {
  if (!state.plan) return "";
  const { allowedTools, hasQuestionTool } = planningInputs(
    state,
    allowedToolsOrHasQuestionTool,
    maybeHasQuestionTool,
  );
  const questionInstruction = hasQuestionTool
    ? `Use ${ASK_USER_QUESTION_TOOL} only when the user's decision materially changes the implementation.`
    : "Ask a concise clarification question in normal text only when the user's decision materially changes the implementation.";

  return `[PI ONLY TOOLS MODE CONTEXT]
mode=plan
stage=planning
allowed_tools=${JSON.stringify(allowedTools)}
plan_path=${JSON.stringify(state.plan.path)}
plan_revision=${state.plan.revision}
plan_sha256=${state.plan.hash}

[PLAN MODE ACTIVE]

You are investigating and designing an implementation plan. You are not implementing it.

Hard constraints:
- Do not modify project files, configuration, dependencies, Git state, external systems, or running services.
- The only writable artifact is the canonical plan document below, and it may only be replaced with ${PLAN_WRITE_TOOL}.
- The configured Plan tool allowlist is: ${formatToolNames(allowedTools)}.
- A tool outside that allowlist may remain visible only because the provider catalogue is kept stable for prompt caching; do not call it.
- Use allowed tools only for repository investigation, clarification, and planning. An allowed tool does not grant permission to perform side effects.
- Do not claim that code was changed or tests were run.
- Do not attempt to bypass blocked or unavailable tools.

Canonical plan:
- Path: ${state.plan.path}
- Revision: ${state.plan.revision}
- SHA-256: ${state.plan.hash}

Planning process:

### Phase 1: Repository reconnaissance
- Read the relevant entrypoints and critical files directly.
- Trace the complete control flow and data flow that the change affects.
- Find analogous implementations, existing conventions, and reusable functions, types, and UI components.
- Do not construct the plan from search snippets alone.

### Phase 2: Resolve material uncertainty
- Separate verified repository facts from assumptions.
- Resolve ambiguity before selecting an implementation. ${questionInstruction}
- Do not leave unresolved alternatives in the final plan.

### Phase 3: Design one recommended solution
- Follow the existing architecture and naming conventions.
- Define affected files, state transitions, ownership boundaries, sequencing, compatibility behavior, error paths, and verification strategy.
- Avoid speculative refactors outside the user's requested scope.

### Phase 4: Publish the complete plan
Replace the initial template completely with ${PLAN_WRITE_TOOL}. Pass the full Markdown document, never a patch or fragment.

Visible-language contract:
- Write the H1 title, every H2/H3 heading, step title, prose paragraph, and descriptive list label in the language used by the user's current request.
- If the conversation contains multiple languages, follow the language explicitly requested by the user; otherwise follow the dominant language of the latest task.
- Do not retain English template headings when the user is communicating in another language.
- Keep code identifiers, file paths, commands, API names, and quoted repository symbols unchanged.

The final plan must use this semantic structure and order:
- A single outcome-oriented H1 title.
- First, a required H2 section that concisely describes the problem, constraints, and intended outcome.
- Second, a required H2 section covering the verified Current State: name the relevant existing files and symbols, explain the current control/data flow, and identify the concrete gap. Localize the visible heading instead of using this English semantic label.
- Third, a required H2 section containing ordered numbered implementation steps. Each step must have a meaningful title and identify exact file paths, the concrete change, existing functions/types/components to reuse, the resulting flow, and sequencing dependencies when relevant.
- Optionally, one H2 section for real migration, recovery, concurrency, compatibility, or rollback concerns.
- Last, a required H2 section containing repository-supported commands plus integration or manual behaviors that prove the change works.
- Use exactly four required H2 sections, or five when the optional risks/compatibility section is necessary. Put any additional subdivisions under H3 headings or lists, not extra H2 headings, so the language-independent structure remains machine-verifiable.

Final-plan quality rules:
- Include only the recommended approach.
- Remove rejected alternatives, raw exploration notes, speculation, unresolved questions, and template placeholders.
- Use only paths, symbols, and commands verified from the repository.
- Keep paragraphs short and use structured lists so the plan is easy to scan.
- Make the plan detailed enough that another agent can implement it without rediscovering the design.
- Do not restate the user's request as filler or claim implementation/verification already happened.

### Phase 5: Stop for user review
- A valid ${PLAN_WRITE_TOOL} call publishes the plan and ends the planning turn automatically.
- After it succeeds, stop and wait for the user to execute, edit, or send feedback on the plan.
- Do not call any exit, approval, or execution tool.
- Do not begin implementation until the user explicitly chooses to execute the reviewed plan.`;
}

export function buildReadyModeContext(state) {
  if (!state.plan) return "";
  return `[PI ONLY TOOLS MODE CONTEXT]
mode=plan
stage=ready
allowed_tools=[]
plan_path=${JSON.stringify(state.plan.path)}
plan_revision=${state.plan.revision}
plan_sha256=${state.plan.hash}

[PLAN READY FOR USER REVIEW]

The canonical plan at ${state.plan.path}, revision ${state.plan.revision}, is awaiting user review.
Do not call tools and do not implement it.
The user may execute it through the review menu or /plan-approve, edit it, or provide feedback.
If the user provides ordinary feedback, resume Plan Mode and publish a revised complete plan with ${PLAN_WRITE_TOOL}.`;
}

export function buildExecutionModeContext(state, allowedTools = []) {
  if (!state.approved) return "";
  return `[PI ONLY TOOLS MODE CONTEXT]
mode=normal
stage=executing
allowed_tools=${JSON.stringify(allowedTools)}
approved_revision=${state.approved.revision}
approved_sha256=${state.approved.hash}

[EXECUTING USER-APPROVED PLAN]

Implement the exact approved plan revision ${state.approved.revision} (${state.approved.hash}).
Use only the Normal profile tools allowed for this session: ${formatToolNames(allowedTools)}.
A tool outside that allowlist may remain visible only because the provider catalogue is kept stable for prompt caching; do not call it.
Keep scope stable, verify changes appropriately, and report blockers rather than silently changing the design.`;
}

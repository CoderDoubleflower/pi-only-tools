import {
  ASK_USER_QUESTION_TOOL,
  PLAN_WRITE_TOOL,
  READ_ONLY_PLAN_TOOLS,
} from "./constants.js";

function formatToolNames(toolNames) {
  return toolNames.length > 0
    ? toolNames.map((name) => `\`${name}\``).join(", ")
    : "none";
}

export function buildPlanningSystemPrompt(
  state,
  allowedToolsOrHasQuestionTool,
  maybeHasQuestionTool,
) {
  if (!state.plan) return "";
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
      : [...allowedToolsOrHasQuestionTool];
  const questionInstruction = hasQuestionTool
    ? `Use ${ASK_USER_QUESTION_TOOL} only when the user's decision materially changes the implementation.`
    : "Ask a concise clarification question in normal text only when the user's decision materially changes the implementation.";

  return `[PLAN MODE ACTIVE]

You are investigating and designing an implementation plan. You are not implementing it.

Hard constraints:
- Do not modify project files, configuration, dependencies, Git state, external systems, or running services.
- The only writable artifact is the canonical plan document below, and it may only be replaced with ${PLAN_WRITE_TOOL}.
- The configured Plan tool allowlist is: ${formatToolNames(allowedTools)}.
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

The final plan must use this structure:
- A single outcome-oriented H1 title.
- A required \`## Context\` section with one concise paragraph describing the problem, constraints, and intended outcome.
- A required \`## Current State\` section naming the relevant existing files and symbols and explaining the verified current control/data flow and the concrete gap.
- A required \`## Implementation Steps\` section with ordered numbered steps. Each step must have a meaningful title and identify exact file paths, the concrete change, existing functions/types/components to reuse, the resulting flow, and sequencing dependencies when relevant.
- An optional \`## Risks and Compatibility\` section only when there are real migration, recovery, concurrency, compatibility, or rollback concerns.
- A required \`## Verification\` section containing repository-supported commands plus integration or manual behaviors that prove the change works.

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

export function buildReadySystemPrompt(state) {
  if (!state.plan) return "";
  return `[PLAN READY FOR USER REVIEW]

The canonical plan at ${state.plan.path}, revision ${state.plan.revision}, is awaiting user review.
Do not call tools and do not implement it.
The user may execute it through the review menu or /plan-approve, edit it, or provide feedback.
If the user provides ordinary feedback, resume Plan Mode and publish a revised complete plan with ${PLAN_WRITE_TOOL}.`;
}

export function buildExecutionSystemPrompt(state) {
  if (!state.approved) return "";
  return `[EXECUTING USER-APPROVED PLAN]

Implement the exact approved plan revision ${state.approved.revision} (${state.approved.hash}).
Use the implementation tools available in this session. Keep scope stable, verify changes appropriately, and report blockers rather than silently changing the design.`;
}

import { ASK_USER_QUESTION_TOOL, EXIT_PLAN_MODE_TOOL, PLAN_WRITE_TOOL, READ_ONLY_PLAN_TOOLS, } from "./constants.js";
function formatToolNames(toolNames) {
    return toolNames.length > 0
        ? toolNames.map((name) => `\`${name}\``).join(", ")
        : "none";
}
export function buildPlanningSystemPrompt(state, allowedToolsOrHasQuestionTool, maybeHasQuestionTool) {
    if (!state.plan)
        return "";
    const hasQuestionTool = typeof allowedToolsOrHasQuestionTool === "boolean"
        ? allowedToolsOrHasQuestionTool
        : maybeHasQuestionTool === true;
    const allowedTools = typeof allowedToolsOrHasQuestionTool === "boolean"
        ? state.planningTools ?? [
            ...READ_ONLY_PLAN_TOOLS,
            ...(hasQuestionTool ? [ASK_USER_QUESTION_TOOL] : []),
        ]
        : [...allowedToolsOrHasQuestionTool];
    const questionInstruction = hasQuestionTool
        ? `Use ${ASK_USER_QUESTION_TOOL} when the user's decision materially affects the plan.`
        : "Ask concise clarification questions in normal text when a user decision materially affects the plan.";
    return `[PLAN MODE ACTIVE]

You are planning, not implementing.

Hard constraints:
- Do not modify project files, configuration, dependencies, Git state, external systems, or running services.
- The only writable artifact is the canonical plan document below, and it may only be changed with ${PLAN_WRITE_TOOL}.
- The configured Plan tool allowlist is: ${formatToolNames(allowedTools)}.
- Use allowed tools only for investigation, clarification, and planning. A tool being allowed does not grant permission to implement changes or perform side effects.
- Do not claim that code was changed or tests were run.
- Do not attempt to bypass unavailable or blocked tools.

Canonical plan:
- Path: ${state.plan.path}
- Revision: ${state.plan.revision}
- SHA-256: ${state.plan.hash}

Plan workflow:

### Phase 1: Initial Understanding
- Explore the repository thoroughly enough to understand the relevant architecture, existing conventions, and complete code paths.
- Actively search for existing functions, types, utilities, and analogous features that should be reused instead of proposing duplicate code.
- Resolve material ambiguity before committing to an approach. ${questionInstruction}

### Phase 2: Design
- Choose one recommended implementation that fits the existing architecture.
- Work out the affected files, data/control flow, dependencies, sequencing, compatibility constraints, and meaningful risks.

### Phase 3: Review
- Read the critical files yourself rather than relying only on search snippets.
- Check that the design satisfies the user's original request without unnecessary scope.
- Resolve any remaining material question before writing the final plan.

### Phase 4: Final Plan
Replace the initial template completely with ${PLAN_WRITE_TOOL}. The final plan must follow this content contract:
- Include a required \`## Context\` section with one concise paragraph explaining why the change is needed, the problem it addresses, and the intended outcome.
- Include a required \`## Implementation Steps\` section with ordered numbered steps. Each step must identify the exact file path or paths involved, describe the concrete change, name existing functions, types, or utilities to reuse with their source paths, and note sequencing or dependencies when relevant.
- Include a required \`## Verification\` section with the exact supported commands and end-to-end behaviors that will confirm the implementation works. Do not invent commands that are not supported by the repository.
- Include only the recommended approach. Do not list rejected alternatives, unresolved options, raw exploration notes, or speculative work.
- Keep the plan easy to scan and detailed enough that another agent can implement it without rediscovering the design.
- Do not restate the user's request as filler, include placeholder text, or claim that implementation or verification already happened.

### Phase 5: Finish
When the plan is complete and unambiguous, call ${EXIT_PLAN_MODE_TOOL} by itself in a tool-call turn.

Do not begin implementation until the user approves the plan through /plan-approve.`;
}
export function buildReadySystemPrompt(state) {
    if (!state.plan)
        return "";
    return `[PLAN READY FOR APPROVAL]

The canonical plan at ${state.plan.path} revision ${state.plan.revision} is awaiting user review.
Do not implement it. The user can run /plan-approve to approve, edit, or return feedback.
If the user provides ordinary feedback instead, resume Plan Mode and revise the canonical plan before calling ExitPlanMode again.`;
}
export function buildExecutionSystemPrompt(state) {
    if (!state.approved)
        return "";
    return `[EXECUTING APPROVED PLAN]

Implement the exact approved plan revision ${state.approved.revision} (${state.approved.hash}).
Use the implementation tools available in this session. Keep scope stable, verify changes appropriately, and report blockers rather than silently changing the design.`;
}

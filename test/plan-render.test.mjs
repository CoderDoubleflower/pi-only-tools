import assert from "node:assert/strict";
import { wrapPlanToolDefinition } from "../src/plan-tool-ui.js";

const theme = {
  fg(color, text) { return `<${color}>${text}</${color}>`; },
  bold(text) { return `<bold>${text}</bold>`; },
};

function visibleText(value) {
  return String(value)
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/<\/?(?:toolTitle|toolOutput|muted|success|warning|error|bold|md-[^>]+)>/g, "");
}

const enter = wrapPlanToolDefinition({ name: "EnterPlanMode" });
assert.equal(enter.renderShell, "self");
const enterCall = enter.renderCall({ reason: "inspect approval flow" }, theme).render(200).join("\n");
assert.match(enterCall, /Enter Plan Mode/);
assert.match(enterCall, /inspect approval flow/);

const planWrite = wrapPlanToolDefinition({ name: "plan_write" });
assert.equal(planWrite.renderShell, "self");
const content = `# User-controlled Plan review

## Context
Keep the plan readable.

## Current State
- \`src/plan/index.js\`: current flow.

## Implementation Steps
1. **Render Markdown**
   - Files: \`src/plan-tool-ui.js\`

## Verification
- Automated: \`npm test\`
- Integration: verify the rendered behavior.
`;
const call = planWrite.renderCall({ content }, theme).render(400).join("\n");
assert.match(call, /Write Plan/);
assert.match(call, /User-controlled Plan review/);
assert.doesNotMatch(call, /## Current State/);

const result = planWrite.renderResult(
  {
    content: [{ type: "text", text: "Plan revision 2 was saved and is awaiting user review." }],
    details: {
      plan: { revision: 2, path: "/tmp/plan.md" },
      readiness: { ready: true, errors: [] },
    },
  },
  { expanded: false, isPartial: false },
  theme,
  { args: { content } },
).render(500).join("\n");
const plainResult = visibleText(result);
assert.match(plainResult, /Plan r2 saved · 1 step · awaiting your review/);
assert.match(plainResult, /User-controlled Plan review/);
assert.match(plainResult, /Current State/);
assert.match(plainResult, /src\/plan\/index\.js/);
assert.doesNotMatch(result, /<muted># User-controlled Plan review/);
assert.doesNotMatch(result, /<toolOutput># User-controlled Plan review/);
assert.doesNotMatch(result, /SHA-256/);

const partial = planWrite.renderResult(
  { content: [], details: {} },
  { expanded: false, isPartial: true },
  theme,
  { args: { content } },
).render(100).join("\n");
assert.match(partial, /Writing plan/);

const legacyExit = { name: "ExitPlanMode" };
assert.equal(wrapPlanToolDefinition(legacyExit), legacyExit);

console.log("Plan tool renderer tests passed");

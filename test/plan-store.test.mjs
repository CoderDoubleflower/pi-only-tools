import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildInitialPlan,
  createPlanDocument,
  isPlanReady,
  updatePlanDocument,
} from "../src/plan/plan-store.js";

assert.match(buildInitialPlan("Refactor review flow"), /## Current State/);
assert.equal(isPlanReady(buildInitialPlan("Refactor review flow")).ready, false);

const validPlan = `# Make Plan approval user-controlled

## Context
The current planning workflow exposes a model-callable exit action and repeats the same plan during approval. The implementation must publish one reviewable revision, preserve the existing revision/hash snapshot, and transition to execution only after an explicit user choice.

## Current State
- \`src/plan/index.js\`: \`registerClaudePlanMode\` registers both publishing and exit actions, while \`runApprovalCommand\` already owns the user decision.
- \`src/plan/tool-set.js\`: \`buildPlanningTools\` currently injects workflow control tools into the model allowlist.
- The canonical document is stored atomically and identified by revision plus SHA-256 before handoff.

## Implementation Steps
1. **Publish directly from plan_write**
   - Files: \`src/plan/index.js\`, \`src/plan/tool-set.js\`
   - Change: validate the complete document, create the ready snapshot, terminate the planning turn, and remove the legacy exit action from active tools.
   - Reuse: \`isPlanReady\` from \`src/plan/plan-store.js\` and \`approvePlan\` from \`src/plan/handoff.js\`.
   - Flow: planning moves to ready after publishing; only the review command can move ready to executing.
2. **Render the published plan once**
   - Files: \`src/plan-tool-ui.js\`, \`src/claude-tool-ui.js\`
   - Change: share the existing call/result layout and render the Markdown body with normal semantic styling instead of a muted wrapper.
   - Dependencies: complete the state transition first so status metadata reflects the final revision.

## Risks and Compatibility
- Legacy profile files can still contain the removed tool name, so configuration loading must filter it and persist the migrated version.

## Verification
- Automated: \`npm test\`
- Integration: confirm planning → ready occurs on a valid plan_write, while ready → executing occurs only after the user selects execution.
- Manual/TUI: confirm the plan appears once with readable headings, lists, paths, and no visible exit action.
`;

const readiness = isPlanReady(validPlan);
assert.equal(readiness.ready, true, readiness.reason);
assert.deepEqual(readiness.errors, []);

const missingState = validPlan.replace(/## Current State[\s\S]*?## Implementation Steps/, "## Implementation Steps");
assert.equal(isPlanReady(missingState).ready, false);
assert.match(isPlanReady(missingState).reason, /Current State/);

const placeholder = validPlan.replace("src/plan/index.js", "path/to/file.ts");
assert.equal(isPlanReady(placeholder).ready, false);
assert.match(isPlanReady(placeholder).reason, /placeholder/i);

const root = await mkdtemp(join(tmpdir(), "plan-store-v2-"));
try {
  const document = await createPlanDocument(root, "Plan store test", { id: "plan-store-test" });
  const updated = await updatePlanDocument(document, validPlan, 1);
  assert.equal(updated.revision, 2);
  assert.notEqual(updated.hash, document.hash);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("plan store quality tests passed");

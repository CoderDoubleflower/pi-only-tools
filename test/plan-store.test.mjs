import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MODE_PROTOCOL_PROMPT } from "../src/mode-cache-policy.js";
import {
  buildInitialPlan,
  countPlanSteps,
  createPlanDocument,
  isPlanReady,
  readPlanSections,
  updatePlanDocument,
} from "../src/plan/plan-store.js";
import { buildPlanningSystemPrompt } from "../src/plan/prompts.js";

assert.match(buildInitialPlan("Refactor review flow"), /## \[Localized current-state heading\]/);
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
assert.equal(countPlanSteps(validPlan), 2);

const localizedPlan = `# 让计划写入过程实时显示并跟随用户语言

## 背景与目标
当前 plan_write 只有在 canonical plan 已经完成原子写入后，才会把完整 Markdown 正文显示到 TUI。新的实现需要在模型生成工具参数时持续显示正在增长的内容，同时保持计划文件只在执行阶段一次性写入，以免破坏 revision、哈希和 ready 状态。

## 当前实现
- \`src/plan-tool-ui.js\` 的 \`renderCall\` 只显示首个标题，\`renderResult\` 则在工具结束后显示完整正文。
- \`src/plan/plan-store.js\` 通过固定英文标题查找实施步骤，导致本地化标题无法通过完成度校验或正确统计步骤。
- Pi 会在工具参数流式更新时重复调用 call renderer，因此不需要增量写文件即可实现实时 UI。

## 实施步骤
1. **流式渲染工具参数**
   - 在 \`renderCall\` 的 partial 阶段直接渲染当前 \`content\`，最终结果到达后再切换为已保存状态和完整正文。
2. **按结构校验本地化计划**
   - 保留旧英文标题兼容，同时按固定 H2 顺序识别任意语言的背景、当前状态、实施步骤和验证部分。

## 验证方式
- 自动化：运行 \`npm test\`，覆盖中文标题的 ready 校验、步骤计数和 partial call rendering。
- 手工：使用中文请求进入 Plan Mode，确认正文边生成边显示，最终文件仍只增加一次 revision。
`;

const localizedReadiness = isPlanReady(localizedPlan);
assert.equal(localizedReadiness.ready, true, localizedReadiness.reason);
assert.equal(countPlanSteps(localizedPlan), 2);
assert.deepEqual(
  readPlanSections(localizedPlan).map((section) => section.title),
  ["背景与目标", "当前实现", "实施步骤", "验证方式"],
);

const localizedWithFenceHeading = localizedPlan.replace(
  "- 自动化：运行 `npm test`，覆盖中文标题的 ready 校验、步骤计数和 partial call rendering。",
  "- 自动化：运行 `npm test`。\n\n```bash\n## 这不是计划分节\nnpm test\n```",
);
assert.equal(isPlanReady(localizedWithFenceHeading).ready, true);
assert.equal(readPlanSections(localizedWithFenceHeading).length, 4);

const localizedWithExtraH2 = localizedPlan.replace(
  "## 验证方式",
  "## 额外范围\n不应增加额外的二级标题。\n\n## 另一个范围\n这会形成第六个二级标题。\n\n## 验证方式",
);
assert.equal(isPlanReady(localizedWithExtraH2).ready, false);
assert.match(isPlanReady(localizedWithExtraH2).reason, /four required H2 sections/i);

const missingState = validPlan.replace(/## Current State[\s\S]*?## Implementation Steps/, "## Implementation Steps");
assert.equal(isPlanReady(missingState).ready, false);
assert.match(isPlanReady(missingState).reason, /current-state/i);

const placeholder = validPlan.replace("src/plan/index.js", "path/to/file.ts");
assert.equal(isPlanReady(placeholder).ready, false);
assert.match(isPlanReady(placeholder).reason, /placeholder/i);

const planningPrompt = buildPlanningSystemPrompt(
  {
    plan: { path: "/tmp/plan.md", revision: 3, hash: "abc123" },
    planningTools: ["read", "grep", "plan_write"],
  },
  ["read", "grep", "plan_write"],
  false,
);
assert.equal(planningPrompt, MODE_PROTOCOL_PROMPT);
assert.match(planningPrompt, /language of the user's current request/i);
assert.match(planningPrompt, /exactly four required H2 sections/i);
assert.doesNotMatch(planningPrompt, /\/tmp\/plan\.md|abc123|plan_revision: 3/);
assert.doesNotMatch(planningPrompt, /configured Plan tool allowlist is/);

const root = await mkdtemp(join(tmpdir(), "plan-store-v2-"));
try {
  const document = await createPlanDocument(root, "Plan store test", { id: "plan-store-test" });
  const updated = await updatePlanDocument(document, validPlan, 1);
  assert.equal(updated.revision, 2);
  assert.notEqual(updated.hash, document.hash);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("plan store quality and cache-stable prompt tests passed");

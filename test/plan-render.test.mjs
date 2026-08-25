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

const planWrite = wrapPlanToolDefinition({
  name: "plan_write",
  description: "legacy description",
  promptGuidelines: ["Use the required sections: ## Context, ## Implementation Steps, and ## Verification."],
});
assert.equal(planWrite.renderShell, "self");
assert.match(planWrite.description, /user's language/i);
assert.ok(planWrite.promptGuidelines.some((line) => /language used by the user's current request/i.test(line)));
assert.ok(planWrite.promptGuidelines.every((line) => !line.includes("## Context")));

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
const call = planWrite.renderCall({ content }, theme, { isPartial: false }).render(400).join("\n");
assert.match(call, /Write Plan/);
assert.match(call, /User-controlled Plan review/);
assert.doesNotMatch(call, /## Current State/);

const localizedContent = `# 让计划正文实时显示

## 背景
当前正文只在文件写入完成后出现，需要在工具参数生成期间持续显示当前 Markdown 内容。

## 当前实现
- \`renderCall\` 只显示首个标题。
- \`renderResult\` 在完成后显示完整正文。

## 实施步骤
1. **渲染 partial content**
   - 在 \`context.isPartial\` 为真时渲染当前参数。
2. **保留原子写入**
   - 工具执行阶段仍一次性更新 canonical plan。

## 验证
- 运行 \`npm test\` 并手工观察中文计划的流式输出。
`;
const streamingCall = planWrite
  .renderCall({ content: localizedContent }, theme, { isPartial: true })
  .render(500)
  .join("\n");
const plainStreamingCall = visibleText(streamingCall);
assert.match(plainStreamingCall, /让计划正文实时显示/);
assert.match(plainStreamingCall, /当前实现/);
assert.match(plainStreamingCall, /renderCall/);
assert.match(plainStreamingCall, /实施步骤/);

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
  { args: { content: localizedContent } },
).render(500).join("\n");
const plainResult = visibleText(result);
assert.match(plainResult, /Plan r2 saved · 2 steps · awaiting your review/);
assert.match(plainResult, /让计划正文实时显示/);
assert.match(plainResult, /当前实现/);
assert.match(plainResult, /src\/plan-tool-ui\.js|renderCall/);
assert.doesNotMatch(result, /<muted># 让计划正文实时显示/);
assert.doesNotMatch(result, /<toolOutput># 让计划正文实时显示/);
assert.doesNotMatch(result, /SHA-256/);

const partialWithStreamedArgs = planWrite.renderResult(
  { content: [], details: {} },
  { expanded: false, isPartial: true },
  theme,
  { args: { content: localizedContent } },
).render(100).join("\n");
assert.equal(partialWithStreamedArgs, "");

const partialWithoutArgs = planWrite.renderResult(
  { content: [], details: {} },
  { expanded: false, isPartial: true },
  theme,
  { args: {} },
).render(100).join("\n");
assert.match(partialWithoutArgs, /Writing plan/);

const legacyExit = { name: "ExitPlanMode" };
assert.equal(wrapPlanToolDefinition(legacyExit), legacyExit);

console.log("Plan tool renderer tests passed");

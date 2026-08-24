import assert from "node:assert/strict";
import { createPlanToolUiExtensionApi } from "../src/plan-tool-ui.js";

const handlers = new Map();
const commands = new Map();
const tools = new Map();
const dispatchedCommands = [];
const pendingDispatches = [];
const reviewPrompts = [];
let waitForIdleCalls = 0;

const eventCtx = {
  hasUI: true,
  hasPendingMessages: () => false,
  ui: {
    async select(title, choices) {
      reviewPrompts.push({ title, choices });
      return "Keep reviewing for now";
    },
    notify() {},
  },
};

const commandCtx = {
  ...eventCtx,
  waitForIdle: async () => {
    waitForIdleCalls += 1;
  },
  newSession: async () => ({ cancelled: true }),
};

const rawPi = {
  on(event, handler) {
    const list = handlers.get(event) ?? [];
    list.push(handler);
    handlers.set(event, list);
  },
  registerTool(tool) {
    tools.set(tool.name, tool);
  },
  registerCommand(name, command) {
    commands.set(name, command);
  },
  sendMessage() {},
  sendUserMessage(content, options) {
    assert.equal(options?.expandPromptTemplates, true);
    assert.equal(typeof content, "string");
    assert.match(content, /^\//);

    const [invocation, ...rest] = content.slice(1).split(/\s+/);
    const command = commands.get(invocation);
    assert.ok(command, `Expected command ${invocation} to be registered`);
    dispatchedCommands.push({ name: invocation, args: rest.join(" ") });
    pendingDispatches.push(
      Promise.resolve().then(() => command.handler(rest.join(" "), commandCtx)),
    );
  },
};

const pi = createPlanToolUiExtensionApi(rawPi);

pi.registerCommand("plan-approve", {
  description: "Review the published plan",
  handler: async (_args, ctx) => {
    await ctx.waitForIdle();
    assert.equal(typeof ctx.newSession, "function");
    await ctx.ui.select("Plan r2", [
      "Execute plan (keep context)",
      "Clear context and execute in a new session",
      "Edit plan",
      "Give feedback and continue planning",
      "Stay in Plan Mode",
    ]);
  },
});

pi.registerTool({
  name: "ExitPlanMode",
  execute: async () => ({
    content: [{ type: "text", text: "ready" }],
    details: {
      plan: { revision: 2 },
      ready: { revision: 2, hash: "plan-hash" },
    },
  }),
});

pi.registerTool({
  name: "plan_write",
  execute: async () => ({
    content: [{ type: "text", text: "saved" }],
    details: { plan: { revision: 2 } },
  }),
});

const validPlan = `# Dispatch Plan Review Through Pi

## Context
The automatic review currently starts from an agent lifecycle event, but the review command requires command-only session actions. Route the review through Pi's command dispatcher so the handler receives the correct runtime context.

## Current State
- \`src/plan-tool-ui.js\` schedules review from \`agent_settled\`.
- \`/plan-approve\` waits for idle and may create a replacement session.

## Implementation Steps
1. **Dispatch the registered command**
   - Files: \`src/plan-tool-ui.js\`
   - Change: send \`/plan-approve\` with command expansion instead of invoking its handler with an event context.

## Verification
- Automated: run the Plan review dispatch regression test.
- Integration: publish a valid plan and confirm the review menu opens without an extension error.
`;

assert.equal("waitForIdle" in eventCtx, false);
const result = await tools.get("plan_write").execute(
  "plan-call",
  { content: validPlan },
  undefined,
  undefined,
  eventCtx,
);
assert.equal(result.terminate, true);

for (const handler of handlers.get("agent_settled") ?? []) {
  await handler({ type: "agent_settled" }, eventCtx);
}
await Promise.all(pendingDispatches);

assert.deepEqual(dispatchedCommands, [{ name: "plan-approve", args: "" }]);
assert.equal(waitForIdleCalls, 1);
assert.equal(reviewPrompts.length, 1);
assert.ok(reviewPrompts[0].choices.includes("Keep reviewing for now"));
console.log("Plan review command-context dispatch regression test passed");

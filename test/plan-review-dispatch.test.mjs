import assert from "node:assert/strict";
import { createPlanToolUiExtensionApi } from "../src/plan-tool-ui.js";
import { createPlanReviewController } from "../src/plan/review-controller.js";
import { waitForModeCommandIdle } from "../src/plan/command-context.js";

const handlers = new Map();
const commands = new Map();
const dispatched = [];
const pendingDispatches = [];
const notifications = [];
let waitForIdleCalls = 0;
let hasPendingMessages = false;
const eventCtx = {
  hasUI: true,
  hasPendingMessages: () => hasPendingMessages,
  ui: { notify: (text) => notifications.push(text) },
};
const commandCtx = {
  ...eventCtx,
  waitForIdle: async () => { waitForIdleCalls += 1; },
  newSession: async () => ({ cancelled: false }),
};
const pi = {
  on(event, handler) {
    const list = handlers.get(event) ?? [];
    list.push(handler);
    handlers.set(event, list);
  },
  sendUserMessage(content, options) {
    assert.equal(options?.expandPromptTemplates, true);
    const [name, ...rest] = content.slice(1).split(/\s+/);
    dispatched.push({ name, args: rest.join(" ") });
    pendingDispatches.push(Promise.resolve().then(() => commands.get(name).handler(rest.join(" "), commandCtx)));
  },
};
const review = createPlanReviewController(pi);
commands.set("plan-approve", {
  handler: async (_args, ctx) => {
    review.clear();
    await waitForModeCommandIdle(ctx);
    assert.equal(typeof ctx.newSession, "function", "approval must receive Pi's command context");
  },
});
async function emit(event, ctx = eventCtx) {
  for (const handler of handlers.get(event) ?? []) await handler({ type: event }, ctx);
  await Promise.all(pendingDispatches);
}

assert.equal("waitForIdle" in eventCtx, false);
review.request();
await emit("agent_settled");
assert.deepEqual(dispatched, [{ name: "plan-approve", args: "" }]);
assert.equal(waitForIdleCalls, 1);
await emit("agent_settled");
assert.equal(dispatched.length, 1, "a publication must open review once");

review.request();
hasPendingMessages = true;
await emit("agent_settled");
assert.equal(dispatched.length, 1, "queued feedback must postpone review");
hasPendingMessages = false;
await emit("agent_settled");
assert.equal(dispatched.length, 2);

review.request();
review.clear();
await emit("agent_settled");
assert.equal(dispatched.length, 2, "manual approval or leaving Plan must cancel pending automatic review");
for (const event of ["session_start", "session_tree", "session_shutdown"]) {
  review.request();
  await emit(event);
  await emit("agent_settled");
  assert.equal(dispatched.length, 2, "pending review must not follow a different session branch");
}
review.request();
await emit("agent_settled", { ...eventCtx, hasUI: false });
assert.equal(dispatched.length, 2);
assert.match(notifications.at(-1), /\/plan-approve keep/);

// Rendering never owns a workflow callback or replaces tool execution.
const rendered = [];
const originalExecute = async () => ({ content: [], details: {} });
const decorated = createPlanToolUiExtensionApi({
  registerTool: (tool) => rendered.push(tool),
  on: () => { throw new Error("rendering must not register workflow lifecycle handlers"); },
});
decorated.registerTool({ name: "plan_write", execute: originalExecute });
assert.equal(rendered[0].execute, originalExecute);
assert.equal(typeof rendered[0].renderResult, "function");
assert.equal(createPlanToolUiExtensionApi(decorated), decorated);

console.log("Plan review dispatch, cancellation, and renderer separation tests passed");

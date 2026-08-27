import assert from "node:assert/strict";
import {
  MODE_STATE_CUSTOM_TYPE,
  MODE_SYSTEM_PROMPT_MARKER,
  appendRuntimeStateMessage,
  appendStableModeSystemPrompt,
  buildRuntimeStateMessage,
  createRuntimePolicySnapshot,
  registerCacheStableModeRuntime,
  rewriteOpenAIResponsesToolChoice,
} from "../src/cache-stable-mode.js";
import { createToolProfileController } from "../src/tool-profile-controller.js";

const registered = new Set([
  "shell_command",
  "apply_patch",
  "read",
  "grep",
  "plan_write",
]);
let active = ["shell_command", "apply_patch"];
const handlers = new Map();
const pi = {
  on(event, handler) {
    const list = handlers.get(event) ?? [];
    list.push(handler);
    handlers.set(event, list);
  },
  getAllTools: () => [...registered].map((name) => ({ name })),
  getActiveTools: () => [...active],
  setActiveTools(names) {
    active = [...names];
  },
};
const profiles = createToolProfileController(pi, { requiredTools: ["plan_write"] });
profiles.setProfile("normal", ["shell_command", "apply_patch"], { apply: false });
profiles.setProfile("ask", ["read", "grep"], { apply: false });
profiles.setProfile("plan", ["read", "grep", "plan_write"], { apply: false });
profiles.activate("normal");

let stage = "idle";
let mode = "normal";
let planState;
const planMode = {
  getMode: () => mode,
  getStage: () => stage,
  getState: () => planState,
};

assert.deepEqual(createRuntimePolicySnapshot(profiles, planMode), {
  schemaVersion: 1,
  mode: "normal",
  workflowStage: "idle",
  allowedTools: ["shell_command", "apply_patch"],
});
mode = "ask";
profiles.activate("ask");
assert.deepEqual(createRuntimePolicySnapshot(profiles, planMode).allowedTools, ["read", "grep"]);
stage = "planning";
mode = "plan";
profiles.activate("plan");
planState = {
  plan: { path: "/tmp/plan.md", revision: 3, hash: "abc" },
};
const planningSnapshot = createRuntimePolicySnapshot(profiles, planMode);
assert.deepEqual(planningSnapshot, {
  schemaVersion: 1,
  mode: "plan",
  workflowStage: "planning",
  allowedTools: ["read", "grep", "plan_write"],
  canonicalPlan: { path: "/tmp/plan.md", revision: 3, hash: "abc" },
});
assert.match(buildRuntimeStateMessage(planningSnapshot), /<pi-only-tools-runtime-state>/);
assert.match(buildRuntimeStateMessage(planningSnapshot), /"revision": 3/);

stage = "ready";
assert.deepEqual(createRuntimePolicySnapshot(profiles, planMode).allowedTools, []);
stage = "executing";
mode = "normal";
profiles.activate("normal");
planState.approved = { revision: 3, hash: "abc" };
const executing = createRuntimePolicySnapshot(profiles, planMode);
assert.equal(executing.mode, "normal");
assert.deepEqual(executing.allowedTools, ["shell_command", "apply_patch"]);
assert.deepEqual(executing.approvedPlan, { revision: 3, hash: "abc" });

const basePrompt = "base";
const stablePrompt = appendStableModeSystemPrompt(basePrompt);
assert.match(stablePrompt, new RegExp(MODE_SYSTEM_PROMPT_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
assert.equal(appendStableModeSystemPrompt(stablePrompt), stablePrompt);
assert.doesNotMatch(stablePrompt, /\/tmp\/plan\.md/);
assert.doesNotMatch(stablePrompt, /revision: 3/);

const payload = {
  model: "gpt-5.6",
  tools: [
    { type: "function", name: "shell_command", description: "shell" },
    { type: "function", name: "apply_patch", description: "patch" },
    { type: "function", name: "read", description: "read" },
  ],
};
const openAIModel = { api: "openai-responses", provider: "openai-codex" };
const subset = rewriteOpenAIResponsesToolChoice(payload, ["read"], openAIModel, {});
assert.deepEqual(subset.tool_choice, {
  type: "allowed_tools",
  mode: "auto",
  tools: [{ type: "function", name: "read" }],
});
assert.deepEqual(subset.tools, payload.tools, "tool definitions must remain byte-for-byte stable");
assert.notEqual(subset, payload);
const none = rewriteOpenAIResponsesToolChoice(payload, [], openAIModel, {});
assert.equal(none.tool_choice, "none");
assert.equal(
  rewriteOpenAIResponsesToolChoice(payload, ["shell_command", "apply_patch", "read"], openAIModel, {}),
  payload,
  "no payload rewrite is needed when the whole catalog is allowed",
);
const requiredPayload = { ...payload, tool_choice: "required" };
assert.deepEqual(
  rewriteOpenAIResponsesToolChoice(requiredPayload, ["read"], openAIModel, {}).tool_choice,
  {
    type: "allowed_tools",
    mode: "required",
    tools: [{ type: "function", name: "read" }],
  },
  "an upstream required choice must stay required",
);
const nonePayload = { ...payload, tool_choice: "none" };
assert.equal(
  rewriteOpenAIResponsesToolChoice(nonePayload, ["read"], openAIModel, {}),
  nonePayload,
  "an upstream none choice is already stricter and must be preserved",
);
const specificPayload = {
  ...payload,
  tool_choice: { type: "function", name: "read" },
};
assert.equal(
  rewriteOpenAIResponsesToolChoice(specificPayload, ["read"], openAIModel, {}),
  specificPayload,
  "an allowed explicit function choice must be preserved",
);
assert.equal(
  rewriteOpenAIResponsesToolChoice(payload, ["read"], { api: "anthropic-messages", provider: "anthropic" }, {}),
  payload,
);
const proxyModel = { api: "openai-responses", provider: "custom-responses-gateway" };
const proxySubset = rewriteOpenAIResponsesToolChoice(payload, ["read"], proxyModel, {});
assert.deepEqual(
  proxySubset.tool_choice,
  {
    type: "allowed_tools",
    mode: "auto",
    tools: [{ type: "function", name: "read" }],
  },
  "all openai-responses providers must use the same allowed_tools policy",
);
assert.equal(
  rewriteOpenAIResponsesToolChoice(
    payload,
    ["read"],
    proxyModel,
    { PI_ONLY_TOOLS_ALLOWED_TOOLS: "off" },
  ),
  payload,
  "the explicit off switch must remain available for incompatible gateways",
);

// Integrated event registration: one stable system protocol plus an ephemeral,
// per-provider-call state message and a fail-closed runtime gate.
stage = "idle";
mode = "normal";
planState = undefined;
profiles.activate("normal");
const runtime = registerCacheStableModeRuntime(pi, {
  toolProfiles: profiles,
  getPlanMode: () => planMode,
});
assert.equal(typeof runtime.snapshot, "function");
const ctx = { model: openAIModel };
async function emit(event, payload = {}) {
  let result;
  for (const handler of handlers.get(event) ?? []) {
    const next = await handler({ type: event, ...payload }, ctx);
    if (next !== undefined) result = next;
  }
  return result;
}
const before = await emit("before_agent_start", { systemPrompt: "base" });
assert.match(before.systemPrompt, /PI-ONLY-TOOLS MODE PROTOCOL/);
assert.equal(Object.hasOwn(before, "message"), false);
const originalMessages = [
  { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 },
];
const contextResult = await emit("context", { messages: originalMessages });
assert.equal(contextResult.messages.length, 2);
assert.equal(contextResult.messages[0], originalMessages[0]);
assert.equal(contextResult.messages[1].customType, MODE_STATE_CUSTOM_TYPE);
assert.equal(contextResult.messages[1].display, false);
assert.match(contextResult.messages[1].content, /"mode": "normal"/);
assert.deepEqual(originalMessages, [
  { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 },
]);
const replacedState = appendRuntimeStateMessage(
  contextResult.messages,
  { schemaVersion: 1, mode: "ask", workflowStage: "idle", allowedTools: ["read"] },
  2,
);
assert.equal(
  replacedState.filter(
    (message) => message.role === "custom" && message.customType === MODE_STATE_CUSTOM_TYPE,
  ).length,
  1,
);
assert.match(replacedState.at(-1).content, /"mode": "ask"/);
assert.equal(await emit("tool_call", { toolName: "shell_command" }), undefined);
const blocked = await emit("tool_call", { toolName: "read" });
assert.equal(blocked.block, true);
assert.match(blocked.reason, /Normal Mode blocks read/);

mode = "ask";
stage = "idle";
profiles.activate("ask");
const rewritten = await emit("before_provider_request", { payload });
assert.deepEqual(rewritten.tool_choice.tools, [{ type: "function", name: "read" }]);
assert.deepEqual(rewritten.tools, payload.tools);

console.log("cache-stable mode runtime tests passed");

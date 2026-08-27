import assert from "node:assert/strict";
import { createToolProfileController } from "../src/tool-profile-controller.js";
import { __test as planIndexTest } from "../src/plan/index.js";

const handlers = new Map();
const registered = [
  "shell_command",
  "apply_patch",
  "read",
  "grep",
  "ask_user_question",
  "plan_write",
];
let activeTools = ["shell_command", "apply_patch"];

const pi = {
  on(event, handler) {
    const list = handlers.get(event) ?? [];
    list.push(handler);
    handlers.set(event, list);
  },
  getAllTools: () => registered.map((name) => ({ name })),
  getActiveTools: () => [...activeTools],
  setActiveTools(names) {
    activeTools = [...names];
  },
};

const profiles = createToolProfileController(pi);
profiles.setProfile("normal", ["shell_command", "apply_patch"], { apply: false });
profiles.setProfile("ask", ["read"], { apply: false });
profiles.setProfile(
  "plan",
  ["read", "grep", "ask_user_question", "plan_write"],
  { apply: false },
);
profiles.activate("normal");
const stableCatalog = [
  "shell_command",
  "apply_patch",
  "read",
  "grep",
  "ask_user_question",
  "plan_write",
];
assert.deepEqual(activeTools, stableCatalog);

let planState;
let askActive = false;
const legacyMode = {
  getState: () => planState,
};
const askMode = {
  isActive: () => askActive,
  getAllowedTools: () => profiles.getEffectiveTools("ask"),
};

const policy = planIndexTest.registerRuntimeModePolicy(
  pi,
  legacyMode,
  askMode,
  profiles,
);

async function emit(event, payload = {}, ctx = {}) {
  let result;
  for (const handler of handlers.get(event) ?? []) {
    const next = await handler({ type: event, ...payload }, ctx);
    if (next !== undefined) result = next;
  }
  return result;
}

await emit("session_start", { reason: "startup" });
const normalPrompt = await emit("before_agent_start", { systemPrompt: "BASE" });
assert.match(normalPrompt.systemPrompt, /\[PI ONLY TOOLS MODE PROTOCOL\]/);
assert.match(normalPrompt.message.content, /mode=normal/);
assert.deepEqual(normalPrompt.message.details.allowedTools, ["shell_command", "apply_patch"]);
assert.deepEqual(activeTools, stableCatalog);

const repeatedNormalPrompt = await emit("before_agent_start", { systemPrompt: "BASE" });
assert.equal(repeatedNormalPrompt.message, undefined, "unchanged mode state must not append duplicate hidden context");
assert.equal(repeatedNormalPrompt.systemPrompt, normalPrompt.systemPrompt);

askActive = true;
profiles.activate("ask");
const askPrompt = await emit("before_agent_start", { systemPrompt: "BASE" });
assert.equal(askPrompt.systemPrompt, normalPrompt.systemPrompt, "system prompt must be byte-stable across modes");
assert.match(askPrompt.message.content, /\[ASK MODE ACTIVE\]/);
assert.deepEqual(askPrompt.message.details.allowedTools, ["read"]);
assert.deepEqual(activeTools, stableCatalog);
assert.equal(await emit("tool_call", { toolName: "read" }), undefined);
assert.match((await emit("tool_call", { toolName: "apply_patch" })).reason, /Ask Mode blocks apply_patch/);

askActive = false;
planState = {
  stage: "planning",
  plan: {
    id: "plan-1",
    path: "/tmp/cache-plan.md",
    revision: 3,
    hash: "abc123",
  },
  planningTools: ["read", "grep", "ask_user_question"],
};
profiles.activate("plan");
const planningPrompt = await emit("before_agent_start", { systemPrompt: "BASE" });
assert.equal(planningPrompt.systemPrompt, normalPrompt.systemPrompt);
assert.match(planningPrompt.message.content, /\[PLAN MODE ACTIVE\]/);
assert.match(planningPrompt.message.content, /plan_revision=3/);
assert.match(planningPrompt.message.content, /plan_sha256=abc123/);
assert.deepEqual(planningPrompt.message.details.allowedTools, [
  "read",
  "grep",
  "ask_user_question",
  "plan_write",
]);
assert.deepEqual(activeTools, stableCatalog);
assert.equal(await emit("tool_call", { toolName: "read" }), undefined);
assert.match((await emit("tool_call", { toolName: "shell_command" })).reason, /Plan Mode blocks shell_command/);

const providerTools = stableCatalog.map((name) => ({
  type: "function",
  name,
  description: name,
}));
const planningPayload = {
  model: "gpt-5.6",
  input: [],
  stream: true,
  tools: providerTools,
};
const restrictedPlanningPayload = await emit(
  "before_provider_request",
  { payload: planningPayload },
  { model: { api: "openai-responses", provider: "openai" } },
);
assert.strictEqual(restrictedPlanningPayload.tools, providerTools);
assert.deepEqual(restrictedPlanningPayload.tool_choice, {
  type: "allowed_tools",
  mode: "auto",
  tools: [
    { type: "function", name: "read" },
    { type: "function", name: "grep" },
    { type: "function", name: "ask_user_question" },
    { type: "function", name: "plan_write" },
  ],
});

planState = {
  ...planState,
  stage: "ready",
};
const readyPrompt = await emit("before_agent_start", { systemPrompt: "BASE" });
assert.equal(readyPrompt.systemPrompt, normalPrompt.systemPrompt);
assert.match(readyPrompt.message.content, /\[PLAN READY FOR USER REVIEW\]/);
assert.deepEqual(readyPrompt.message.details.allowedTools, []);
assert.match((await emit("tool_call", { toolName: "read" })).reason, /Plan Ready blocks read/);
const readyPayload = await emit(
  "before_provider_request",
  { payload: planningPayload },
  { model: { api: "openai-responses", provider: "openai-codex" } },
);
assert.strictEqual(readyPayload.tools, providerTools);
assert.equal(readyPayload.tool_choice, "none");

planState = {
  ...planState,
  stage: "executing",
  approved: { revision: 3, hash: "abc123" },
  baseline: { tools: ["shell_command", "apply_patch"] },
  executionTools: ["shell_command", "apply_patch"],
};
profiles.activate("normal");
const executionPrompt = await emit("before_agent_start", { systemPrompt: "BASE" });
assert.equal(executionPrompt.systemPrompt, normalPrompt.systemPrompt);
assert.match(executionPrompt.message.content, /\[EXECUTING USER-APPROVED PLAN\]/);
assert.deepEqual(executionPrompt.message.details.allowedTools, ["shell_command", "apply_patch"]);
assert.deepEqual(activeTools, stableCatalog);
assert.equal(await emit("tool_call", { toolName: "apply_patch" }), undefined);
assert.match((await emit("tool_call", { toolName: "read" })).reason, /Normal profile blocks read/);

await emit("session_compact", {});
const reinjectedAfterCompaction = await emit("before_agent_start", { systemPrompt: "BASE" });
assert.ok(reinjectedAfterCompaction.message, "compaction must force the current hidden context to be re-injected");
assert.deepEqual(policy.getAllowedTools(), ["shell_command", "apply_patch"]);
assert.deepEqual(policy.getSnapshot().allowedTools, ["shell_command", "apply_patch"]);
console.log("cache-stable Normal, Ask, and Plan policy integration tests passed");

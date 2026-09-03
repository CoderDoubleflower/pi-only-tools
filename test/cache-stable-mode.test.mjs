import assert from "node:assert/strict";
import {
  MODE_STATE_CUSTOM_TYPE,
  MODE_STATE_SCHEMA_VERSION,
  appendRuntimeStateMessage,
  appendStableModeSystemPrompt,
  buildRuntimeStateMessage,
  createRuntimePolicySnapshot,
  latestRuntimeStateFingerprint,
  registerCacheStableModeRuntime,
  rewriteOpenAIResponsesToolChoice,
  runtimePolicyFingerprint,
  runtimeStateFingerprintFromMessage,
} from "../src/cache-stable-mode.js";

function createProfiles() {
  const profiles = {
    normal: ["read", "edit"],
    ask: ["read"],
    plan: ["read", "plan_write"],
  };
  return {
    mode: "normal",
    applyCalls: 0,
    resetCalls: 0,
    apply() {
      this.applyCalls += 1;
    },
    resetCatalog() {
      this.resetCalls += 1;
    },
    getEffectiveTools(profile = this.mode) {
      return [...(profiles[profile] ?? [])];
    },
  };
}

const profiles = createProfiles();
const normalSnapshot = createRuntimePolicySnapshot(profiles);
assert.deepEqual(normalSnapshot, {
  schemaVersion: MODE_STATE_SCHEMA_VERSION,
  mode: "normal",
  workflowStage: "idle",
  allowedTools: ["read", "edit"],
});

const planState = {
  getStage: () => "planning",
  getMode: () => "plan",
  getState: () => ({
    plan: { path: "/tmp/plan.md", revision: 3, hash: "abc" },
    approved: { revision: 2, hash: "old" },
  }),
};
assert.deepEqual(createRuntimePolicySnapshot(profiles, planState), {
  schemaVersion: MODE_STATE_SCHEMA_VERSION,
  mode: "plan",
  workflowStage: "planning",
  allowedTools: ["read", "plan_write"],
  canonicalPlan: { path: "/tmp/plan.md", revision: 3, hash: "abc" },
  approvedPlan: { revision: 2, hash: "old" },
});

const readyState = {
  ...planState,
  getStage: () => "ready",
};
assert.deepEqual(createRuntimePolicySnapshot(profiles, readyState).allowedTools, []);

const prompt = appendStableModeSystemPrompt("base prompt");
assert.match(prompt, /stable tool catalog/u);
assert.match(prompt, /append-only/u);
assert.equal(appendStableModeSystemPrompt(prompt), prompt);

const firstMessages = [{ role: "user", content: "hello" }];
const firstContractMessages = appendRuntimeStateMessage(firstMessages, normalSnapshot, 100);
assert.equal(firstContractMessages.length, 2);
assert.equal(firstMessages.length, 1, "the source message array must remain immutable");
assert.equal(firstContractMessages[1].role, "custom");
assert.equal(firstContractMessages[1].customType, MODE_STATE_CUSTOM_TYPE);
assert.equal(firstContractMessages[1].display, false);
assert.equal(firstContractMessages[1].timestamp, 100);
assert.match(firstContractMessages[1].content, /"mode": "normal"/u);
assert.equal(
  firstContractMessages[1].details.fingerprint,
  runtimePolicyFingerprint(normalSnapshot),
);
assert.equal(
  runtimeStateFingerprintFromMessage(firstContractMessages[1]),
  runtimePolicyFingerprint(normalSnapshot),
);
assert.equal(
  appendRuntimeStateMessage(firstContractMessages, normalSnapshot),
  firstContractMessages,
  "the same effective contract must be strictly deduplicated",
);

const askSnapshot = {
  ...normalSnapshot,
  mode: "ask",
  allowedTools: ["read"],
};
const transitionedMessages = appendRuntimeStateMessage(
  firstContractMessages,
  askSnapshot,
  200,
);
assert.equal(transitionedMessages.length, 3);
assert.equal(
  transitionedMessages[1],
  firstContractMessages[1],
  "a transition must preserve the previous contract at its historical position",
);
assert.equal(
  latestRuntimeStateFingerprint(transitionedMessages),
  runtimePolicyFingerprint(askSnapshot),
);
assert.equal(
  latestRuntimeStateFingerprint([
    {
      type: "custom_message",
      customType: MODE_STATE_CUSTOM_TYPE,
      content: buildRuntimeStateMessage(askSnapshot),
      details: { fingerprint: runtimePolicyFingerprint(askSnapshot) },
    },
  ]),
  runtimePolicyFingerprint(askSnapshot),
  "session custom_message entries must participate in deduplication",
);

const model = { api: "openai-responses", id: "gpt-5.6-sol" };
const payload = {
  model: "gpt-5.6-sol",
  tools: [
    { type: "function", name: "read", description: "read" },
    { type: "function", name: "edit", description: "edit" },
  ],
};
const restrictedPayload = rewriteOpenAIResponsesToolChoice(
  payload,
  ["read"],
  model,
  {},
);
assert.notEqual(restrictedPayload, payload);
assert.equal(restrictedPayload.tools, payload.tools, "tool definitions must stay stable");
assert.deepEqual(restrictedPayload.tool_choice, {
  type: "allowed_tools",
  mode: "auto",
  tools: [{ type: "function", name: "read" }],
});
assert.deepEqual(
  rewriteOpenAIResponsesToolChoice(
    { ...payload, tool_choice: "required" },
    ["read"],
    model,
    {},
  ).tool_choice,
  {
    type: "allowed_tools",
    mode: "required",
    tools: [{ type: "function", name: "read" }],
  },
);
assert.equal(
  rewriteOpenAIResponsesToolChoice(payload, [], model, {}).tool_choice,
  "none",
);
assert.equal(
  rewriteOpenAIResponsesToolChoice(payload, ["read", "edit"], model, {}),
  payload,
  "a complete allowlist must not weaken a stricter caller choice or rewrite the payload",
);
assert.equal(
  rewriteOpenAIResponsesToolChoice(payload, ["read"], model, {
    PI_ONLY_TOOLS_ALLOWED_TOOLS: "off",
  }),
  payload,
);
assert.equal(
  rewriteOpenAIResponsesToolChoice(
    payload,
    ["read"],
    { api: "anthropic-messages", id: "claude" },
    {},
  ),
  payload,
);
const hostedToolPayload = {
  tools: [{ type: "web_search_preview" }],
};
assert.equal(
  rewriteOpenAIResponsesToolChoice(hostedToolPayload, [], model, {}),
  hostedToolPayload,
  "unknown hosted-tool shapes must be left untouched",
);

const handlers = new Map();
const sentMessages = [];
const runtimeProfiles = createProfiles();
const runtimeState = { mode: "normal" };
const pi = {
  on(event, handler) {
    const list = handlers.get(event) ?? [];
    list.push(handler);
    handlers.set(event, list);
  },
  sendMessage(message, options) {
    sentMessages.push({ message, options });
  },
};
const planMode = {
  getStage: () => "idle",
  getMode: () => runtimeState.mode,
  getState: () => ({}),
};
registerCacheStableModeRuntime(pi, {
  toolProfiles: runtimeProfiles,
  getPlanMode: () => planMode,
});

const sessionStart = handlers.get("session_start")[0];
sessionStart(
  { reason: "startup" },
  { sessionManager: { getBranch: () => [] } },
);
assert.equal(runtimeProfiles.resetCalls, 1);
assert.equal(runtimeProfiles.applyCalls, 1);

const beforeAgentStart = handlers.get("before_agent_start")[0];
const firstStart = beforeAgentStart({ systemPrompt: "base" }, {});
assert.match(firstStart.systemPrompt, /stable tool catalog/u);
assert.equal(firstStart.message.customType, MODE_STATE_CUSTOM_TYPE);
assert.equal(firstStart.message.role, undefined);
assert.equal(firstStart.message.timestamp, undefined);
assert.equal(firstStart.message.display, false);

const firstPersistentMessage = { role: "custom", ...firstStart.message };
const context = handlers.get("context")[0];
assert.equal(
  context({ messages: [{ role: "user", content: "task" }, firstPersistentMessage] }),
  undefined,
  "ordinary provider calls must not rewrite a context that already contains the current contract",
);

const secondStart = beforeAgentStart({ systemPrompt: "base" }, {});
assert.equal(secondStart.message, undefined, "ordinary agent runs must not duplicate a contract");

runtimeState.mode = "ask";
const recovered = context({
  messages: [{ role: "user", content: "task" }, firstPersistentMessage],
});
assert.equal(recovered.messages.length, 3);
assert.equal(recovered.messages[1], firstPersistentMessage);
assert.match(recovered.messages[2].content, /"mode": "ask"/u);

const turnEnd = handlers.get("turn_end")[0];
turnEnd({});
assert.equal(sentMessages.length, 1);
assert.equal(sentMessages[0].message.customType, MODE_STATE_CUSTOM_TYPE);
assert.match(sentMessages[0].message.content, /"mode": "ask"/u);
assert.deepEqual(sentMessages[0].options, { triggerTurn: false });

handlers.get("agent_end")[0]({});
handlers.get("agent_settled")[0]({});
assert.equal(sentMessages.length, 1, "the persisted transition must remain deduplicated");

const toolCall = handlers.get("tool_call")[0];
assert.equal(toolCall({ toolName: "read" }), undefined);
assert.match(toolCall({ toolName: "edit" }).reason, /Ask Mode blocks edit/u);

const beforeProviderRequest = handlers.get("before_provider_request")[0];
const providerResult = beforeProviderRequest(
  { payload },
  { model },
);
assert.deepEqual(providerResult.tool_choice.tools, [
  { type: "function", name: "read" },
]);
assert.equal(providerResult.tools, payload.tools);

console.log("cache-stable mode tests passed");

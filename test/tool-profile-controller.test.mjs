import assert from "node:assert/strict";
import { MODE_PROTOCOL_MARKER, MODE_STATE_CUSTOM_TYPE } from "../src/mode-cache-policy.js";
import { PLAN_STATE_ENTRY } from "../src/plan/constants.js";
import { createToolProfileController } from "../src/tool-profile-controller.js";

const handlers = new Map();
const registered = new Set(["shell_command", "apply_patch", "read", "grep", "plan_write"]);
const setActiveCalls = [];
let active = ["shell_command", "apply_patch"];
const pi = {
  on(event, handler) {
    const list = handlers.get(event) ?? [];
    list.push(handler);
    handlers.set(event, list);
  },
  getAllTools: () => [...registered].map((name) => ({ name })),
  getActiveTools: () => [...active],
  setActiveTools: (names) => {
    active = [...names];
    setActiveCalls.push([...names]);
  },
};

const entries = [];
const ctx = {
  model: {
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
  },
  sessionManager: {
    getEntries: () => entries,
    getBranch: () => entries,
  },
};

async function emit(event, payload = {}) {
  let result;
  for (const handler of handlers.get(event) ?? []) {
    const next = await handler({ type: event, ...payload }, ctx);
    if (next !== undefined) result = next;
  }
  return result;
}

const profiles = createToolProfileController(pi);
profiles.setProfile("normal", ["shell_command", "apply_patch"], { apply: false });
profiles.setProfile("ask", ["read", "grep"], { apply: false });
profiles.setProfile("plan", ["read", "grep", "plan_write"], { apply: false });
profiles.activate("normal");
assert.deepEqual(active, ["shell_command", "apply_patch", "read", "grep", "plan_write"]);
const stableCatalog = [...active];

profiles.activate("plan");
assert.deepEqual(active, stableCatalog, "mode switches must not change the provider tool catalogue");
assert.deepEqual(profiles.getAllowedTools(), ["read", "grep", "plan_write"]);

profiles.setProfile("normal", ["shell_command"]);
assert.deepEqual(active, stableCatalog, "removing permission must not remove a cached tool definition mid-session");
profiles.setProfile("plan", ["read", "plan_write"]);
assert.deepEqual(active, stableCatalog, "editing the active profile changes permission only");
assert.deepEqual(profiles.getAllowedTools(), ["read", "plan_write"]);
assert.deepEqual(profiles.getUnavailableTools(["grep", "missing", "plan_write"]), [
  { name: "missing", reason: "not registered" },
]);

profiles.activate("ask");
assert.deepEqual(active, stableCatalog);
profiles.setProfile("ask", ["read"]);
assert.deepEqual(active, stableCatalog);
assert.deepEqual(profiles.getAllowedTools(), ["read"]);

registered.add("web_fetch");
profiles.setProfile("ask", ["read", "web_fetch"]);
assert.deepEqual(
  active,
  [...stableCatalog, "web_fetch"],
  "newly configured tools append without reordering the existing cache prefix",
);
const expandedCatalog = [...active];

profiles.activate("normal");
let start = await emit("before_agent_start", { systemPrompt: "base" });
assert.match(start.systemPrompt, new RegExp(MODE_PROTOCOL_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
assert.equal(start.message.customType, MODE_STATE_CUSTOM_TYPE);
assert.match(start.message.content, /mode: normal/);
assert.match(start.message.content, /allowed_tools: \["shell_command"\]/);
entries.push({
  type: "message",
  message: {
    role: "custom",
    ...start.message,
    timestamp: Date.now(),
  },
});
start = await emit("before_agent_start", { systemPrompt: "base" });
assert.equal(start.message, undefined, "unchanged mode state must not be appended every turn");
assert.match(start.systemPrompt, /PI ONLY TOOLS MODE PROTOCOL/);
await emit("session_compact", { reason: "threshold" });
start = await emit("before_agent_start", { systemPrompt: "base" });
assert.equal(start.message.customType, MODE_STATE_CUSTOM_TYPE, "compaction must force one fresh state block");

profiles.activate("ask");
const askStart = await emit("before_agent_start", { systemPrompt: "base" });
assert.equal(askStart.systemPrompt, undefined, "Ask's later handler owns the shared system protocol");
assert.match(askStart.message.content, /mode: ask/);
assert.match(askStart.message.content, /allowed_tools: \["read","web_fetch"\]/);

assert.equal(await emit("tool_call", { toolName: "read" }), undefined);
const blockedPatch = await emit("tool_call", { toolName: "apply_patch" });
assert.equal(blockedPatch.block, true);
assert.match(blockedPatch.reason, /Ask Mode blocks apply_patch/);

const providerPayload = {
  model: "gpt-5.6",
  tools: expandedCatalog.map((name) => ({ type: "function", name })),
  tool_choice: "auto",
};
const providerResult = await emit("before_provider_request", { payload: providerPayload });
assert.equal(providerResult.tools, providerPayload.tools);
assert.deepEqual(providerResult.tool_choice, {
  type: "allowed_tools",
  mode: "auto",
  tools: [
    { type: "function", name: "read" },
    { type: "function", name: "web_fetch" },
  ],
});

entries.push({
  type: "custom",
  customType: PLAN_STATE_ENTRY,
  data: {
    schemaVersion: 1,
    stage: "ready",
    plan: { path: "/tmp/plan.md", revision: 4, hash: "hash4" },
  },
});
profiles.activate("plan");
const ready = await emit("before_agent_start", { systemPrompt: "base" });
assert.match(ready.message.content, /mode: plan/);
assert.match(ready.message.content, /stage: ready/);
assert.match(ready.message.content, /allowed_tools: \[\]/);
const readyPayload = await emit("before_provider_request", { payload: providerPayload });
assert.equal(readyPayload.tool_choice, "none");
const blockedReady = await emit("tool_call", { toolName: "plan_write" });
assert.equal(blockedReady.block, true);
assert.match(blockedReady.reason, /awaiting an explicit user action/);
const blockedLegacy = await emit("tool_call", { toolName: "ExitPlanMode" });
assert.match(blockedLegacy.reason, /user-controlled/);

await emit("session_start", { reason: "new" });
assert.deepEqual(active, ["shell_command"], "a replacement session restores the Normal allowlist before defaults load");
assert.equal(profiles.mode, "normal");
profiles.apply();
const freshCatalog = ["shell_command", "read", "plan_write", "web_fetch"];
assert.deepEqual(active, freshCatalog, "the fresh session catalogue is rebuilt from current profile permissions");

const dynamicHandlers = new Map();
let dynamicActive = ["shell_command"];
const dynamicPi = {
  on(event, handler) {
    const list = dynamicHandlers.get(event) ?? [];
    list.push(handler);
    dynamicHandlers.set(event, list);
  },
  getAllTools: () => ["shell_command", "read"].map((name) => ({ name })),
  getActiveTools: () => [...dynamicActive],
  setActiveTools: (names) => { dynamicActive = [...names]; },
};
const dynamic = createToolProfileController(dynamicPi, { cacheStrategy: "dynamic-catalog" });
dynamic.setProfile("normal", ["shell_command"], { apply: false });
dynamic.setProfile("ask", ["read"], { apply: false });
dynamic.activate("ask");
assert.deepEqual(dynamicActive, ["read"], "the compatibility strategy preserves legacy physical switching");

const snapshot = profiles.snapshot(ctx);
assert.equal(snapshot.cacheStrategy, "stable-catalog");
assert.deepEqual(snapshot.catalogTools, freshCatalog);
assert.deepEqual(snapshot.activeTools, freshCatalog);
assert.ok(setActiveCalls.length < 10, "idempotent mode switches must not repeatedly call setActiveTools");
console.log("tool profile controller cache-stability tests passed");

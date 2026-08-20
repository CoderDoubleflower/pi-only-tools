import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "pi-only-tools-plan-"));
const agentDir = join(root, "agent");
await mkdir(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;

const { createToolProfileController } = await import("../src/tool-profile-controller.js");
const { registerClaudePlanMode, PLAN_STATE_ENTRY } = await import("../src/plan/index.js");

const handlers = new Map();
const commands = new Map();
const tools = new Map();
const entries = [];
const notifications = [];
const sentMessages = [];
const registered = new Set([
  "shell_command",
  "apply_patch",
  "read",
  "grep",
  "find",
  "ls",
  "web_search",
  "ask_user_question",
]);
let activeTools = ["shell_command", "apply_patch"];
let thinkingLevel = "medium";
let sessionName = "plan-test";
const models = new Map([
  ["base/base-model", { provider: "base", id: "base-model" }],
  ["planner/planner-model", { provider: "planner", id: "planner-model" }],
  ["normal/normal-model", { provider: "normal", id: "normal-model" }],
]);

const sessionManager = {
  getSessionId: () => "plan-session",
  getSessionFile: () => join(root, "plan-session.jsonl"),
  getEntries: () => entries,
  getBranch: () => entries,
};

const ctx = {
  cwd: root,
  mode: "tui",
  hasUI: true,
  sessionManager,
  model: models.get("base/base-model"),
  modelRegistry: {
    find: (provider, model) => models.get(`${provider}/${model}`),
    getAvailable: () => [...models.values()],
  },
  scopedModels: [],
  thinkingLevel,
  isIdle: () => true,
  isProjectTrusted: () => true,
  hasPendingMessages: () => false,
  getSystemPrompt: () => "base prompt",
  waitForIdle: async () => undefined,
  newSession: async () => ({ cancelled: true }),
  ui: {
    theme: { fg: (_color, text) => text },
    select: async () => undefined,
    confirm: async () => true,
    editor: async () => undefined,
    notify: (message, type = "info") => notifications.push({ message, type }),
    setStatus() {},
    setWidget() {},
    getEditorText: () => "",
    setEditorText() {},
  },
};

const pi = {
  on(event, handler) {
    const list = handlers.get(event) ?? [];
    list.push(handler);
    handlers.set(event, list);
  },
  registerTool(tool) {
    tools.set(tool.name, tool);
    registered.add(tool.name);
    if (!activeTools.includes(tool.name)) activeTools.push(tool.name);
  },
  registerCommand(name, command) { commands.set(name, command); },
  registerFlag() {},
  getFlag: () => false,
  getAllTools: () => [...registered].map((name) => ({ name })),
  getActiveTools: () => [...activeTools],
  setActiveTools: (names) => { activeTools = [...names]; },
  appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
  sendMessage(message, options) { sentMessages.push({ message, options }); },
  sendUserMessage(content, options) { sentMessages.push({ user: content, options }); },
  setSessionName(name) { sessionName = name; },
  getSessionName: () => sessionName,
  async setModel(model) { ctx.model = model; return true; },
  getThinkingLevel: () => thinkingLevel,
  setThinkingLevel(level) { thinkingLevel = level; ctx.thinkingLevel = level; },
};

await writeFile(
  join(agentDir, "claude-plan-mode.json"),
  JSON.stringify({
    tools: ["read", "web_search", "ask_user_question"],
    planning: { provider: "planner", model: "planner-model", thinkingLevel: "high" },
    normal: { provider: "normal", model: "normal-model", thinkingLevel: "xhigh" },
  }),
);

const profiles = createToolProfileController(pi);
const plan = registerClaudePlanMode(pi, { toolProfiles: profiles });
// The integrated extension loads the persistent profile matrix before the Plan
// session_start hook runs. Mirror that lifecycle here instead of the removed
// session/permanent denylist model.
profiles.setProfile("normal", ["shell_command", "apply_patch", "EnterPlanMode"], { apply: false });
profiles.setProfile(
  "plan",
  ["read", "ask_user_question", "plan_write", "ExitPlanMode"],
  { apply: false },
);
profiles.activate("normal");
assert.equal(plan.enabled, true);

async function emit(event, payload = {}) {
  let result;
  for (const handler of handlers.get(event) ?? []) {
    const next = await handler({ type: event, ...payload }, ctx);
    if (next !== undefined) result = next;
  }
  return result;
}

await emit("session_start", { reason: "startup" });
await commands.get("plan").handler("on Inspect the repository", ctx);
assert.equal(profiles.mode, "plan");
assert.deepEqual(activeTools, ["read", "plan_write", "ExitPlanMode", "ask_user_question"]);
assert.equal(ctx.model.provider, "planner");
assert.equal(thinkingLevel, "high");

let promptResult = await emit("before_agent_start", { systemPrompt: "base" });
assert.match(promptResult.systemPrompt, /configured Plan tool allowlist is:/);
assert.match(promptResult.systemPrompt, /read/);
assert.match(promptResult.systemPrompt, /ask_user_question/);
assert.doesNotMatch(promptResult.systemPrompt, /configured Plan tool allowlist is:[^\n]*web_search/);

profiles.setProfile("normal", ["shell_command"]);
assert.deepEqual(activeTools, ["read", "plan_write", "ExitPlanMode", "ask_user_question"]);
profiles.setProfile("plan", ["ask_user_question", "plan_write", "ExitPlanMode"]);
assert.deepEqual(new Set(activeTools), new Set(["plan_write", "ExitPlanMode", "ask_user_question"]));
promptResult = await emit("before_agent_start", { systemPrompt: "base" });
assert.doesNotMatch(promptResult.systemPrompt, /configured Plan tool allowlist is:[^\n]*read/);

const validPlan = "# Implementation Plan\n\n## Context\nReplace the printer bitmap rendering path while preserving behavior.\n\n## Implementation Steps\n1. `src/index.js`\n   - Reuse the existing profile controller and update the concrete integration path.\n\n## Verification\n- `npm test`\n- Confirm the end-to-end Plan handoff.\n";
await tools.get("plan_write").execute("write", { content: validPlan, expected_revision: 1 }, undefined, undefined, ctx);
await tools.get("ExitPlanMode").execute("exit", {}, undefined, undefined, ctx);
assert.equal(entries.filter((entry) => entry.customType === PLAN_STATE_ENTRY).at(-1).data.stage, "ready");
assert.equal(profiles.mode, "plan");

await commands.get("plan-approve").handler("keep", ctx);
assert.equal(profiles.mode, "normal");
assert.ok(activeTools.includes("shell_command"));
assert.equal(ctx.model.provider, "normal");
assert.equal(thinkingLevel, "xhigh");
assert.ok(sentMessages.some((entry) => entry.message?.customType));

await commands.get("plan").handler("finish", ctx);
assert.equal(profiles.mode, "normal");
assert.ok(activeTools.includes("shell_command"));

await rm(root, { recursive: true, force: true });
console.log("integrated Plan profile tests passed");

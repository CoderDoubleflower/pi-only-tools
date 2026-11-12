import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "pi-only-tools-plan-v2-"));
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
const pendingDispatches = [];
const terminalInputHandlers = new Set();
const reviewChoices = ["Keep reviewing for now"];
const reviewPrompts = [];
const registered = new Set([
  "shell_command",
  "apply_patch",
  "read",
  "grep",
  "find",
  "ls",
  "ask_user_question",
]);
let activeTools = ["shell_command", "apply_patch"];
let thinkingLevel = "medium";
let sessionName = "plan-test";
let idle = true;
let releaseIdle;
let waitForIdleCalls = 0;
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
  isIdle: () => idle,
  isProjectTrusted: () => true,
  hasPendingMessages: () => false,
  getSystemPrompt: () => "base prompt",
  waitForIdle: async () => {
    waitForIdleCalls += 1;
    if (!idle) await new Promise((resolve) => { releaseIdle = resolve; });
  },
  newSession: async () => ({ cancelled: true }),
  ui: {
    theme: { fg: (_color, text) => text },
    async select(title, choices) {
      reviewPrompts.push({ title, choices });
      return reviewChoices.shift();
    },
    confirm: async () => true,
    editor: async () => undefined,
    notify: (message, type = "info") => notifications.push({ message, type }),
    setStatus() {},
    setWidget() {},
    getEditorText: () => "",
    setEditorText() {},
    onTerminalInput(handler) {
      terminalInputHandlers.add(handler);
      return () => terminalInputHandlers.delete(handler);
    },
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
  getAllTools: () => [...registered].map((name) => tools.get(name) ?? { name }),
  getActiveTools: () => [...activeTools],
  setActiveTools: (names) => { activeTools = [...names]; },
  appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
  sendMessage(message, options) { sentMessages.push({ message, options }); },
  sendUserMessage(content, options) {
    sentMessages.push({ user: content, options });
    if (
      options?.expandPromptTemplates !== true ||
      typeof content !== "string" ||
      !content.startsWith("/")
    ) {
      return;
    }
    const [commandName, ...rest] = content.slice(1).split(/\s+/);
    const command = commands.get(commandName);
    if (!command) throw new Error(`Unknown dispatched command: ${commandName}`);
    pendingDispatches.push(
      Promise.resolve().then(() => command.handler(rest.join(" "), ctx)),
    );
  },
  setSessionName(name) { sessionName = name; },
  getSessionName: () => sessionName,
  async setModel(model) { ctx.model = model; return true; },
  getThinkingLevel: () => thinkingLevel,
  setThinkingLevel(level) { thinkingLevel = level; ctx.thinkingLevel = level; },
};

await writeFile(
  join(agentDir, "claude-plan-mode.json"),
  JSON.stringify({
    tools: ["read", "ask_user_question", "ExitPlanMode"],
    planning: { provider: "planner", model: "planner-model", thinkingLevel: "high" },
    normal: { provider: "normal", model: "normal-model", thinkingLevel: "xhigh" },
  }),
);

const profiles = createToolProfileController(pi);
const plan = registerClaudePlanMode(pi, { toolProfiles: profiles });
profiles.setProfile(
  "normal",
  ["shell_command", "apply_patch", "EnterPlanMode"],
  { apply: false },
);
profiles.setProfile("ask", ["read", "ask_user_question"], { apply: false });
profiles.setProfile(
  "plan",
  ["read", "ask_user_question", "plan_write", "ExitPlanMode", "mcp__late__read"],
  { apply: false },
);
profiles.activate("normal");
const normalTools = ["shell_command", "apply_patch", "EnterPlanMode"];
const askTools = ["read", "ask_user_question"];
const planTools = ["read", "ask_user_question", "plan_write"];
function assertActive(expected, message) {
  assert.deepEqual([...activeTools].sort(), [...expected].sort(), message);
}
assertActive(normalTools);
assert.equal(plan.enabled, true);
assert.equal(plan.getMode(), "normal");
assert.deepEqual([...tools.keys()].sort(), ["EnterPlanMode", "plan_write"].sort());
assert.equal(tools.has("ExitPlanMode"), false, "ExitPlanMode must not be registered for the model");
assert.equal(tools.get("EnterPlanMode").exposure, "model-only");
assert.equal(tools.get("plan_write").exposure, "model-only");
assert.ok(commands.has("mode"), "the integrated runtime must register /mode");
assert.equal(commands.has("ask"), false, "Ask must not expose a separate command");

async function emit(event, payload = {}) {
  let result;
  for (const handler of handlers.get(event) ?? []) {
    const next = await handler({ type: event, ...payload }, ctx);
    if (event === "tool_call" && next?.block) return next;
    if (next !== undefined) result = next;
  }
  return result;
}

async function runtimeState(messages = [{ role: "user", content: "test", timestamp: 1 }]) {
  const result = await emit("context", { messages });
  return result.messages.at(-1);
}

async function waitForMode(mode) {
  for (let i = 0; i < 50 && plan.getMode() !== mode; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(plan.getMode(), mode);
}

await emit("session_start", { reason: "startup" });
assert.equal(terminalInputHandlers.size, 1, "one controller must own Shift+Tab");
const terminalInputHandler = [...terminalInputHandlers][0];

assert.deepEqual(terminalInputHandler("\u001b[Z"), { consume: true });
await waitForMode("ask");
assert.equal(profiles.mode, "ask");
assertActive(askTools);
let promptResult = await emit("before_agent_start", { systemPrompt: "base" });
assert.match(promptResult.systemPrompt, /Pi manages tool declarations and records their changes in the conversation\./);
assert.doesNotMatch(promptResult.systemPrompt, /PI-ONLY-TOOLS MODE PROTOCOL/);
assert.match(promptResult.systemPrompt, /strictly read-only/);
assert.doesNotMatch(promptResult.systemPrompt, /"mode": "ask"/);
let stateMessage = await runtimeState();
assert.match(stateMessage.content, /"mode": "ask"/);
assert.match(stateMessage.content, /"read"/);
assert.doesNotMatch(stateMessage.content, /"shell_command"/);
const blockedEdit = await emit("tool_call", { toolName: "apply_patch" });
assert.equal(blockedEdit.block, true);
assert.match(blockedEdit.reason, /Ask Mode blocks apply_patch/);
assert.equal(await emit("tool_call", { toolName: "read" }), undefined);

assert.deepEqual(terminalInputHandler("\u001b[Z"), { consume: true });
await waitForMode("plan");
assert.equal(profiles.mode, "plan");
assertActive(planTools);
assert.ok(profiles.getRequestedTools("plan").includes("mcp__late__read"),
  "entering Plan must preserve explicit permissions for tools that are not registered yet");
registered.add("mcp__late__read");
profiles.apply();
planTools.push("mcp__late__read");
assertActive(planTools);
assert.equal(await emit("tool_call", { toolName: "mcp__late__read" }), undefined);

assert.deepEqual(terminalInputHandler("\u001b[Z"), { consume: true });
await waitForMode("normal");
assert.equal(profiles.mode, "normal");
assertActive(normalTools);

await commands.get("plan").handler("on Inspect the review workflow", ctx);
assert.equal(profiles.mode, "plan");
assert.equal(plan.getMode(), "plan");
assertActive(planTools);
assert.equal(ctx.model.provider, "planner");
assert.equal(thinkingLevel, "high");

promptResult = await emit("before_agent_start", { systemPrompt: "base" });
assert.match(promptResult.systemPrompt, /Repository reconnaissance/);
assert.match(promptResult.systemPrompt, /verified current state/i);
assert.doesNotMatch(promptResult.systemPrompt, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
assert.doesNotMatch(promptResult.systemPrompt, /ExitPlanMode/);
stateMessage = await runtimeState();
assert.match(stateMessage.content, /"mode": "plan"/);
assert.match(stateMessage.content, /"workflowStage": "planning"/);
assert.match(stateMessage.content, /"canonicalPlan"/);
assert.match(stateMessage.content, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

const invalidResult = await tools.get("plan_write").execute(
  "invalid",
  { content: "# Too short\n\n## Context\nMissing the required verified structure.\n", expected_revision: 1 },
  undefined,
  undefined,
  ctx,
);
assert.equal(invalidResult.terminate, undefined);
assert.match(invalidResult.content[0].text, /not ready for review/);
assert.equal(plan.getStage(), "planning");

const validPlan = `# Make Plan approval user-controlled

## Context
The current workflow exposes a model-callable exit action and repeats the same plan during approval. The change must publish one reviewable revision, preserve the existing revision/hash snapshot, and transition to implementation only after an explicit user choice.

## Current State
- \`src/plan/index.js\`: \`registerClaudePlanMode\` owns planning state, publication, the review command, and execution handoff.
- \`src/plan/tool-set.js\`: \`buildPlanningTools\` determines the model-visible planning allowlist.
- \`src/plan-tool-ui.js\`: the current renderer receives the complete plan in the call arguments and can render it without duplicating model-visible output.

## Implementation Steps
1. **Publish directly from plan_write**
   - Files: \`src/plan/index.js\`, \`src/plan/tool-set.js\`
   - Change: validate the complete document, create the ready snapshot, terminate the planning turn, and exclude the legacy exit action from registered and active tools.
   - Reuse: \`isPlanReady\` from \`src/plan/plan-store.js\` and \`approvePlan\` from \`src/plan/handoff.js\`.
   - Flow: planning moves to ready after publication; only the user review command can move ready to executing.
2. **Render the plan exactly once**
   - Files: \`src/plan-tool-ui.js\`, \`src/claude-tool-ui.js\`
   - Change: use the shared call/result layout and render the Markdown body with Pi Markdown.
   - Dependencies: state metadata must be finalized before rendering the result status.

## Risks and Compatibility
- Existing profile files can contain the removed control tool, so loaders must filter it and persist a migrated configuration version.

## Verification
- Automated: \`npm test\`
- Integration: confirm planning → ready occurs after a valid plan_write and ready → executing occurs only after the user chooses execution.
- Manual/TUI: confirm one readable plan is shown with no visible or model-callable exit action.
`;

const validResult = await tools.get("plan_write").execute(
  "valid",
  { content: validPlan, expected_revision: 2 },
  undefined,
  undefined,
  ctx,
);
assert.equal(validResult.terminate, true);
assert.equal(validResult.details.readiness.ready, true);
assert.doesNotMatch(validResult.content[0].text, /# Make Plan approval/);
assert.equal(entries.filter((entry) => entry.customType === PLAN_STATE_ENTRY).at(-1).data.stage, "ready");
assert.equal(profiles.mode, "plan");
assertActive(planTools);
stateMessage = await runtimeState();
assert.match(stateMessage.content, /"workflowStage": "ready"/);
assert.match(stateMessage.content, /"allowedTools": \[\]/);

await emit("agent_settled");
await Promise.all(pendingDispatches);
assert.equal(reviewPrompts.length, 1, "a valid plan_write must open the user review menu after rendering");
assert.ok(reviewPrompts[0].choices.includes("Execute plan (keep context)"));
assert.equal(plan.getStage(), "ready", "dismissing execution must keep the published revision ready");

const blockedExit = await emit("tool_call", { toolName: "ExitPlanMode" });
assert.equal(blockedExit.block, true);
assert.match(blockedExit.reason, /user-controlled/);

await commands.get("plan-approve").handler("keep", ctx);
assert.equal(plan.getStage(), "executing");
assert.equal(profiles.mode, "normal");
assertActive(normalTools);
assert.equal(ctx.model.provider, "normal");
assert.equal(thinkingLevel, "xhigh");
const handoff = sentMessages.find((entry) => entry.message?.customType === "claude-plan-mode-handoff");
assert.ok(handoff);
assert.equal(handoff.message.display, false, "approved-plan handoff must stay model-visible but hidden from the transcript");
assert.match(handoff.message.content, /<approved-plan/);

await commands.get("plan").handler("finish", ctx);
assert.equal(plan.getStage(), "idle");
assert.equal(profiles.mode, "normal");
assertActive(normalTools);

// Commands wait before changing state or removing Ask's active profile.
await plan.enterAskMode(ctx, { notify: false });
idle = false;
let pendingCommand = commands.get("plan").handler("on", ctx);
await Promise.resolve();
assert.equal(typeof releaseIdle, "function");
assert.equal(plan.getMode(), "ask");
assert.equal(plan.getStage(), "idle");
assertActive(askTools);
idle = true;
releaseIdle();
await pendingCommand;
assert.equal(plan.getStage(), "planning");
assert.equal(plan.getMode(), "plan");

idle = false;
releaseIdle = undefined;
pendingCommand = commands.get("plan").handler("off", ctx);
await Promise.resolve();
assert.equal(typeof releaseIdle, "function");
assert.equal(plan.getStage(), "planning");
assertActive(planTools);
idle = true;
releaseIdle();
await pendingCommand;
assert.equal(plan.getStage(), "idle");
assertActive(normalTools);
assert.equal(waitForIdleCalls, 2, "each busy command waits once before applying its mode change");

// A model tool runs inside the active agent turn and must not wait on itself.
idle = false;
const enteredByTool = await tools.get("EnterPlanMode").execute(
  "enter-from-model", { reason: "Validate model tool entry" }, undefined, undefined, ctx,
);
assert.equal(enteredByTool.details.entered, true);
assert.equal(enteredByTool.terminate, true);
assert.equal(waitForIdleCalls, 2);
idle = true;

await tools.get("plan_write").execute(
  "publish-for-fresh-session", { content: validPlan, expected_revision: 1 }, undefined, undefined, ctx,
);
const readySnapshot = structuredClone(plan.getState().ready);
idle = false;
releaseIdle = undefined;
pendingCommand = commands.get("plan-approve").handler("clear", ctx);
await Promise.resolve();
assert.equal(typeof releaseIdle, "function");
assert.equal(plan.getStage(), "ready", "approval must wait for the current turn");
idle = true;
releaseIdle();
await pendingCommand;
assert.equal(plan.getStage(), "ready", "canceling fresh-session creation preserves readiness");
assert.equal(plan.getState().ready.revision, readySnapshot.revision);
assert.equal(plan.getState().ready.hash, readySnapshot.hash);

const freshEntries = [];
const freshMessages = [];
ctx.newSession = async (options) => {
  assert.equal(options.parentSession, sessionManager.getSessionFile());
  await options.setup({
    appendCustomEntry(customType, data) { freshEntries.push({ customType, data }); },
    appendSessionInfo(name) { freshEntries.push({ name }); },
  });
  await options.withSession({
    async sendMessage(message, options) { freshMessages.push({ message, options }); },
  });
  return { cancelled: false };
};
await commands.get("plan-approve").handler("clear", ctx);
assert.equal(plan.getStage(), "handed_off");
const executionEntry = freshEntries.find((entry) => entry.customType === PLAN_STATE_ENTRY);
assert.equal(executionEntry.data.stage, "executing");
assert.equal(executionEntry.data.approved.hash, readySnapshot.hash);
assert.equal(freshMessages.length, 1);
assert.equal(freshMessages[0].message.display, true,
  "a fresh execution session must show its approved-plan handoff");
assert.equal(freshMessages[0].options.triggerTurn, true);
assert.match(freshMessages[0].message.content, /<approved-plan/);

await emit("session_shutdown");
assert.equal(terminalInputHandlers.size, 0);
await rm(root, { recursive: true, force: true });
console.log("Normal/Ask/Plan dynamic profiles, publication, command timing, and handoff tests passed");

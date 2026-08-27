import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "pi-only-tools-plan-v2-"));
const agentDir = join(root, "agent");
await mkdir(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;

const { MODE_PROTOCOL_MARKER, MODE_STATE_CUSTOM_TYPE } = await import("../src/mode-cache-policy.js");
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
const models = new Map([
  [
    "base/base-model",
    {
      provider: "base",
      id: "base-model",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    },
  ],
  [
    "planner/planner-model",
    {
      provider: "planner",
      id: "planner-model",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    },
  ],
  [
    "normal/normal-model",
    {
      provider: "normal",
      id: "normal-model",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    },
  ],
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
  getAllTools: () => [...registered].map((name) => ({ name })),
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
  ["read", "ask_user_question", "plan_write", "ExitPlanMode"],
  { apply: false },
);
profiles.activate("normal");
const stableCatalogNames = new Set([
  "shell_command",
  "apply_patch",
  "read",
  "ask_user_question",
  "EnterPlanMode",
  "plan_write",
]);
const stableCatalog = [...registered].filter((name) => stableCatalogNames.has(name));
assert.deepEqual(activeTools, stableCatalog);
assert.equal(plan.enabled, true);
assert.equal(plan.getMode(), "normal");
assert.deepEqual([...tools.keys()].sort(), ["EnterPlanMode", "plan_write"].sort());
assert.equal(tools.has("ExitPlanMode"), false, "ExitPlanMode must not be registered for the model");
assert.ok(commands.has("mode"), "the integrated runtime must register /mode");
assert.equal(commands.has("ask"), false, "Ask must not expose a separate command");

async function emit(event, payload = {}) {
  let current = { type: event, ...payload };
  let last;
  const combined = {};
  for (const handler of handlers.get(event) ?? []) {
    const next = await handler(current, ctx);
    if (next === undefined) continue;
    last = next;
    if (event === "before_agent_start") {
      if (next.systemPrompt !== undefined) {
        current = { ...current, systemPrompt: next.systemPrompt };
        combined.systemPrompt = next.systemPrompt;
      }
      if (next.message !== undefined) combined.message = next.message;
    }
  }
  return event === "before_agent_start" ? combined : last;
}

async function waitForMode(mode) {
  for (let i = 0; i < 50 && plan.getMode() !== mode; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(plan.getMode(), mode);
}

await emit("session_start", { reason: "startup" });
assert.deepEqual(activeTools, stableCatalog, "session restore must rebuild one stable union catalogue");
assert.equal(terminalInputHandlers.size, 1, "one controller must own Shift+Tab");
const terminalInputHandler = [...terminalInputHandlers][0];

assert.deepEqual(terminalInputHandler("\u001b[Z"), { consume: true });
await waitForMode("ask");
assert.equal(profiles.mode, "ask");
assert.deepEqual(activeTools, stableCatalog);
let promptResult = await emit("before_agent_start", { systemPrompt: "base" });
const askSystemPrompt = promptResult.systemPrompt;
assert.match(askSystemPrompt, new RegExp(MODE_PROTOCOL_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
assert.equal(promptResult.message.customType, MODE_STATE_CUSTOM_TYPE);
assert.match(promptResult.message.content, /mode: ask/);
assert.match(promptResult.message.content, /allowed_tools: \["read","ask_user_question"\]/);
assert.doesNotMatch(promptResult.message.content, /shell_command|apply_patch/);
const blockedEdit = await emit("tool_call", { toolName: "apply_patch" });
assert.equal(blockedEdit.block, true);
assert.match(blockedEdit.reason, /Ask Mode blocks apply_patch/);
assert.equal(await emit("tool_call", { toolName: "read" }), undefined);

const providerPayload = {
  tools: stableCatalog.map((name) => ({ type: "function", name })),
  tool_choice: "auto",
};
let providerResult = await emit("before_provider_request", { payload: providerPayload });
assert.equal(providerResult.tools, providerPayload.tools);
assert.deepEqual(providerResult.tool_choice.tools, [
  { type: "function", name: "read" },
  { type: "function", name: "ask_user_question" },
]);

assert.deepEqual(terminalInputHandler("\u001b[Z"), { consume: true });
await waitForMode("plan");
assert.equal(profiles.mode, "plan");
assert.deepEqual(activeTools, stableCatalog);

assert.deepEqual(terminalInputHandler("\u001b[Z"), { consume: true });
await waitForMode("normal");
assert.equal(profiles.mode, "normal");
assert.deepEqual(activeTools, stableCatalog);
let normalPrompt = await emit("before_agent_start", { systemPrompt: "base" });
assert.equal(normalPrompt.systemPrompt, askSystemPrompt, "Normal and Ask must share an identical system-prompt suffix");

await commands.get("plan").handler("on Inspect the review workflow", ctx);
assert.equal(profiles.mode, "plan");
assert.equal(plan.getMode(), "plan");
assert.deepEqual(activeTools, stableCatalog);
assert.equal(ctx.model.provider, "planner");
assert.equal(thinkingLevel, "high");

promptResult = await emit("before_agent_start", { systemPrompt: "base" });
assert.equal(promptResult.systemPrompt, askSystemPrompt, "Plan must use the same stable system prompt as Ask and Normal");
assert.match(promptResult.systemPrompt, /Repository reconnaissance/);
assert.match(promptResult.systemPrompt, /verified current state/i);
assert.doesNotMatch(promptResult.systemPrompt, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
assert.doesNotMatch(promptResult.systemPrompt, /plan_revision|plan_sha256/);
assert.match(promptResult.message.content, /mode: plan/);
assert.match(promptResult.message.content, /stage: planning/);
assert.match(promptResult.message.content, /plan_path:/);
assert.match(promptResult.message.content, /plan_revision: 1/);
assert.match(promptResult.message.content, /allowed_tools: \["read","plan_write","ask_user_question"\]/);

providerResult = await emit("before_provider_request", { payload: providerPayload });
assert.deepEqual(providerResult.tool_choice.tools, [
  { type: "function", name: "read" },
  { type: "function", name: "ask_user_question" },
  { type: "function", name: "plan_write" },
]);

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
assert.deepEqual(activeTools, stableCatalog);
assert.deepEqual(profiles.getAllowedTools("plan", plan.getState()), []);
providerResult = await emit("before_provider_request", { payload: providerPayload });
assert.equal(providerResult.tool_choice, "none", "ready review must disable model tool selection");
const blockedReadyWrite = await emit("tool_call", { toolName: "plan_write" });
assert.equal(blockedReadyWrite.block, true);
assert.match(blockedReadyWrite.reason, /awaiting an explicit user action/);

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
assert.deepEqual(activeTools, stableCatalog);
assert.equal(ctx.model.provider, "normal");
assert.equal(thinkingLevel, "xhigh");
const handoff = sentMessages.find((entry) => entry.message?.customType === "claude-plan-mode-handoff");
assert.ok(handoff);
assert.equal(handoff.message.display, false, "approved-plan handoff must stay model-visible but hidden from the transcript");
assert.match(handoff.message.content, /<approved-plan/);
normalPrompt = await emit("before_agent_start", { systemPrompt: "base" });
assert.equal(normalPrompt.systemPrompt, askSystemPrompt);
assert.match(normalPrompt.message.content, /stage: executing/);
assert.match(normalPrompt.message.content, /approved_revision:/);

await commands.get("plan").handler("finish", ctx);
assert.equal(plan.getStage(), "idle");
assert.equal(profiles.mode, "normal");
assert.deepEqual(activeTools, stableCatalog);

await emit("session_shutdown");
assert.equal(terminalInputHandlers.size, 0);
await rm(root, { recursive: true, force: true });
console.log("Normal/Ask/Plan stable-catalog workflow integration tests passed");

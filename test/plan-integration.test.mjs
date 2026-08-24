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
  if (options?.expandPromptTemplates !== true || typeof content !== "string" || !content.startsWith("/")) return;
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
profiles.setProfile("normal", ["shell_command", "apply_patch", "EnterPlanMode"], { apply: false });
profiles.setProfile("plan", ["read", "ask_user_question", "plan_write", "ExitPlanMode"], { apply: false });
profiles.activate("normal");
assert.equal(plan.enabled, true);
assert.deepEqual([...tools.keys()].sort(), ["EnterPlanMode", "plan_write"].sort());
assert.equal(tools.has("ExitPlanMode"), false, "ExitPlanMode must not be registered for the model");

async function emit(event, payload = {}) {
  let result;
  for (const handler of handlers.get(event) ?? []) {
    const next = await handler({ type: event, ...payload }, ctx);
    if (next !== undefined) result = next;
  }
  return result;
}

await emit("session_start", { reason: "startup" });
assert.equal(terminalInputHandlers.size, 1);
const terminalInputHandler = [...terminalInputHandlers][0];
assert.deepEqual(terminalInputHandler("\u001b[Z"), { consume: true });
for (let i = 0; i < 50 && profiles.mode !== "plan"; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
assert.equal(profiles.mode, "plan");
assert.deepEqual(terminalInputHandler("\u001b[Z"), { consume: true });
for (let i = 0; i < 50 && profiles.mode !== "normal"; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
assert.equal(profiles.mode, "normal");

await commands.get("plan").handler("on Inspect the review workflow", ctx);
assert.equal(profiles.mode, "plan");
assert.deepEqual(activeTools, ["read", "plan_write", "ask_user_question"]);
assert.equal(ctx.model.provider, "planner");
assert.equal(thinkingLevel, "high");

let promptResult = await emit("before_agent_start", { systemPrompt: "base" });
assert.match(promptResult.systemPrompt, /Repository reconnaissance/);
assert.match(promptResult.systemPrompt, /Current State/);
assert.doesNotMatch(promptResult.systemPrompt, /ExitPlanMode/);
assert.match(promptResult.systemPrompt, /do not call any exit/i);

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
   - Change: use the shared call/result layout and render the Markdown body with semantic styles rather than one muted color.
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
assert.deepEqual(activeTools, ["read", "plan_write", "ask_user_question"]);

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
assert.deepEqual(activeTools, ["shell_command", "apply_patch", "EnterPlanMode"]);
assert.equal(ctx.model.provider, "normal");
assert.equal(thinkingLevel, "xhigh");
const handoff = sentMessages.find((entry) => entry.message?.customType === "claude-plan-mode-handoff");
assert.ok(handoff);
assert.equal(handoff.message.display, false, "approved-plan handoff must stay model-visible but hidden from the transcript");
assert.match(handoff.message.content, /<approved-plan/);

await commands.get("plan").handler("finish", ctx);
assert.equal(plan.getStage(), "idle");
assert.equal(profiles.mode, "normal");

await emit("session_shutdown");
assert.equal(terminalInputHandlers.size, 0);
await rm(root, { recursive: true, force: true });
console.log("user-controlled Plan workflow integration tests passed");

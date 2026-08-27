import assert from "node:assert/strict";
import { registerAskMode } from "../src/ask-mode.js";
import {
  ASK_MODE_STATUS_KEY,
  buildAskModeContext,
  buildAskSystemPrompt,
  buildAskTools,
  isAskToolConfigurable,
} from "../src/ask-mode-policy.js";
import {
  buildModeSystemPrompt,
  buildNormalModeContext,
} from "../src/mode-prompt.js";
import {
  applyOpenAIAllowedTools,
  supportsOpenAIAllowedTools,
} from "../src/provider-tool-policy.js";
import {
  MODE_STATUS_KEY_PREFIX,
  PLAN_STATUS_KEY,
} from "../src/plan/constants.js";
import { createToolProfileController } from "../src/tool-profile-controller.js";

assert.equal(isAskToolConfigurable("read"), true);
assert.equal(isAskToolConfigurable("mcp__github__get_file_contents"), true);
assert.equal(isAskToolConfigurable("web_fetch"), true);
assert.equal(isAskToolConfigurable("shell_command"), false);
assert.equal(isAskToolConfigurable("apply_patch"), false);
assert.equal(isAskToolConfigurable("write"), false);
assert.deepEqual(
  buildAskTools(
    [
      "read",
      "web_fetch",
      "mcp__github__get_file_contents",
      "shell_command",
      "apply_patch",
      "read",
    ],
    new Set([
      "read",
      "web_fetch",
      "mcp__github__get_file_contents",
      "shell_command",
      "apply_patch",
    ]),
  ),
  ["read", "web_fetch", "mcp__github__get_file_contents"],
);

assert.equal(buildAskSystemPrompt(), buildModeSystemPrompt());
assert.match(buildAskModeContext(["read", "web_fetch"]), /\[ASK MODE ACTIVE\]/);
assert.match(buildAskModeContext(["read", "web_fetch"]), /allowed_tools=\["read","web_fetch"\]/);
assert.match(buildNormalModeContext(["shell_command"]), /mode=normal/);

const responseTools = [
  { type: "function", name: "read", description: "read" },
  { type: "function", name: "web_fetch", description: "fetch" },
  { type: "function", name: "apply_patch", description: "patch" },
];
const responsePayload = {
  model: "gpt-5.6",
  input: [],
  stream: true,
  tools: responseTools,
};
const restrictedPayload = applyOpenAIAllowedTools(responsePayload, ["read", "web_fetch"]);
assert.strictEqual(restrictedPayload.tools, responseTools, "provider adapter must preserve the stable tools array");
assert.deepEqual(restrictedPayload.tool_choice, {
  type: "allowed_tools",
  mode: "auto",
  tools: [
    { type: "function", name: "read" },
    { type: "function", name: "web_fetch" },
  ],
});
assert.equal(applyOpenAIAllowedTools(responsePayload, []).tool_choice, "none");
assert.equal(applyOpenAIAllowedTools({ messages: [], tools: responseTools }, ["read"]), undefined);
assert.equal(supportsOpenAIAllowedTools({ api: "openai-responses", provider: "openai" }), true);
assert.equal(supportsOpenAIAllowedTools({ api: "openai-responses", provider: "openai-codex" }), true);
assert.equal(supportsOpenAIAllowedTools({ api: "openai-responses", provider: "openrouter" }), false);

assert.notEqual(ASK_MODE_STATUS_KEY, PLAN_STATUS_KEY);
assert.equal(ASK_MODE_STATUS_KEY.startsWith(MODE_STATUS_KEY_PREFIX), true);
assert.equal(PLAN_STATUS_KEY.startsWith(MODE_STATUS_KEY_PREFIX), true);
const otherStatusKeys = ["alpha-plugin", "mcp-adaptor", "zeta-plugin"];
const footerSlot = (modeStatusKey) =>
  [...otherStatusKeys, modeStatusKey]
    .sort((left, right) => left.localeCompare(right))
    .indexOf(modeStatusKey);
assert.equal(footerSlot(ASK_MODE_STATUS_KEY), footerSlot(PLAN_STATUS_KEY));
assert.equal(footerSlot(ASK_MODE_STATUS_KEY), 0);

const handlers = new Map();
const commands = new Map();
const terminalHandlers = new Set();
const entries = [];
const notifications = [];
const modeChoices = [];
const modePrompts = [];
const registered = new Set([
  "shell_command",
  "apply_patch",
  "read",
  "grep",
  "find",
  "ls",
  "web_fetch",
  "mcp__github__get_file_contents",
  "ask_user_question",
  "plan_write",
]);
let activeTools = ["shell_command", "apply_patch"];
let planStage = "idle";

const pi = {
  on(event, handler) {
    const list = handlers.get(event) ?? [];
    list.push(handler);
    handlers.set(event, list);
  },
  registerCommand(name, command) {
    commands.set(name, command);
  },
  getAllTools: () => [...registered].map((name) => ({ name })),
  getActiveTools: () => [...activeTools],
  setActiveTools(names) {
    activeTools = [...names];
  },
  appendEntry(customType, data) {
    entries.push({ type: "custom", customType, data });
  },
};

const profiles = createToolProfileController(pi);
profiles.setProfile("normal", ["shell_command", "apply_patch"], { apply: false });
profiles.setProfile(
  "ask",
  [
    "read",
    "web_fetch",
    "mcp__github__get_file_contents",
    "shell_command",
    "apply_patch",
  ],
  { apply: false },
);
profiles.setProfile(
  "plan",
  ["read", "grep", "ask_user_question", "plan_write"],
  { apply: false },
);
profiles.activate("normal");
const initialCatalog = [
  "shell_command",
  "apply_patch",
  "read",
  "grep",
  "web_fetch",
  "mcp__github__get_file_contents",
  "ask_user_question",
  "plan_write",
];
assert.deepEqual(activeTools, initialCatalog);

const ctx = {
  mode: "tui",
  hasUI: true,
  isIdle: () => true,
  waitForIdle: async () => undefined,
  sessionManager: {
    getEntries: () => entries,
    getBranch: () => entries,
  },
  ui: {
    theme: { fg: (_color, text) => text },
    async select(title, choices) {
      modePrompts.push({ title, choices });
      return modeChoices.shift();
    },
    notify(message, type = "info") {
      notifications.push({ message, type });
    },
    setStatus() {},
    onTerminalInput(handler) {
      terminalHandlers.add(handler);
      return () => terminalHandlers.delete(handler);
    },
  },
};

const planMode = {
  getStage: () => planStage,
  async enter() {
    if (planStage === "executing") return false;
    planStage = "planning";
    profiles.activate("plan");
    return true;
  },
  async leave() {
    planStage = "idle";
    profiles.activate("normal");
  },
};

const modes = registerAskMode(pi, { toolProfiles: profiles, planMode });
assert.equal(modes.enabled, true);
assert.ok(commands.has("mode"));
assert.equal(commands.has("ask"), false, "Ask must not register a separate command");

async function emit(event, payload = {}) {
  let result;
  for (const handler of handlers.get(event) ?? []) {
    const next = await handler({ type: event, ...payload }, ctx);
    if (next !== undefined) result = next;
  }
  return result;
}

async function waitFor(predicate) {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail("condition was not reached");
}

await emit("session_start", { reason: "startup" });
assert.equal(terminalHandlers.size, 1);
const terminalInput = [...terminalHandlers][0];
assert.equal(terminalInput("x"), undefined);

modeChoices.push("Ask");
await commands.get("mode").handler("ignored", ctx);
assert.equal(modePrompts.length, 1);
assert.deepEqual(modePrompts[0].choices, ["Normal", "Ask", "Plan"]);
assert.equal(modes.getMode(), "ask");
assert.equal(profiles.snapshot().mode, "ask");
assert.deepEqual(activeTools, initialCatalog, "Ask must keep the model-facing catalogue stable");
assert.deepEqual(modes.getAllowedTools(), [
  "read",
  "web_fetch",
  "mcp__github__get_file_contents",
]);

modeChoices.push("Plan");
await commands.get("mode").handler("", ctx);
assert.equal(modes.getMode(), "plan");
assert.equal(planStage, "planning");
assert.equal(profiles.snapshot().mode, "plan");
assert.deepEqual(activeTools, initialCatalog, "Plan must keep the model-facing catalogue stable");

modeChoices.push("Normal");
await commands.get("mode").handler("", ctx);
assert.equal(modes.getMode(), "normal");
assert.equal(planStage, "idle");
assert.equal(profiles.snapshot().mode, "normal");
assert.deepEqual(activeTools, initialCatalog);

assert.deepEqual(terminalInput("\u001b[Z"), { consume: true });
await waitFor(() => modes.getMode() === "ask");
assert.deepEqual(terminalInput("\u001b[Z"), { consume: true });
await waitFor(() => modes.getMode() === "plan");
assert.deepEqual(terminalInput("\u001b[Z"), { consume: true });
await waitFor(() => modes.getMode() === "normal");

await modes.setMode("ask", ctx, { notify: false });
profiles.setProfile("ask", ["grep", "ask_user_question"], { apply: false });
await modes.applySavedConfiguration(ctx);
assert.deepEqual(activeTools, [
  "shell_command",
  "apply_patch",
  "read",
  "grep",
  "ask_user_question",
  "plan_write",
], "editing profile configuration may intentionally rebuild the stable catalogue");
assert.deepEqual(modes.getAllowedTools(), ["grep", "ask_user_question"]);

planStage = "executing";
assert.deepEqual(terminalInput("\u001b[Z"), { consume: true });
await waitFor(() => notifications.some((entry) => entry.message.includes("switched to Normal")));
assert.equal(modes.getMode(), "normal");
assert.equal(planStage, "executing");
assert.equal(profiles.snapshot().mode, "normal");

await emit("session_shutdown", { reason: "quit" });
assert.equal(terminalHandlers.size, 0);
console.log("Ask Mode selector and stable-catalog state tests passed");

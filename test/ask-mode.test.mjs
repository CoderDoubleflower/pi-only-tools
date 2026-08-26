import assert from "node:assert/strict";
import { registerAskMode } from "../src/ask-mode.js";
import {
  buildAskTools,
  isAskToolConfigurable,
} from "../src/ask-mode-policy.js";
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
assert.deepEqual(activeTools, [
  "read",
  "web_fetch",
  "mcp__github__get_file_contents",
]);

const prompt = await emit("before_agent_start", { systemPrompt: "base" });
assert.match(prompt.systemPrompt, /\[ASK MODE ACTIVE\]/);
assert.match(prompt.systemPrompt, /strictly read-only/);
assert.match(prompt.systemPrompt, /Ask Profile configured in \/only-tools/);
assert.match(prompt.systemPrompt, /web_fetch/);
assert.doesNotMatch(prompt.systemPrompt, /shell_command/);
assert.equal(await emit("tool_call", { toolName: "web_fetch" }), undefined);
const blocked = await emit("tool_call", { toolName: "apply_patch" });
assert.equal(blocked.block, true);
assert.match(blocked.reason, /Ask Mode blocks apply_patch/);

modeChoices.push("Plan");
await commands.get("mode").handler("", ctx);
assert.equal(modes.getMode(), "plan");
assert.equal(planStage, "planning");
assert.equal(profiles.snapshot().mode, "plan");

modeChoices.push("Normal");
await commands.get("mode").handler("", ctx);
assert.equal(modes.getMode(), "normal");
assert.equal(planStage, "idle");
assert.equal(profiles.snapshot().mode, "normal");

assert.deepEqual(terminalInput("\u001b[Z"), { consume: true });
await waitFor(() => modes.getMode() === "ask");
assert.deepEqual(terminalInput("\u001b[Z"), { consume: true });
await waitFor(() => modes.getMode() === "plan");
assert.deepEqual(terminalInput("\u001b[Z"), { consume: true });
await waitFor(() => modes.getMode() === "normal");

await modes.setMode("ask", ctx, { notify: false });
profiles.setProfile("ask", ["grep", "ask_user_question"], { apply: false });
await modes.applySavedConfiguration(ctx);
assert.deepEqual(activeTools, ["grep", "ask_user_question"]);

planStage = "executing";
assert.deepEqual(terminalInput("\u001b[Z"), { consume: true });
await waitFor(() => notifications.some((entry) => entry.message.includes("switched to Normal")));
assert.equal(modes.getMode(), "normal");
assert.equal(planStage, "executing");
assert.equal(profiles.snapshot().mode, "normal");

await emit("session_shutdown", { reason: "quit" });
assert.equal(terminalHandlers.size, 0);
console.log("Ask Mode /mode selector, policy, and cycle tests passed");

import assert from "node:assert/strict";
import { registerAskMode } from "../src/ask-mode.js";
import {
  buildAskTools,
  isAskReadOnlyToolName,
} from "../src/ask-mode-policy.js";
import { createToolProfileController } from "../src/tool-profile-controller.js";

assert.equal(isAskReadOnlyToolName("read"), true);
assert.equal(isAskReadOnlyToolName("mcp__github__get_file_contents"), false);
assert.equal(isAskReadOnlyToolName("web_fetch"), false);
assert.equal(isAskReadOnlyToolName("shell_command"), false);
assert.equal(isAskReadOnlyToolName("apply_patch"), false);
assert.equal(isAskReadOnlyToolName("write"), false);
assert.deepEqual(
  buildAskTools(
    ["read", "web_fetch", "shell_command", "apply_patch", "read"],
    new Set(["read", "web_fetch", "shell_command", "apply_patch"]),
  ),
  ["read"],
);

const handlers = new Map();
const commands = new Map();
const terminalHandlers = new Set();
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
  "web_fetch",
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
  sendUserMessage(content, options) {
    sentMessages.push({ content, options });
  },
};

const profiles = createToolProfileController(pi);
profiles.setProfile("normal", ["shell_command", "apply_patch"], { apply: false });
profiles.setProfile(
  "plan",
  [
    "read",
    "grep",
    "web_fetch",
    "ask_user_question",
    "shell_command",
    "apply_patch",
    "plan_write",
  ],
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
    planStage = "planning";
    profiles.activate("plan");
    return true;
  },
  async leave() {
    planStage = "idle";
    profiles.activate("normal");
  },
};

const ask = registerAskMode(pi, { toolProfiles: profiles, planMode });
assert.equal(ask.enabled, true);
assert.ok(commands.has("ask"));

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
assert.deepEqual(terminalInput("\u001b[Z"), { consume: true });
await waitFor(() => ask.getMode() === "ask");
assert.equal(profiles.snapshot().mode, "ask");
assert.deepEqual(activeTools, ["read", "grep", "ask_user_question"]);

const prompt = await emit("before_agent_start", { systemPrompt: "base" });
assert.match(prompt.systemPrompt, /\[ASK MODE ACTIVE\]/);
assert.match(prompt.systemPrompt, /strictly read-only/);
assert.doesNotMatch(prompt.systemPrompt, /shell_command/);
assert.equal(await emit("tool_call", { toolName: "read" }), undefined);
const blocked = await emit("tool_call", { toolName: "apply_patch" });
assert.equal(blocked.block, true);
assert.match(blocked.reason, /Ask Mode blocks apply_patch/);

assert.deepEqual(terminalInput("\u001b[Z"), { consume: true });
await waitFor(() => ask.getMode() === "plan");
assert.equal(planStage, "planning");
assert.equal(profiles.snapshot().mode, "plan");

assert.deepEqual(terminalInput("\u001b[Z"), { consume: true });
await waitFor(() => ask.getMode() === "normal");
assert.equal(planStage, "idle");
assert.equal(profiles.snapshot().mode, "normal");

await commands.get("ask").handler("on Explain the repository", ctx);
assert.equal(ask.getMode(), "ask");
assert.deepEqual(sentMessages.at(-1), {
  content: "Explain the repository",
  options: { expandPromptTemplates: true },
});
await commands.get("ask").handler("off", ctx);
assert.equal(ask.getMode(), "normal");
assert.ok(notifications.some((entry) => entry.message.includes("Ask Mode enabled")));

await emit("session_shutdown", { reason: "quit" });
assert.equal(terminalHandlers.size, 0);
console.log("Ask Mode policy and cycle tests passed");

import assert from "node:assert/strict";
import { PROFILE_CONFIG_VERSION, PROFILE_NAMES } from "../src/profile-config.js";
import {
  runtimeToolsForProfile,
  __test,
} from "../src/profile-matrix-ui.js";

assert.equal(PROFILE_CONFIG_VERSION, 4);
assert.deepEqual(PROFILE_NAMES, ["normal", "ask", "plan"]);

assert.deepEqual(__test.lockedCell("plan", "plan_write"), {
  locked: true,
  value: true,
  reason: "required",
});
assert.deepEqual(__test.lockedCell("normal", "plan_write"), {
  locked: true,
  value: false,
  reason: "control",
});
assert.deepEqual(__test.lockedCell("ask", "shell_command"), {
  locked: true,
  value: false,
  reason: "ask",
});
assert.deepEqual(__test.lockedCell("ask", "web_fetch"), {
  locked: false,
  value: undefined,
  reason: undefined,
});
assert.deepEqual(
  runtimeToolsForProfile("plan", ["read", "EnterPlanMode", "ExitPlanMode"]),
  ["read", "plan_write"],
);
assert.deepEqual(
  runtimeToolsForProfile("ask", [
    "read",
    "web_fetch",
    "mcp__github__get_file_contents",
    "shell_command",
    "apply_patch",
    "plan_write",
  ]),
  ["read", "web_fetch", "mcp__github__get_file_contents"],
);
assert.deepEqual(
  runtimeToolsForProfile("normal", [
    "read",
    "EnterPlanMode",
    "plan_write",
    "ExitPlanMode",
  ]),
  ["read", "EnterPlanMode"],
);

const rows = __test.toolRows(
  {
    getAllTools: () => [
      { name: "read", sourceInfo: { source: "builtin" } },
      { name: "grep", sourceInfo: { source: "builtin" } },
      { name: "web_fetch", sourceInfo: { source: "extension" } },
      { name: "shell_command", sourceInfo: { source: "extension" } },
      { name: "ExitPlanMode", sourceInfo: { source: "extension" } },
      { name: "plan_write", sourceInfo: { source: "extension" } },
    ],
  },
  {
    version: 4,
    profiles: {
      normal: ["read", "ExitPlanMode"],
      ask: ["web_fetch", "ExitPlanMode"],
      plan: ["grep", "ExitPlanMode"],
    },
  },
);
assert.equal(rows.some((tool) => tool.name === "ExitPlanMode"), false);
assert.equal(rows.some((tool) => tool.name === "plan_write"), true);
assert.equal(rows.some((tool) => tool.name === "EnterPlanMode"), true);
assert.equal(rows.some((tool) => tool.name === "web_fetch"), true);

const theme = {
  fg(_color, text) {
    return String(text);
  },
  bold(text) {
    return String(text);
  },
};
const ansiTheme = {
  fg(color, text) {
    const code = color === "accent" ? 36 : color === "muted" ? 90 : 37;
    return `\u001b[${code}m${text}\u001b[39m`;
  },
  bold(text) {
    return `\u001b[1m${text}\u001b[22m`;
  },
};
const stripAnsi = (value) =>
  String(value).replace(/\u001b\[[0-9;]*m/g, "");
const tools = [
  { name: "read", registered: true, builtin: true },
  { name: "grep", registered: true, builtin: true },
  { name: "web_fetch", registered: true, builtin: false },
  { name: "shell_command", registered: true, builtin: false },
  { name: "plan_write", registered: true, builtin: false },
];
const config = {
  version: 4,
  profiles: {
    normal: ["read", "shell_command"],
    ask: ["web_fetch"],
    plan: ["grep"],
  },
};
const defaults = structuredClone(config.profiles);
const phaseProfiles = {
  normal: {
    provider: "normal",
    model: "normal-model",
    thinkingLevel: "high",
  },
  planning: {
    provider: "planner",
    model: "planner-model",
    thinkingLevel: "xhigh",
  },
};
const doneResults = [];
const copyText = {
  title: "Only Tools",
  model: "Model",
  effort: "Effort",
  modelCurrent: "Pi current",
  effortCurrent: "Pi current",
  inheritNormal: "inherit Normal",
  lockedRequired: "required",
  lockedControl: "control",
  lockedAskWrite: "blocked in Ask",
  askPolicy: "Ask allowlist",
  unregistered: "unregistered",
  help: "help",
};
const component = new __test.ProfileMatrixComponent({
  tui: { requestRender() {} },
  theme,
  done: (result) => doneResults.push(result),
  config,
  defaults,
  tools,
  phaseProfiles,
  copyText,
});

const rendered = component.render(160);
const header = rendered.find(
  (line) =>
    line.includes("NORMAL") && line.includes("ASK") && line.includes("PLAN"),
);
assert.ok(header, "Normal, Ask, and Plan must be column headers on one line");
assert.ok(rendered.some((line) => line.trimStart().startsWith("› Model")));
assert.ok(
  rendered.some(
    (line) =>
      line.includes("normal/normal-model") &&
      line.includes("inherit Normal") &&
      line.includes("planner/planner-model"),
  ),
);
const readRow = rendered.find((line) => line.includes("read"));
assert.ok(readRow?.includes("●"));
assert.ok(readRow?.includes("○"));
assert.equal(readRow?.includes("["), false);
const shellRow = rendered.find((line) => line.includes("shell_command"));
assert.ok(shellRow?.includes("◇"), "Ask must lock shell_command off");
assert.equal(rendered.some((line) => line.includes("ExitPlanMode")), false);

const ansiComponent = new __test.ProfileMatrixComponent({
  tui: { requestRender() {} },
  theme: ansiTheme,
  done: () => {},
  config: structuredClone(config),
  defaults,
  tools,
  phaseProfiles,
  copyText,
  initialRow: 2,
  initialCol: 0,
});
const ansiRendered = ansiComponent.render(160).map(stripAnsi);
const ansiModelRow = ansiRendered.find(
  (line) =>
    line.includes("normal/normal-model") && line.includes("planner/planner-model"),
);
const ansiReadRow = ansiRendered.find((line) => line.includes("read"));
assert.ok(ansiModelRow && ansiReadRow);
const askColumn = ansiModelRow.indexOf("inherit Normal");
const planColumn = ansiModelRow.indexOf("planner/planner-model");
assert.equal(ansiReadRow.indexOf("○", ansiReadRow.indexOf("●") + 1), askColumn);
assert.ok(ansiReadRow.lastIndexOf("○") >= planColumn);

const ansiRaw = ansiComponent.render(160);
assert.ok(
  ansiRaw.some(
    (line) => line.includes("\u001b[36m") && stripAnsi(line).includes("NORMAL"),
  ),
);
assert.ok(
  ansiRaw.some(
    (line) => line.includes("\u001b[36m") && stripAnsi(line).includes("read"),
  ),
);

component.handleInput("\u001b[C");
assert.equal(component.currentProfile(), "ask");
component.handleInput("\r");
assert.equal(doneResults.length, 0, "Ask model is inherited and not independently editable");
component.handleInput("\u001b[B");
component.handleInput("\u001b[B");
component.handleInput("\u001b[B");
component.handleInput("\u001b[B");
assert.equal(component.currentTool().name, "web_fetch");
component.handleInput("\r");
assert.equal(config.profiles.ask.includes("web_fetch"), false);
component.handleInput("\u001b[C");
assert.equal(component.currentProfile(), "plan");

const modelComponent = new __test.ProfileMatrixComponent({
  tui: { requestRender() {} },
  theme,
  done: (result) => doneResults.push(result),
  config,
  defaults,
  tools,
  phaseProfiles,
  copyText,
  initialCol: 2,
});
modelComponent.handleInput("\r");
assert.deepEqual(doneResults.at(-1), {
  action: "model",
  profile: "plan",
  dirty: false,
  row: 0,
  col: 2,
});

console.log("profile matrix Normal/Ask/Plan rules tests passed");

import assert from "node:assert/strict";
import { PROFILE_CONFIG_VERSION, PROFILE_NAMES } from "../src/profile-config.js";
import {
  runtimeToolsForProfile,
  __test,
} from "../src/profile-matrix-ui.js";

assert.equal(PROFILE_CONFIG_VERSION, 3);
assert.deepEqual(PROFILE_NAMES, ["normal", "plan"]);

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
assert.deepEqual(__test.lockedCell("plan", "ExitPlanMode"), {
  locked: true,
  value: false,
  reason: "control",
});
assert.deepEqual(
  runtimeToolsForProfile("plan", ["read", "EnterPlanMode", "ExitPlanMode"]),
  ["read", "plan_write"],
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
      { name: "ExitPlanMode", sourceInfo: { source: "extension" } },
      { name: "plan_write", sourceInfo: { source: "extension" } },
    ],
  },
  {
    version: 3,
    profiles: {
      normal: ["read", "ExitPlanMode"],
      plan: ["grep", "ExitPlanMode"],
    },
  },
);
assert.equal(rows.some((tool) => tool.name === "ExitPlanMode"), false);
assert.equal(rows.some((tool) => tool.name === "plan_write"), true);
assert.equal(rows.some((tool) => tool.name === "EnterPlanMode"), true);

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
  { name: "plan_write", registered: true, builtin: false },
];
const config = {
  version: 3,
  profiles: {
    normal: ["read"],
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
  subtitle: "",
  model: "Model",
  effort: "Effort",
  modelCurrent: "Pi current",
  effortCurrent: "Pi current",
  selected: "Selected",
  lockedRequired: "required",
  lockedControl: "control",
  unregistered: "unregistered",
  editModel: "Enter: choose model",
  editEffort: "Enter: choose effort",
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

const rendered = component.render(120);
const header = rendered.find(
  (line) => line.includes("NORMAL") && line.includes("PLAN"),
);
assert.ok(header, "Normal and Plan must be column headers on the same line");
assert.ok(rendered.some((line) => line.trimStart().startsWith("› Model")));
assert.ok(
  rendered.some(
    (line) =>
      line.includes("Effort") && line.includes("high") && line.includes("xhigh"),
  ),
);
const readRow = rendered.find((line) => line.includes("read"));
assert.ok(readRow?.includes("●"));
assert.ok(readRow?.includes("○"));
assert.equal(readRow?.includes("["), false);
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
const ansiRendered = ansiComponent.render(120).map(stripAnsi);
const ansiModelRow = ansiRendered.find(
  (line) =>
    line.includes("normal/normal-model") && line.includes("planner/planner-model"),
);
const ansiReadRow = ansiRendered.find((line) => line.includes("read"));
assert.ok(ansiModelRow && ansiReadRow);
const planColumn = ansiModelRow.indexOf("planner/planner-model");
assert.equal(ansiReadRow.lastIndexOf("○"), planColumn);

const ansiRaw = ansiComponent.render(120);
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
component.handleInput("\u001b[B");
component.handleInput("\u001b[B");
assert.equal(component.currentProfile(), "plan");
assert.equal(component.currentTool().name, "read");
component.handleInput("\r");
assert.ok(config.profiles.plan.includes("read"));

const modelComponent = new __test.ProfileMatrixComponent({
  tui: { requestRender() {} },
  theme,
  done: (result) => doneResults.push(result),
  config,
  defaults,
  tools,
  phaseProfiles,
  copyText,
  initialCol: 1,
});
modelComponent.handleInput("\r");
assert.deepEqual(doneResults.at(-1), {
  action: "model",
  profile: "plan",
  dirty: false,
  row: 0,
  col: 1,
});

console.log("profile matrix user-controlled Plan rules tests passed");

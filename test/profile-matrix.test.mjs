import assert from "node:assert/strict";
import { PROFILE_NAMES } from "../src/profile-config.js";
import { runtimeToolsForProfile, __test } from "../src/profile-matrix-ui.js";

assert.deepEqual(PROFILE_NAMES, ["normal", "plan"]);

assert.deepEqual(__test.lockedCell("plan", "plan_write"), { locked: true, value: true, reason: "required" });
assert.deepEqual(__test.lockedCell("normal", "plan_write"), { locked: true, value: false, reason: "control" });
assert.deepEqual(runtimeToolsForProfile("plan", ["read", "EnterPlanMode"]), ["read", "plan_write", "ExitPlanMode"]);
assert.deepEqual(runtimeToolsForProfile("normal", ["read", "EnterPlanMode", "plan_write"]), ["read", "EnterPlanMode"]);

const theme = {
  fg(_color, text) { return String(text); },
  bold(text) { return String(text); },
};
const ansiTheme = {
  fg(color, text) {
    const code = color === "accent" ? 36 : color === "muted" ? 90 : 37;
    return `\u001b[${code}m${text}\u001b[39m`;
  },
  bold(text) { return `\u001b[1m${text}\u001b[22m`; },
};
const stripAnsi = (value) => String(value).replace(/\u001b\[[0-9;]*m/g, "");
const tools = [
  { name: "read", registered: true, builtin: true },
  { name: "grep", registered: true, builtin: true },
  { name: "plan_write", registered: true, builtin: false },
  { name: "ExitPlanMode", registered: true, builtin: false },
];
const config = {
  version: 2,
  profiles: {
    normal: ["read"],
    plan: ["grep"],
  },
};
const defaults = structuredClone(config.profiles);
const phaseProfiles = {
  normal: { provider: "normal", model: "normal-model", thinkingLevel: "high" },
  planning: { provider: "planner", model: "planner-model", thinkingLevel: "xhigh" },
};
const doneResults = [];
const component = new __test.ProfileMatrixComponent({
  tui: { requestRender() {} },
  theme,
  done: (result) => doneResults.push(result),
  config,
  defaults,
  tools,
  phaseProfiles,
  copyText: {
    title: "Only Tools",
    subtitle: "Normal / Plan are columns; Model, Effort, and tools are rows.",
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
  },
});

const rendered = component.render(120);
const header = rendered.find((line) => line.includes("NORMAL") && line.includes("PLAN"));
assert.ok(header, "Normal and Plan must be column headers on the same line");
assert.ok(rendered.some((line) => line.trimStart().startsWith("› Model")));
assert.ok(rendered.some((line) => line.includes("Effort") && line.includes("high") && line.includes("xhigh")));
const readRow = rendered.find((line) => line.includes("read"));
assert.ok(readRow?.includes("●"));
assert.ok(readRow?.includes("○"));
assert.equal(readRow?.includes("["), false, "tool toggles should not use small bracket markers");

// ANSI styling must never change visible column positions. Reproduce the
// reported bug by selecting Normal/read while Plan remains unselected.
const ansiComponent = new __test.ProfileMatrixComponent({
  tui: { requestRender() {} },
  theme: ansiTheme,
  done: () => {},
  config: structuredClone(config),
  defaults,
  tools,
  phaseProfiles,
  copyText: {
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
    editModel: "edit model",
    editEffort: "edit effort",
    help: "help",
  },
  initialRow: 2,
  initialCol: 0,
});
const ansiRendered = ansiComponent.render(120).map(stripAnsi);
const ansiModelRow = ansiRendered.find((line) => line.includes("normal/normal-model") && line.includes("planner/planner-model"));
const ansiReadRow = ansiRendered.find((line) => line.includes("read"));
assert.ok(ansiModelRow && ansiReadRow);
const planColumn = ansiModelRow.indexOf("planner/planner-model");
assert.equal(ansiReadRow.lastIndexOf("○"), planColumn, "Plan tool glyph must stay aligned when the Normal cell is ANSI-styled");

// Selected header/row/cell should receive accent styling.
const ansiRaw = ansiComponent.render(120);
assert.ok(ansiRaw.some((line) => line.includes("\u001b[36m") && stripAnsi(line).includes("NORMAL")));
assert.ok(ansiRaw.some((line) => line.includes("\u001b[36m") && stripAnsi(line).includes("read")));

// Left/right selects the profile column; up/down selects Model/Effort/tool rows.
component.handleInput("\u001b[C"); // Plan
component.handleInput("\u001b[B"); // Effort
component.handleInput("\u001b[B"); // read
assert.equal(component.currentProfile(), "plan");
assert.equal(component.currentTool().name, "read");
component.handleInput("\r");
assert.ok(config.profiles.plan.includes("read"), "Enter on a tool row must toggle the selected profile/tool cell");

const modelComponent = new __test.ProfileMatrixComponent({
  tui: { requestRender() {} },
  theme,
  done: (result) => doneResults.push(result),
  config,
  defaults,
  tools,
  phaseProfiles,
  copyText: {
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
    editModel: "edit model",
    editEffort: "edit effort",
    help: "help",
  },
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

console.log("profile matrix rules tests passed");

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
    title: "Tool profile matrix",
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
const header = rendered.find((line) => line.includes("Normal") && line.includes("Plan"));
assert.ok(header, "Normal and Plan must be column headers on the same line");
assert.ok(rendered.some((line) => line.trimStart().startsWith("> Model")));
assert.ok(rendered.some((line) => line.includes("Effort") && line.includes("high") && line.includes("xhigh")));
const readRow = rendered.find((line) => line.includes("read"));
assert.ok(readRow?.includes("[✓]"));
assert.ok(readRow?.includes("[×]"));

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
    title: "Tool profile matrix",
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

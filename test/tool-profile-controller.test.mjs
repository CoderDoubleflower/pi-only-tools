import assert from "node:assert/strict";
import { createToolProfileController } from "../src/tool-profile-controller.js";

const registered = new Set(["shell_command", "apply_patch", "read", "grep", "plan_write", "ExitPlanMode"]);
let active = ["shell_command", "apply_patch"];
const pi = {
  getAllTools: () => [...registered].map((name) => ({ name })),
  getActiveTools: () => [...active],
  setActiveTools: (names) => { active = [...names]; },
};

const profiles = createToolProfileController(pi, { protectedTools: ["plan_write", "ExitPlanMode"] });
profiles.setProfile("normal", ["shell_command", "apply_patch"]);
profiles.activate("plan", ["read", "grep", "plan_write", "ExitPlanMode"]);
assert.deepEqual(active, ["read", "grep", "plan_write", "ExitPlanMode"]);

profiles.setProfile("normal", ["shell_command"]);
assert.deepEqual(active, ["read", "grep", "plan_write", "ExitPlanMode"], "editing normal tools must not override Plan Mode");

profiles.setPermanentDisabled(["grep", "plan_write"]);
assert.deepEqual(active, ["read", "plan_write", "ExitPlanMode"], "permanent policy filters Plan tools but cannot remove required workflow tools");
assert.deepEqual(profiles.getUnavailableTools(["grep", "missing", "plan_write"]), [
  { name: "grep", reason: "permanently disabled" },
  { name: "missing", reason: "not registered" },
]);

profiles.activate("execution", ["shell_command", "apply_patch"]);
assert.deepEqual(active, ["shell_command", "apply_patch"]);
profiles.activate("normal");
assert.deepEqual(active, ["shell_command"]);
assert.equal(profiles.snapshot().mode, "normal");
console.log("tool profile controller tests passed");

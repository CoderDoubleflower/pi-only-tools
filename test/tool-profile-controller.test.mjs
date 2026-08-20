import assert from "node:assert/strict";
import { createToolProfileController } from "../src/tool-profile-controller.js";

const registered = new Set(["shell_command", "apply_patch", "read", "grep", "plan_write", "ExitPlanMode"]);
let active = ["shell_command", "apply_patch"];
const pi = {
  getAllTools: () => [...registered].map((name) => ({ name })),
  getActiveTools: () => [...active],
  setActiveTools: (names) => { active = [...names]; },
};

const profiles = createToolProfileController(pi);
profiles.setProfile("normal", ["shell_command", "apply_patch"]);
profiles.activate("plan", ["read", "grep", "plan_write", "ExitPlanMode"]);
assert.deepEqual(active, ["read", "grep", "plan_write", "ExitPlanMode"]);

profiles.setProfile("normal", ["shell_command"]);
assert.deepEqual(active, ["read", "grep", "plan_write", "ExitPlanMode"], "editing normal tools must not override Plan Mode");

profiles.setProfile("plan", ["read", "plan_write", "ExitPlanMode"]);
assert.deepEqual(active, ["read", "plan_write", "ExitPlanMode"], "editing the active profile applies immediately");
assert.deepEqual(profiles.getUnavailableTools(["grep", "missing", "plan_write"]), [
  { name: "missing", reason: "not registered" },
]);

profiles.activate("normal");
assert.deepEqual(active, ["shell_command"]);
const snapshot = profiles.snapshot();
assert.equal(snapshot.mode, "normal");
assert.deepEqual(Object.keys(snapshot.requested), ["normal", "plan"]);
console.log("tool profile controller tests passed");

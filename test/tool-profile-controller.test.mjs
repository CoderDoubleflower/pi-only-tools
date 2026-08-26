import assert from "node:assert/strict";
import { createToolProfileController } from "../src/tool-profile-controller.js";

const registered = new Set(["shell_command", "apply_patch", "read", "grep", "plan_write"]);
let active = ["shell_command", "apply_patch"];
const pi = {
  getAllTools: () => [...registered].map((name) => ({ name })),
  getActiveTools: () => [...active],
  setActiveTools: (names) => { active = [...names]; },
};

const profiles = createToolProfileController(pi);
profiles.setProfile("normal", ["shell_command", "apply_patch"]);
profiles.setProfile("ask", ["read", "grep"]);
profiles.activate("plan", ["read", "grep", "plan_write"]);
assert.deepEqual(active, ["read", "grep", "plan_write"]);

profiles.setProfile("normal", ["shell_command"]);
assert.deepEqual(active, ["read", "grep", "plan_write"], "editing normal tools must not override Plan Mode");

profiles.setProfile("plan", ["read", "plan_write"]);
assert.deepEqual(active, ["read", "plan_write"], "editing the active profile applies immediately");
assert.deepEqual(profiles.getUnavailableTools(["grep", "missing", "plan_write"]), [
  { name: "missing", reason: "not registered" },
]);

profiles.activate("ask");
assert.deepEqual(active, ["read", "grep"]);
profiles.setProfile("plan", ["grep", "plan_write"]);
assert.deepEqual(active, ["read", "grep"], "editing Plan tools must not override Ask Mode");

profiles.activate("normal");
assert.deepEqual(active, ["shell_command"]);
const snapshot = profiles.snapshot();
assert.equal(snapshot.mode, "normal");
assert.deepEqual(Object.keys(snapshot.requested), ["normal", "ask", "plan"]);
console.log("tool profile controller tests passed");

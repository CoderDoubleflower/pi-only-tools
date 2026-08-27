import assert from "node:assert/strict";
import { createToolProfileController } from "../src/tool-profile-controller.js";

const registered = new Set(["shell_command", "apply_patch", "read", "grep", "plan_write"]);
let active = ["shell_command", "apply_patch"];
let setCalls = 0;
const pi = {
  getAllTools: () => [...registered].map((name) => ({ name })),
  getActiveTools: () => [...active],
  setActiveTools: (names) => {
    setCalls += 1;
    active = [...names];
  },
};

const profiles = createToolProfileController(pi, { requiredTools: ["plan_write"] });
profiles.setProfile("normal", ["shell_command", "apply_patch"], { apply: false });
profiles.setProfile("ask", ["read", "grep"], { apply: false });
profiles.setProfile("plan", ["read", "grep", "plan_write"], { apply: false });
profiles.activate("normal");

assert.deepEqual(
  active,
  ["shell_command", "apply_patch", "read", "grep", "plan_write"],
  "the provider-visible catalog must be the stable profile union in registry order",
);
assert.equal(setCalls, 1);

profiles.activate("plan");
assert.deepEqual(active, ["shell_command", "apply_patch", "read", "grep", "plan_write"]);
assert.equal(setCalls, 1, "mode switches must not rewrite the active tool catalog");
assert.deepEqual(profiles.getEffectiveTools(), ["read", "grep", "plan_write"]);

profiles.setProfile("normal", ["shell_command"]);
assert.deepEqual(active, ["shell_command", "apply_patch", "read", "grep", "plan_write"]);
assert.equal(setCalls, 1, "editing an inactive profile must not rewrite the catalog");

profiles.setProfile("plan", ["read", "plan_write"]);
assert.deepEqual(active, ["shell_command", "apply_patch", "read", "grep", "plan_write"]);
assert.equal(setCalls, 1, "removing an allowed tool must not remove it from the stable catalog");
assert.deepEqual(profiles.getEffectiveTools("plan"), ["read", "plan_write"]);
assert.deepEqual(profiles.getUnavailableTools(["grep", "missing", "plan_write"]), [
  { name: "missing", reason: "not registered" },
]);

profiles.activate("ask");
assert.deepEqual(active, ["shell_command", "apply_patch", "read", "grep", "plan_write"]);
assert.deepEqual(profiles.getEffectiveTools(), ["read", "grep"]);
profiles.setProfile("plan", ["grep", "plan_write"]);
assert.deepEqual(profiles.getEffectiveTools(), ["read", "grep"]);

registered.add("web_fetch");
profiles.setProfile("ask", ["read", "grep", "web_fetch"]);
assert.deepEqual(
  active,
  ["shell_command", "apply_patch", "read", "grep", "plan_write", "web_fetch"],
  "newly selected tools append without reordering the established catalog prefix",
);
assert.equal(setCalls, 2);

profiles.activate("normal");
assert.deepEqual(active, ["shell_command", "apply_patch", "read", "grep", "plan_write", "web_fetch"]);
assert.deepEqual(profiles.getEffectiveTools(), ["shell_command"]);
const snapshot = profiles.snapshot();
assert.equal(snapshot.mode, "normal");
assert.deepEqual(Object.keys(snapshot.requested), ["normal", "ask", "plan"]);
assert.deepEqual(snapshot.allowedTools, ["shell_command"]);
assert.deepEqual(snapshot.catalogTools, active);
assert.deepEqual(snapshot.activeTools, active);
console.log("cache-stable tool profile controller tests passed");

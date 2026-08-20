import assert from "node:assert/strict";
import { PROFILE_NAMES } from "../src/profile-config.js";
import { runtimeToolsForProfile, __test } from "../src/profile-matrix-ui.js";

assert.deepEqual(PROFILE_NAMES, ["normal", "plan"]);

assert.deepEqual(__test.lockedCell("plan", "plan_write"), { locked: true, value: true, reason: "required" });
assert.deepEqual(__test.lockedCell("normal", "plan_write"), { locked: true, value: false, reason: "control" });
assert.deepEqual(runtimeToolsForProfile("plan", ["read", "EnterPlanMode"]), ["read", "plan_write", "ExitPlanMode"]);
assert.deepEqual(runtimeToolsForProfile("normal", ["read", "EnterPlanMode", "plan_write"]), ["read", "EnterPlanMode"]);
console.log("profile matrix rules tests passed");

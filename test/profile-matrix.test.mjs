import assert from "node:assert/strict";
import { runtimeToolsForProfile, __test } from "../src/profile-matrix-ui.js";

assert.deepEqual(__test.lockedCell("plan", "plan_write"), { locked: true, value: true, reason: "required" });
assert.deepEqual(__test.lockedCell("normal", "plan_write"), { locked: true, value: false, reason: "control" });
assert.deepEqual(runtimeToolsForProfile("plan", ["read", "EnterPlanMode"]), ["read", "plan_write", "ExitPlanMode"]);
assert.deepEqual(runtimeToolsForProfile("normal", ["read", "EnterPlanMode", "plan_write"]), ["read", "EnterPlanMode"]);
console.log("profile matrix rules tests passed");

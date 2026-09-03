import assert from "node:assert/strict";
import {
  ToolProfileController,
  createToolProfileController,
} from "../src/tool-profile-controller.js";

function createPi(names, active = names) {
  const tools = names.map((name) => ({ name }));
  let activeTools = [...active];
  const writes = [];
  return {
    tools,
    writes,
    pi: {
      getAllTools: () => tools,
      getActiveTools: () => [...activeTools],
      setActiveTools(next) {
        activeTools = next.filter((name) => tools.some((tool) => tool.name === name));
        writes.push([...activeTools]);
      },
    },
    activeTools: () => [...activeTools],
  };
}

const runtime = createPi(
  ["read", "bash", "edit", "write", "plan_write", "third_party"],
  ["read", "bash", "edit", "write"],
);
const profiles = createToolProfileController(runtime.pi, {
  initialTools: ["read", "bash", "edit", "write"],
  requiredTools: ["plan_write"],
});
assert.ok(profiles instanceof ToolProfileController);
profiles.setProfile("ask", ["read", "bash"], { apply: false });
profiles.setProfile("plan", ["read", "bash", "plan_write"], { apply: false });

assert.deepEqual(profiles.getDesiredCatalogTools(), [
  "read",
  "bash",
  "edit",
  "write",
  "plan_write",
]);
assert.deepEqual(profiles.apply(), ["read", "bash", "edit", "write"]);
assert.deepEqual(
  profiles.getCatalogTools(),
  ["read", "bash", "edit", "write", "plan_write", "third_party"],
  "the first runtime apply must freeze every currently registered tool",
);
assert.deepEqual(runtime.activeTools(), profiles.getCatalogTools());
assert.deepEqual(runtime.writes, [profiles.getCatalogTools()]);

profiles.activate("ask");
assert.deepEqual(profiles.getEffectiveTools(), ["read", "bash"]);
assert.deepEqual(
  runtime.activeTools(),
  ["read", "bash", "edit", "write", "plan_write", "third_party"],
  "mode changes must not remove provider-visible tool definitions",
);
assert.equal(runtime.writes.length, 1, "an unchanged catalog must not be rewritten");
assert.equal(profiles.isAllowed("read"), true);
assert.equal(profiles.isAllowed("edit"), false);

profiles.activate("plan");
assert.deepEqual(profiles.getEffectiveTools(), ["read", "bash", "plan_write"]);
assert.deepEqual(runtime.activeTools(), profiles.getCatalogTools());
assert.equal(runtime.writes.length, 1);

runtime.tools.push({ name: "late_tool" });
profiles.setProfile("plan", ["read", "late_tool", "plan_write"]);
assert.deepEqual(
  profiles.getEffectiveTools("plan"),
  ["read", "plan_write"],
  "a tool registered after the session boundary must not silently change the catalog epoch",
);
assert.deepEqual(profiles.getCatalogTools(), [
  "read",
  "bash",
  "edit",
  "write",
  "plan_write",
  "third_party",
]);
assert.match(
  profiles.getUnavailableTools(["late_tool"])[0].reason,
  /frozen session catalog/u,
);
profiles.apply();
assert.equal(runtime.writes.length, 1);

profiles.resetCatalog();
assert.deepEqual(profiles.apply(), ["read", "late_tool", "plan_write"]);
assert.deepEqual(profiles.getCatalogTools(), [
  "read",
  "bash",
  "edit",
  "write",
  "plan_write",
  "third_party",
  "late_tool",
]);
assert.deepEqual(runtime.activeTools(), profiles.getCatalogTools());
assert.equal(runtime.writes.length, 2);
assert.deepEqual(profiles.getUnavailableTools(["late_tool"]), []);

profiles.setProfile("normal", ["read", "missing"], { apply: false });
assert.deepEqual(profiles.getEffectiveTools("normal"), ["read"]);
assert.deepEqual(profiles.getUnavailableTools(["missing"]), [
  { name: "missing", reason: "not registered" },
]);
assert.throws(() => profiles.activate("unknown"), /Unknown tool profile/u);

const dedupeRuntime = createPi(["read", "bash"]);
const dedupe = createToolProfileController(dedupeRuntime.pi, {
  initialTools: ["read", "read", "bash"],
});
assert.deepEqual(dedupe.getRequestedTools("normal"), ["read", "bash"]);
dedupe.apply();
dedupe.apply();
assert.equal(dedupeRuntime.writes.length, 0, "an already matching frozen catalog needs no setter call");

console.log("tool profile controller tests passed");

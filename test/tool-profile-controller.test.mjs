import assert from "node:assert/strict";
import {
  ToolProfileController,
  createToolProfileController,
} from "../src/tool-profile-controller.js";

function createPi(definitions, active = []) {
  const tools = definitions.map((tool) => typeof tool === "string" ? { name: tool } : tool);
  let activeTools = [...active];
  const writes = [];
  return {
    tools,
    writes,
    pi: {
      getAllTools: () => tools,
      getActiveTools: () => [...activeTools],
      setActiveTools(next) {
        activeTools = next.filter((name) => tools.some((tool) =>
          tool.name === name && tool.exposure !== "hidden"));
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
assert.deepEqual(profiles.getDesiredCatalogTools(), ["read", "bash", "edit", "write"]);
assert.deepEqual(profiles.apply(), ["read", "bash", "edit", "write"]);
assert.deepEqual(runtime.activeTools(), ["read", "bash", "edit", "write"]);
assert.equal(runtime.writes.length, 0, "registration alone must not activate unrelated tools");

profiles.activate("ask");
assert.deepEqual(runtime.activeTools(), ["read", "bash"]);
assert.equal(profiles.isAllowed("read"), true);
assert.equal(profiles.isAllowed("edit"), false);
profiles.activate("plan");
assert.deepEqual(runtime.activeTools(), ["read", "bash", "plan_write"]);
assert.deepEqual(profiles.getCatalogTools(), runtime.activeTools());

// A persisted permission may precede native MCP's asynchronous registration.
profiles.setProfile("plan", ["read", "late_tool", "plan_write"]);
assert.deepEqual(profiles.getUnavailableTools(["late_tool"]), [
  { name: "late_tool", reason: "not registered" },
]);
runtime.tools.push({ name: "late_tool" });
assert.equal(profiles.isAllowed("late_tool"), true, "authorization must consult the live registry");
assert.deepEqual(profiles.getEffectiveTools("plan"), ["read", "late_tool", "plan_write"]);
assert.deepEqual(profiles.getUnavailableTools(["late_tool"]), []);
profiles.apply();
assert.deepEqual(runtime.activeTools(), ["read", "plan_write", "late_tool"]);
const writesAfterLateRegistration = runtime.writes.length;
profiles.setProfile("plan", ["plan_write", "late_tool", "read"]);
profiles.apply();
assert.equal(runtime.writes.length, writesAfterLateRegistration, "retained tools keep their order");
assert.equal(profiles.isAllowed("third_party"), false);
assert.throws(() => profiles.activate("unknown"), /Unknown tool profile/u);

const modern = createPi([
  { name: "read", exposure: "direct" },
  { name: "codemode", exposure: "model-only", defaultActive: false },
  { name: "tool_search", exposure: "model-only", defaultActive: false },
  { name: "opt_in", exposure: "direct", defaultActive: false },
  { name: "script_only", exposure: "codemode" },
  { name: "searchable", exposure: "deferred" },
  { name: "withdrawn", exposure: "hidden" },
], ["read"]);
const permissions = createToolProfileController(modern.pi, {
  initialTools: ["read", "script_only", "searchable", "withdrawn", "mcp__late__read"],
});
permissions.apply();
assert.deepEqual(modern.activeTools(), ["read"], "inactive discovery tools must remain inactive");
assert.deepEqual(permissions.getEffectiveTools(), ["read", "script_only", "searchable"]);
assert.equal(permissions.isAllowed("withdrawn"), false);
assert.deepEqual(permissions.getUnavailableTools(["withdrawn"]), [
  { name: "withdrawn", reason: "hidden by its provider" },
]);

modern.tools.push({ name: "mcp__late__read", exposure: "deferred" });
assert.equal(permissions.isAllowed("mcp__late__read"), true);
permissions.apply();
assert.deepEqual(modern.activeTools(), ["read"], "late deferred tools stay available through discovery");

// An explicit profile selection enables a direct/model-only tool even if its
// registration default was inactive. Deferred tools wait for host discovery.
permissions.setProfile("normal", [...permissions.getRequestedTools(), "codemode", "tool_search", "opt_in"]);
assert.deepEqual(modern.activeTools(), ["read", "codemode", "tool_search", "opt_in"]);
modern.pi.setActiveTools([...modern.activeTools(), "mcp__late__read", "searchable"]);
permissions.apply();
assert.deepEqual(modern.activeTools(), ["read", "codemode", "tool_search", "opt_in", "mcp__late__read", "searchable"]);

permissions.setProfile("ask", ["read", "mcp__late__read"], { apply: false });
permissions.activate("ask");
assert.deepEqual(modern.activeTools(), ["read", "mcp__late__read"]);
assert.equal(permissions.isAllowed("searchable"), false);
// A loader cannot promote a tool outside the active profile's permissions.
modern.pi.setActiveTools([...modern.activeTools(), "searchable", "codemode"]);
permissions.apply();
assert.deepEqual(modern.activeTools(), ["read", "mcp__late__read"]);

modern.tools.find((tool) => tool.name === "mcp__late__read").exposure = "hidden";
assert.equal(permissions.isAllowed("mcp__late__read"), false, "withdrawal applies immediately");
permissions.apply();
assert.deepEqual(modern.activeTools(), ["read"]);
assert.deepEqual(permissions.snapshot().effective.ask, ["read"]);

permissions.setConfigurationBlocked(true);
assert.deepEqual(modern.activeTools(), []);
assert.deepEqual(permissions.getEffectiveTools("normal"), []);
permissions.activate("plan", ["read", "opt_in"]);
assert.deepEqual(modern.activeTools(), [], "mode changes cannot re-enable tools after invalid configuration");
assert.equal(permissions.snapshot().configurationBlocked, true);
permissions.setConfigurationBlocked(false);
assert.deepEqual(modern.activeTools(), ["read", "opt_in"]);
assert.equal(permissions.snapshot().configurationBlocked, false);

const dedupeRuntime = createPi(["read", "bash"], ["read", "bash"]);
const dedupe = createToolProfileController(dedupeRuntime.pi, {
  initialTools: ["read", "read", "bash"],
});
assert.deepEqual(dedupe.getRequestedTools("normal"), ["read", "bash"]);
dedupe.apply();
dedupe.apply();
assert.equal(dedupeRuntime.writes.length, 0, "an unchanged loadout needs no setter call");

console.log("tool profile controller tests passed");

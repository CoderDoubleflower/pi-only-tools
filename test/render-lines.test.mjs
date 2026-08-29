import assert from "node:assert/strict";

import plugin from "../src/entry.js";

const tools = new Map();
plugin({
  registerTool(tool) {
    tools.set(tool.name, tool);
  },
  registerCommand() {},
  on() {},
});

for (const toolName of ["shell_command", "apply_patch"]) {
  const tool = tools.get(toolName);
  assert.ok(tool, `${toolName} should be registered`);
  assert.equal(Object.hasOwn(tool, "renderCall"), false);
  assert.equal(Object.hasOwn(tool, "renderResult"), false);
  assert.equal(Object.hasOwn(tool, "renderShell"), false);
}

console.log("core tool renderer delegation test passed");

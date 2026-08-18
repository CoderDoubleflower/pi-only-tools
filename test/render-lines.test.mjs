import assert from "node:assert/strict";

import plugin from "../src/index.js";

const tools = new Map();
plugin({
  registerTool(tool) {
    tools.set(tool.name, tool);
  },
  registerCommand() {},
  on() {},
});

const patchTool = tools.get("apply_patch");
assert.ok(patchTool, "apply_patch should be registered");

const theme = {
  fg(_color, text) {
    return String(text);
  },
  bold(text) {
    return String(text);
  },
};

const component = patchTool.renderResult(
  {
    details: {
      status: "completed",
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      spawnError: null,
      combined: "Success. Updated the following files:\r\nA .pi_tool_test_tmp\r\n",
      patchSummary: {
        additions: 1,
        removals: 0,
        files: [],
      },
    },
  },
  { expanded: false, isPartial: false },
  theme,
  {},
);

const lines = component.render(120);
assert.deepEqual(lines, [
  "  ⎿  Added 1 line",
  "     Success. Updated the following files:",
  "     A .pi_tool_test_tmp",
]);
assert.ok(lines.every((line) => !/[\r\n]/.test(line)), "a TUI render row must not contain CR/LF");

console.log("render line regression test passed");

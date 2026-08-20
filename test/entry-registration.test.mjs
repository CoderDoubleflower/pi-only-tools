import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import plugin from "../src/entry.js";
import { wrapPlanToolDefinition } from "../src/plan-tool-ui.js";

const planTheme = { fg: (_color, text) => text };
for (const toolName of ["EnterPlanMode", "plan_write", "ExitPlanMode"]) {
  const wrapped = wrapPlanToolDefinition({ name: toolName });
  assert.equal(wrapped.renderShell, "self", `${toolName} must opt out of Pi's padded default tool shell`);
}

const planWrite = wrapPlanToolDefinition({ name: "plan_write" });
const renderedPlan = planWrite
  .renderResult(
    {
      content: [
        {
          type: "text",
          text: "Canonical plan updated to revision 2.\nPath: /tmp/plan.md\nSHA-256: abc123",
        },
      ],
      details: {},
    },
    { expanded: false, isPartial: false },
    planTheme,
    {
      args: {
        content:
          "# Implementation Plan\n\n## Context\nKeep the Plan UI readable.\n\n## Implementation Steps\n1. Render the plan.\n\n## Verification\n- Run tests.\n",
      },
    },
  )
  .render(400)
  .join("\n");
assert.match(renderedPlan, /Canonical plan updated to revision 2/);
assert.match(renderedPlan, /# Implementation Plan/);
assert.match(renderedPlan, /## Verification/);

const tools = new Map();
plugin({
  registerTool(tool) {
    tools.set(tool.name, tool);
  },
  registerCommand() {},
  on() {},
});

assert.deepEqual([...tools.keys()], ["shell_command", "apply_patch"]);
const shell = tools.get("shell_command");
assert.match(shell.description, /1 MiB/);
assert.match(shell.description, /10,000 tokens/);

const temp = await mkdtemp(path.join(os.tmpdir(), "pi-only-tools-entry-"));
try {
  const result = await shell.execute(
    "entry-shell-test",
    { command: "printf 'ok\\n'", timeout_ms: 5_000 },
    undefined,
    undefined,
    { cwd: temp },
  );
  assert.match(result.content[0].text, /^Exit code: 0\nWall time: /);
  assert.match(result.content[0].text, /\nOutput:\nok\n?$/);
  assert.equal(Object.hasOwn(result.details, "combined"), false);
} finally {
  await rm(temp, { recursive: true, force: true });
}

// A complete ExtensionAPI exposes runtime action methods while loading, but Pi rejects
// calling them until the runtime is initialized. Registration must therefore be pure.
const loadingActions = [
  "getActiveTools",
  "setActiveTools",
  "getAllTools",
  "getFlag",
  "sendMessage",
  "sendUserMessage",
  "appendEntry",
  "setSessionName",
  "getSessionName",
  "setModel",
  "getThinkingLevel",
  "setThinkingLevel",
];
const loadOnlyTools = new Map();
const loadOnlyApi = {
  registerTool(tool) {
    loadOnlyTools.set(tool.name, tool);
  },
  registerCommand() {},
  registerFlag() {},
  on() {},
};
for (const name of loadingActions) {
  loadOnlyApi[name] = () => {
    throw new Error(`runtime action called during extension loading: ${name}`);
  };
}
assert.doesNotThrow(() => plugin(loadOnlyApi));
for (const toolName of ["EnterPlanMode", "plan_write", "ExitPlanMode"]) {
  assert.equal(loadOnlyTools.get(toolName).renderShell, "self", `${toolName} must be decorated through src/entry.js`);
}
assert.equal(typeof loadOnlyTools.get("plan_write").renderResult, "function");

console.log("runtime entry registration test passed");

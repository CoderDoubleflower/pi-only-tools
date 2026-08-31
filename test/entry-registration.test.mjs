import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import plugin from "../src/entry.js";
import { wrapPlanToolDefinition } from "../src/plan-tool-ui.js";

const stripAnsi = (value) => String(value).replace(/\u001b\[[0-9;]*m/g, "");
const planTheme = {
  fg: (_color, text) => String(text),
  bold: (text) => String(text),
};
for (const toolName of ["EnterPlanMode", "plan_write"]) {
  const wrapped = wrapPlanToolDefinition({ name: toolName });
  assert.equal(
    wrapped.renderShell,
    "self",
    `${toolName} must opt out of Pi's padded default tool shell`,
  );
}
assert.equal(
  wrapPlanToolDefinition({ name: "ExitPlanMode" }).renderShell,
  undefined,
  "ExitPlanMode is not a model-facing or rendered tool",
);

const planWrite = wrapPlanToolDefinition({ name: "plan_write" });
const renderedPlan = planWrite
  .renderResult(
    {
      content: [
        {
          type: "text",
          text: "Plan revision 2 is saved and awaiting user review.",
        },
      ],
      details: {
        plan: { revision: 2 },
        ready: { revision: 2 },
        readiness: { ready: true },
      },
    },
    { expanded: false, isPartial: false },
    planTheme,
    {
      args: {
        content:
          "# Readable Plan UI\n\n## Context\nKeep the Plan UI readable without repeating the approved revision.\n\n## Current State\n- `src/plan-tool-ui.js` owns visible Plan rendering.\n\n## Implementation Steps\n1. **Render the plan once**\n   - Files: `src/plan-tool-ui.js`\n   - Change: render the complete document with Pi Markdown.\n   - Reuse: the shared Claude tool shell and runtime Markdown theme.\n   - Flow: `plan_write` publishes the only visible copy.\n\n## Verification\n- Automated: `npm test`\n- TUI: confirm the plan is readable and appears once.\n",
      },
    },
  )
  .render(400)
  .join("\n");
const renderedPlanText = stripAnsi(renderedPlan);
assert.match(renderedPlanText, /Plan r2 saved/);
assert.match(renderedPlanText, /Readable Plan UI/);
assert.match(renderedPlanText, /Current State/);
assert.match(renderedPlanText, /src\/plan-tool-ui\.js/);
assert.equal(
  renderedPlan.includes("<toolOutput># Readable Plan UI"),
  false,
  "the complete Markdown document must not be wrapped in one toolOutput color",
);

const tools = new Map();
plugin({
  registerTool(tool) {
    tools.set(tool.name, tool);
  },
  registerCommand() {},
  on() {},
});

assert.deepEqual([...tools.keys()], ["web_search", "shell_command", "apply_patch"]);
const webSearch = tools.get("web_search");
const shell = tools.get("shell_command");
const patch = tools.get("apply_patch");
assert.equal(webSearch.renderShell, "self");
assert.equal(typeof webSearch.renderCall, "function");
assert.equal(typeof webSearch.renderResult, "function");
assert.match(shell.description, /1 MiB/);
assert.match(shell.description, /10,000 tokens/);
for (const [name, tool] of [["shell_command", shell], ["apply_patch", patch]]) {
  assert.equal(Object.hasOwn(tool, "renderCall"), false, `${name} must delegate call rendering`);
  assert.equal(Object.hasOwn(tool, "renderResult"), false, `${name} must delegate result rendering`);
  assert.equal(Object.hasOwn(tool, "renderShell"), false, `${name} must use the active TUI tool shell`);
}

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
assert.equal(loadOnlyTools.get("web_search").renderShell, "self");
assert.equal(typeof loadOnlyTools.get("web_search").renderCall, "function");
assert.equal(typeof loadOnlyTools.get("web_search").renderResult, "function");
for (const toolName of ["shell_command", "apply_patch"]) {
  const tool = loadOnlyTools.get(toolName);
  assert.equal(Object.hasOwn(tool, "renderCall"), false);
  assert.equal(Object.hasOwn(tool, "renderResult"), false);
  assert.equal(Object.hasOwn(tool, "renderShell"), false);
}
for (const toolName of ["EnterPlanMode", "plan_write"]) {
  assert.equal(
    loadOnlyTools.get(toolName).renderShell,
    "self",
    `${toolName} must be decorated through src/entry.js`,
  );
}
assert.equal(
  loadOnlyTools.has("ExitPlanMode"),
  false,
  "ExitPlanMode must not be registered for the model",
);
assert.equal(typeof loadOnlyTools.get("plan_write").renderResult, "function");

console.log("runtime entry registration test passed");

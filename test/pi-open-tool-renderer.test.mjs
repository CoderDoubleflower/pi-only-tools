import assert from "node:assert/strict";
import {
  EDIT_DIFF_ADDED_BACKGROUND,
  EDIT_DIFF_REMOVED_BACKGROUND,
  ClaudeToolBlinkController,
  createClaudeToolRenderExtensionApi,
  stripAnsi,
} from "../src/pi-open-tool-renderer.js";

const tools = new Map();
const handlers = new Map();
const api = createClaudeToolRenderExtensionApi({
  registerTool(tool) {
    tools.set(tool.name, tool);
  },
  on(event, handler) {
    const current = handlers.get(event) ?? [];
    current.push(handler);
    handlers.set(event, current);
  },
});
api.registerTool({ name: "shell_command" });
api.registerTool({ name: "apply_patch" });

const plainTheme = {
  fg: (_name, text) => String(text),
  bold: (text) => String(text),
};
const colorTheme = {
  bold: (text) => String(text),
  fg: (name, text) => {
    const code = name === "text" ? 255 : name === "success" ? 2 : name === "error" ? 1 : 8;
    return `\x1b[38;5;${code}m${text}\x1b[39m`;
  },
};
const plain = (lines) => lines.map((line) => stripAnsi(line).trimEnd());

const shell = tools.get("shell_command");
assert.equal(shell.renderShell, "self");
let call = shell.renderCall(
  { command: "echo one" },
  plainTheme,
  { cwd: "/repo", executionStarted: false, isPartial: true },
);
assert.deepEqual(plain(call.render(80)), ["● Bash(echo one)", "  ⎿  Waiting…"]);

const runningState = {};
const runningWithoutResult = shell.renderCall(
  { command: "sleep 1" },
  plainTheme,
  {
    cwd: "/repo",
    executionStarted: true,
    isPartial: true,
    state: runningState,
  },
);
assert.deepEqual(plain(runningWithoutResult.render(80)), [
  "● Bash(sleep 1)",
  "  ⎿  Running…",
]);
shell.renderResult(
  { details: { status: "running", stdout: "started\n", stderr: "" } },
  { expanded: false, isPartial: true },
  plainTheme,
  { isError: false, state: runningState },
);
assert.equal(runningState.piOpenHasResult, true);
assert.deepEqual(plain(runningWithoutResult.render(80)), ["● Bash(sleep 1)"]);

call = shell.renderCall(
  {
    command: [
      "apply_patch <<'PATCH'",
      "*** Begin Patch",
      "*** Update File: src/example.ts",
      "PATCH",
    ].join("\n"),
  },
  plainTheme,
  { cwd: "/repo", executionStarted: true, isPartial: false, isError: false },
);
assert.deepEqual(plain(call.render(80)), [
  "● Bash(apply_patch <<'PATCH'",
  "  *** Begin Patch…)",
]);

const shellResult = shell.renderResult(
  {
    details: {
      status: "completed",
      exitCode: 0,
      stdout: "one\r\ntwo\r\nthree\r\nfour\r\nfive\r\n",
      stderr: "",
    },
  },
  { expanded: false, isPartial: false },
  plainTheme,
  { isError: false },
);
assert.deepEqual(plain(shellResult.render(80)), [
  "  ⎿  one",
  "     two",
  "     three",
  "     … +2 lines (ctrl+o to expand)",
]);
assert.ok(shellResult.render(80).every((line) => !/[\r\n]/.test(line)));

const patch = tools.get("apply_patch");
assert.equal(patch.renderShell, "self");
const patchCall = patch.renderCall(
  {
    patch: [
      "*** Begin Patch",
      "*** Update File: /repo/src/a.ts",
      "@@",
      "-old value",
      "+new value",
      "*** End Patch",
    ].join("\n"),
  },
  plainTheme,
  { cwd: "/repo", executionStarted: true, isPartial: false, isError: false },
);
assert.deepEqual(plain(patchCall.render(80)), ["● Update(src/a.ts)"]);

const patchResult = patch.renderResult(
  {
    details: {
      status: "completed",
      exitCode: 0,
      patchSummary: {
        additions: 1,
        removals: 1,
        files: [
          {
            displayPath: "src/a.ts",
            hunks: [
              {
                lines: [
                  { kind: "context", text: "unchanged", oldLine: 1, newLine: 1 },
                  { kind: "remove", text: "old value", oldLine: 2, newLine: null },
                  { kind: "add", text: "new value", oldLine: null, newLine: 2 },
                ],
              },
            ],
          },
        ],
      },
    },
  },
  { expanded: false, isPartial: false },
  colorTheme,
  { isError: false },
);
const patchLines = patchResult.render(48);
assert.deepEqual(plain(patchLines), [
  "  ⎿  Added 1 line, removed 1 line",
  "      1  unchanged",
  "      2 -old value",
  "      2 +new value",
]);
const removed = patchLines.find((line) => stripAnsi(line).includes("2 -old value"));
const added = patchLines.find((line) => stripAnsi(line).includes("2 +new value"));
assert.ok(removed.startsWith(`     ${EDIT_DIFF_REMOVED_BACKGROUND}`));
assert.ok(added.startsWith(`     ${EDIT_DIFF_ADDED_BACKGROUND}`));
assert.equal(stripAnsi(removed).length, 48);
assert.equal(stripAnsi(added).length, 48);

const processOutput = patch.renderResult(
  {
    details: {
      status: "completed",
      exitCode: 0,
      combined: "Success. Updated the following files:\r\nA .pi_tool_test_tmp\r\n",
      patchSummary: { additions: 1, removals: 0, files: [] },
    },
  },
  { expanded: false, isPartial: false },
  plainTheme,
  { isError: false },
);
assert.deepEqual(plain(processOutput.render(120)), [
  "  ⎿  Added 1 line",
  "     Success. Updated the following files:",
  "     A .pi_tool_test_tmp",
]);

const errorResults = [];
for (const handler of handlers.get("tool_result") ?? []) {
  errorResults.push(await handler({
    toolName: "apply_patch",
    details: { exitCode: 1, signal: null, timedOut: false, aborted: false, spawnError: null },
  }));
}
assert.ok(errorResults.some((result) => result?.isError === true));

let intervalCallback;
let cleared = false;
const blink = new ClaudeToolBlinkController({
  setInterval(callback) {
    intervalCallback = callback;
    return { unref() {} };
  },
  clearInterval() {
    cleared = true;
  },
});
let renders = 0;
const key = {};
blink.sync(key, () => { renders += 1; }, true);
assert.equal(blink.runningCount(), 1);
intervalCallback();
assert.equal(blink.isLit(), false);
assert.equal(renders, 1);
blink.remove(key);
assert.equal(cleared, true);

console.log("pi-open-tui compatible shell_command/apply_patch renderer tests passed");

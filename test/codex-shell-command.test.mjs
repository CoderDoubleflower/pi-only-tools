import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CODEX_APPROX_BYTES_PER_TOKEN,
  CODEX_CAPTURE_MAX_BYTES,
  CODEX_TOOL_OUTPUT_TOKEN_LIMIT,
  aggregateCodexOutput,
  createCodexShellExtensionApi,
  formatExecOutputForModel,
  truncateMiddleWithTokenBudget,
  wrapShellCommandDefinition,
} from "../src/codex-shell-command.js";

assert.equal(CODEX_CAPTURE_MAX_BYTES, 1024 * 1024);
assert.equal(CODEX_TOOL_OUTPUT_TOKEN_LIMIT, 10_000);
assert.equal(CODEX_APPROX_BYTES_PER_TOKEN, 4);

const stdout = Buffer.alloc(CODEX_CAPTURE_MAX_BYTES, "s");
const stderr = Buffer.alloc(CODEX_CAPTURE_MAX_BYTES, "e");
const aggregated = aggregateCodexOutput(stdout, stderr);
const stdoutShare = Math.floor(CODEX_CAPTURE_MAX_BYTES / 3);
assert.equal(aggregated.length, CODEX_CAPTURE_MAX_BYTES);
assert.ok(aggregated.subarray(0, stdoutShare).every((byte) => byte === "s".charCodeAt(0)));
assert.ok(aggregated.subarray(stdoutShare).every((byte) => byte === "e".charCodeAt(0)));

const largeText = `begin\n${"x".repeat(100_000)}\nend`;
const truncated = truncateMiddleWithTokenBudget(largeText);
assert.equal(truncated.truncated, true);
assert.ok(truncated.text.startsWith("begin\n"));
assert.ok(truncated.text.endsWith("\nend"));
assert.match(truncated.text, /…\d+ tokens truncated…/);
assert.ok(
  Buffer.byteLength(truncated.text, "utf8") <=
    CODEX_TOOL_OUTPUT_TOKEN_LIMIT * CODEX_APPROX_BYTES_PER_TOKEN + 64,
);

const unicodeTruncated = truncateMiddleWithTokenBudget("开".repeat(30_000));
assert.equal(unicodeTruncated.truncated, true);
assert.equal(unicodeTruncated.text.includes("�"), false);
assert.match(unicodeTruncated.text, /…\d+ tokens truncated…/);

const formatted = formatExecOutputForModel(
  { exitCode: 0, timedOut: false, aborted: false, durationMs: 1_234 },
  largeText,
);
assert.match(formatted.text, /^Exit code: 0\nWall time: 1\.2 seconds\nTotal output lines: 3\nOutput:\n/);
assert.equal(formatted.truncated, true);

const wrapped = wrapShellCommandDefinition({
  name: "shell_command",
  description: "Run a shell command.",
  renderCall() {},
  renderResult() {},
});
assert.match(wrapped.description, /1 MiB/);
assert.match(wrapped.description, /10,000 tokens/);

const registered = [];
const realApi = {
  registerTool(tool) {
    registered.push(tool);
  },
  getActiveTools() {
    return ["read"];
  },
};
const wrappedApi = createCodexShellExtensionApi(realApi);
wrappedApi.registerTool({ name: "apply_patch", description: "patch", execute() {} });
wrappedApi.registerTool({ name: "shell_command", description: "shell", execute() {} });
assert.equal(registered[0].name, "apply_patch");
assert.equal(registered[1].name, "shell_command");
assert.match(registered[1].description, /1 MiB/);
assert.deepEqual(wrappedApi.getActiveTools(), ["read"]);

const temp = await mkdtemp(path.join(os.tmpdir(), "pi-only-tools-codex-limit-"));
try {
  const bytesPerStream = CODEX_CAPTURE_MAX_BYTES + 256 * 1024;
  const script =
    `process.stdout.write("S".repeat(${bytesPerStream}));` +
    `process.stderr.write("E".repeat(${bytesPerStream}));`;
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
  const updates = [];
  const result = await wrapped.execute(
    "shell-limit-test",
    { command, timeout_ms: 30_000 },
    undefined,
    (update) => updates.push(update),
    { cwd: temp },
  );

  assert.equal(result.details.exitCode, 0);
  assert.equal(result.details.totalStdoutBytes, bytesPerStream);
  assert.equal(result.details.totalStderrBytes, bytesPerStream);
  assert.equal(result.details.capturedStdoutBytes, CODEX_CAPTURE_MAX_BYTES);
  assert.equal(result.details.capturedStderrBytes, CODEX_CAPTURE_MAX_BYTES);
  assert.equal(result.details.captureMaxBytes, CODEX_CAPTURE_MAX_BYTES);
  assert.equal(result.details.captureTruncated, true);
  assert.equal(result.details.modelOutputTokenLimit, CODEX_TOOL_OUTPUT_TOKEN_LIMIT);
  assert.equal(result.details.modelOutputTruncated, true);
  assert.equal(Object.hasOwn(result.details, "combined"), false);
  assert.ok(Buffer.byteLength(result.details.stdout, "utf8") < 17 * 1024);
  assert.ok(Buffer.byteLength(result.details.stderr, "utf8") < 17 * 1024);

  const modelText = result.content[0].text;
  assert.match(modelText, /^Exit code: 0\nWall time: /);
  assert.match(modelText, /Total output lines: 1\nOutput:\n/);
  assert.match(modelText, /…\d+ tokens truncated…/);
  assert.ok(modelText.includes("SSSS"));
  assert.ok(modelText.endsWith("EEEE"));
  assert.ok(
    Buffer.byteLength(modelText, "utf8") <=
      CODEX_TOOL_OUTPUT_TOKEN_LIMIT * CODEX_APPROX_BYTES_PER_TOKEN + 256,
  );

  for (const update of updates) {
    assert.equal(Object.hasOwn(update.details ?? {}, "combined"), false);
    for (const item of update.content ?? []) {
      if (item.type === "text") {
        assert.ok(Buffer.byteLength(item.text, "utf8") <= 9 * 1024);
      }
    }
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}

console.log("Codex shell_command limit tests passed");

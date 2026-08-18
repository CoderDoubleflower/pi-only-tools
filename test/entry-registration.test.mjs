import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import plugin from "../src/entry.js";

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

console.log("runtime entry registration test passed");

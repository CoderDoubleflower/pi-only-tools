import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import plugin from "../src/index.js";
import { executeCodexShellCommand } from "../src/codex-shell-process.js";

const tools = new Map();
plugin({ registerTool: (tool) => tools.set(tool.name, tool), registerCommand() {}, on() {} });
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

async function withDeadline(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Process did not settle within 5 seconds")), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// The background child ignores TERM while its shell (the group leader) exits.
// A timeout must still escalate against the surviving process group.
for (const [name, execute] of [
  ["Codex shell", executeCodexShellCommand],
  ["base process runner", tools.get("shell_command").execute],
]) {
  for (const cancellation of ["timeout", "abort"]) {
    test(`${name} ${cancellation} terminates descendants after the shell exits`, {
      skip: process.platform === "win32" ? "Unix process-group regression" : false,
    }, async () => {
      const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-process-tree-"));
      const script = path.join(cwd, "ignore-term.cjs");
      const pidFile = path.join(cwd, "child.json");
      const controller = new AbortController();
      await writeFile(script, `
        const fs = require("node:fs");
        process.on("SIGTERM", () => {});
        fs.writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid, group: process.ppid }));
        process.stdout.write("READY\\n");
        setInterval(() => {}, 1000);
      `);
      let child;
      try {
        const command = `${quote(process.execPath)} ${quote(script)} ${quote(pidFile)} & wait`;
        const result = await withDeadline(execute(
          "process-tree-test",
          // Abort wins even though TERM escalation outlasts the original timeout.
          { command, timeout_ms: 500 },
          controller.signal,
          (update) => {
            if (cancellation === "abort" && update.content?.some((block) => block.text?.includes("READY"))) {
              controller.abort();
            }
          },
          { cwd },
        ));
        child = JSON.parse(await readFile(pidFile, "utf8"));
        assert.equal(result.isError, true);
        assert.equal(result.details.timedOut, cancellation === "timeout");
        assert.equal(result.details.aborted, cancellation === "abort");
        if (process.platform === "linux") {
          const state = await readFile(`/proc/${child.pid}/stat`, "utf8").catch((error) => {
            if (error.code !== "ENOENT") throw error;
            return undefined;
          });
          // An orphan may remain as a zombie until the container's init reaps it.
          assert.ok(state === undefined || /\) Z /.test(state), "the descendant must no longer execute");
        }
      } finally {
        controller.abort();
        child ??= await readFile(pidFile, "utf8").then(JSON.parse).catch(() => undefined);
        if (child) {
          try { process.kill(-child.group, "SIGKILL"); } catch {}
        }
        await rm(cwd, { recursive: true, force: true });
      }
    });
  }
}

test("cancellation from the initial update is observed before process output", async () => {
  const controller = new AbortController();
  const command = process.platform === "win32" ? "ping -n 30 127.0.0.1 >NUL" : "sleep 30";
  const result = await withDeadline(executeCodexShellCommand(
    "initial-update-abort", { command, timeout_ms: 10_000 }, controller.signal,
    () => controller.abort(), { cwd: os.tmpdir() },
  ));
  assert.equal(result.isError, true);
  assert.equal(result.details.aborted, true);
  assert.equal(result.details.timedOut, false);
});

test("failed patch startup and pre-aborted patches report tool errors", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-patch-failure-"));
  const original = process.env.PI_ONLY_TOOLS_APPLY_PATCH_COMMAND;
  const patch = "*** Begin Patch\n*** Add File: never.txt\n+never\n*** End Patch";
  try {
    process.env.PI_ONLY_TOOLS_APPLY_PATCH_COMMAND = path.join(cwd, "missing-apply-patch");
    const missing = await tools.get("apply_patch").execute("missing", { patch }, undefined, undefined, { cwd });
    assert.equal(missing.isError, true);
    assert.match(missing.details.spawnError, /ENOENT/);
    assert.match(missing.content[0].text, /Failed to start process/);

    const aborted = await tools.get("apply_patch").execute(
      "aborted", { patch }, AbortSignal.abort(), undefined, { cwd },
    );
    assert.equal(aborted.isError, true);
    assert.equal(aborted.details.aborted, true);
    assert.equal(aborted.details.spawnError, null);
    await assert.rejects(readFile(path.join(cwd, "never.txt")), { code: "ENOENT" });
  } finally {
    if (original === undefined) delete process.env.PI_ONLY_TOOLS_APPLY_PATCH_COMMAND;
    else process.env.PI_ONLY_TOOLS_APPLY_PATCH_COMMAND = original;
    await rm(cwd, { recursive: true, force: true });
  }
});

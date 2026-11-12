import { spawn } from "node:child_process";
import { isProcessSuccess, waitForProcess } from "./process-lifecycle.js";
import { constants as fsConstants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";

import {
  HeadTailByteCapture,
  TailByteCapture,
  buildRenderDetails,
  formatCapturedOutputForModel,
  formatExecOutputForModel,
  partialContentText,
} from "./codex-shell-output.js";

const UPDATE_THROTTLE_MS = 100;

function resolveWorkdir(baseCwd, requested) {
  if (typeof requested !== "string" || requested.trim() === "") return path.resolve(baseCwd);
  return path.isAbsolute(requested) ? path.normalize(requested) : path.resolve(baseCwd, requested);
}

async function assertDirectoryExists(cwd) {
  await access(cwd, fsConstants.F_OK);
  const info = await stat(cwd);
  if (!info.isDirectory()) throw new Error(`Working directory is not a directory: ${cwd}`);
}

function shellInvocation(command) {
  if (process.platform === "win32") {
    return {
      executable: process.env.ComSpec || process.env.COMSPEC || "cmd.exe",
      args: ["/d", "/s", "/c", command],
    };
  }
  const executable = process.env.PI_ONLY_TOOLS_SHELL || process.env.SHELL || "/bin/bash";
  return { executable, args: ["-lc", command] };
}

export async function executeCodexShellCommand(_toolCallId, params, signal, onUpdate, ctx) {
  const command = params.command;
  const cwd = resolveWorkdir(ctx.cwd, params.workdir);
  const timeoutMs = params.timeout_ms ?? 10_000;
  const invocation = shellInvocation(command);
  const startedAt = Date.now();

  await assertDirectoryExists(cwd);

  const stdoutCapture = new HeadTailByteCapture();
  const stderrCapture = new HeadTailByteCapture();
  const stdoutTail = new TailByteCapture();
  const stderrTail = new TailByteCapture();

  if (signal?.aborted) {
    const details = buildRenderDetails({
      command,
      cwd,
      timeoutMs,
      status: "completed",
      exitCode: null,
      signal: null,
      timedOut: false,
      aborted: true,
      spawnError: null,
      durationMs: 0,
      stdoutBuffer: Buffer.alloc(0),
      stderrBuffer: Buffer.alloc(0),
      stdoutTotalBytes: 0,
      stderrTotalBytes: 0,
    });
    const modelResult = formatExecOutputForModel(details, "");
    Object.assign(details, {
      modelOutputTruncated: modelResult.truncated,
      modelOutputOriginalTokens: modelResult.originalTokenCount,
      modelOutputBytes: Buffer.byteLength(modelResult.text, "utf8"),
    });
    return { content: [{ type: "text", text: modelResult.text }], details, isError: true };
  }

  let child;
  try {
    child = spawn(invocation.executable, invocation.args, {
      cwd,
      env: { ...process.env },
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const details = buildRenderDetails({
      command,
      cwd,
      timeoutMs,
      status: "completed",
      exitCode: null,
      signal: null,
      timedOut: false,
      aborted: false,
      spawnError: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
      stdoutBuffer: Buffer.alloc(0),
      stderrBuffer: Buffer.alloc(0),
      stdoutTotalBytes: 0,
      stderrTotalBytes: 0,
    });
    const modelResult = formatExecOutputForModel(details, `Failed to start process: ${details.spawnError}`);
    Object.assign(details, {
      modelOutputTruncated: modelResult.truncated,
      modelOutputOriginalTokens: modelResult.originalTokenCount,
      modelOutputBytes: Buffer.byteLength(modelResult.text, "utf8"),
    });
    return { content: [{ type: "text", text: modelResult.text }], details, isError: true };
  }

  const completion = waitForProcess(child, { signal, timeoutMs });

  let updateTimer;
  let updateDirty = false;
  let lastUpdateAt = 0;

  const snapshotRunningDetails = () =>
    buildRenderDetails({
      command,
      cwd,
      timeoutMs,
      status: "running",
      exitCode: null,
      signal: null,
      timedOut: false,
      aborted: false,
      spawnError: null,
      durationMs: Date.now() - startedAt,
      stdoutCapturedBytes: stdoutCapture.capturedBytes,
      stderrCapturedBytes: stderrCapture.capturedBytes,
      stdoutTotalBytes: stdoutCapture.totalBytes,
      stderrTotalBytes: stderrCapture.totalBytes,
      partialStdout: stdoutTail.toString(),
      partialStderr: stderrTail.toString(),
    });

  const emitUpdate = () => {
    if (!onUpdate || !updateDirty) return;
    updateDirty = false;
    lastUpdateAt = Date.now();
    const details = snapshotRunningDetails();
    onUpdate({
      content: [{ type: "text", text: partialContentText(details.stdout, details.stderr) }],
      details,
    });
  };

  const scheduleUpdate = () => {
    if (!onUpdate) return;
    updateDirty = true;
    const delay = UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
    if (delay <= 0) {
      if (updateTimer) clearTimeout(updateTimer);
      updateTimer = undefined;
      emitUpdate();
      return;
    }
    updateTimer ??= setTimeout(() => {
      updateTimer = undefined;
      emitUpdate();
    }, delay);
  };

  child.stdout?.on("data", (chunk) => {
    stdoutCapture.append(chunk);
    stdoutTail.append(chunk);
    scheduleUpdate();
  });
  child.stderr?.on("data", (chunk) => {
    stderrCapture.append(chunk);
    stderrTail.append(chunk);
    scheduleUpdate();
  });

  if (onUpdate) onUpdate({ content: [], details: snapshotRunningDetails() });

  const terminal = await completion;

  if (updateTimer) clearTimeout(updateTimer);
  updateDirty = true;
  emitUpdate();

  const stdoutBuffer = stdoutCapture.toBuffer();
  const stderrBuffer = stderrCapture.toBuffer();
  const { timedOut, aborted } = terminal;
  const provisional = {
    exitCode: terminal.exitCode,
    timedOut,
    aborted,
    durationMs: Date.now() - startedAt,
    totalOutputBytes: stdoutCapture.totalBytes + stderrCapture.totalBytes,
    totalOutputLines: stdoutCapture.newlineCount + stderrCapture.newlineCount +
      ((stderrCapture.lastByte ?? stdoutCapture.lastByte) !== undefined &&
       (stderrCapture.lastByte ?? stdoutCapture.lastByte) !== 10 ? 1 : 0),
  };
  const modelResult = formatCapturedOutputForModel(provisional, stdoutBuffer, stderrBuffer);
  const status = terminal.spawnError
    ? `Failed to start process: ${terminal.spawnError}`
    : aborted ? "Command aborted"
    : terminal.signal ? `Command terminated by signal ${terminal.signal}` : "";
  if (status) modelResult.text += `\n${status}`;
  const details = buildRenderDetails({
    command,
    cwd,
    timeoutMs,
    status: "completed",
    exitCode: terminal.exitCode,
    signal: terminal.signal,
    timedOut,
    aborted,
    spawnError: terminal.spawnError,
    durationMs: provisional.durationMs,
    stdoutBuffer,
    stderrBuffer,
    stdoutTotalBytes: stdoutCapture.totalBytes,
    stderrTotalBytes: stderrCapture.totalBytes,
    stdoutCapturedBytes: stdoutCapture.capturedBytes,
    stderrCapturedBytes: stderrCapture.capturedBytes,
    modelResult,
  });

  return {
    content: [{ type: "text", text: modelResult.text }],
    details,
    isError: !isProcessSuccess(details),
  };
}

export const __test = {
  assertDirectoryExists,
  executeCodexShellCommand,
  waitForProcess,
  resolveWorkdir,
  shellInvocation,
};

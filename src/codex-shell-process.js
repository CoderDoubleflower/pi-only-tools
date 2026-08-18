import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";

import {
  CODEX_CAPTURE_MAX_BYTES,
  HeadByteCapture,
  TailByteCapture,
  aggregateCodexOutput,
  buildRenderDetails,
  decodeUtf8Lossy,
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

function killProcessTree(child) {
  const pid = child?.pid;
  if (!pid) return undefined;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.unref();
    return undefined;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {}
  }

  const forceTimer = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
  }, 750);
  forceTimer.unref?.();
  return forceTimer;
}

export async function executeCodexShellCommand(_toolCallId, params, signal, onUpdate, ctx) {
  const command = params.command;
  const cwd = resolveWorkdir(ctx.cwd, params.workdir);
  const timeoutMs = params.timeout_ms ?? 10_000;
  const invocation = shellInvocation(command);
  const startedAt = Date.now();

  await assertDirectoryExists(cwd);

  const stdoutCapture = new HeadByteCapture();
  const stderrCapture = new HeadByteCapture();
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
    return { content: [{ type: "text", text: modelResult.text }], details };
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
    return { content: [{ type: "text", text: modelResult.text }], details };
  }

  let updateTimer;
  let updateDirty = false;
  let lastUpdateAt = 0;
  let timedOut = false;
  let aborted = false;
  let terminationRequested = false;
  let forceKillHandle;

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

  const requestTermination = () => {
    if (terminationRequested) return;
    terminationRequested = true;
    forceKillHandle = killProcessTree(child);
  };
  const abortHandler = () => {
    aborted = true;
    requestTermination();
  };
  if (signal) signal.addEventListener("abort", abortHandler, { once: true });

  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    requestTermination();
  }, timeoutMs);
  timeoutHandle.unref?.();

  const terminal = await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.once("error", (error) =>
      finish({ exitCode: null, signal: null, spawnError: error.message }),
    );
    child.once("close", (exitCode, closeSignal) =>
      finish({ exitCode, signal: closeSignal, spawnError: null }),
    );
  });

  clearTimeout(timeoutHandle);
  if (forceKillHandle) clearTimeout(forceKillHandle);
  if (updateTimer) clearTimeout(updateTimer);
  if (signal) signal.removeEventListener("abort", abortHandler);
  updateDirty = true;
  emitUpdate();

  const stdoutBuffer = stdoutCapture.toBuffer();
  const stderrBuffer = stderrCapture.toBuffer();
  const aggregated = aggregateCodexOutput(stdoutBuffer, stderrBuffer, CODEX_CAPTURE_MAX_BYTES);
  const aggregatedText = decodeUtf8Lossy(aggregated);
  const provisional = {
    exitCode: terminal.exitCode,
    timedOut,
    aborted,
    durationMs: Date.now() - startedAt,
  };
  let modelBody = aggregatedText;
  if (terminal.spawnError) {
    modelBody = `${modelBody ? `${modelBody}\n\n` : ""}Failed to start process: ${terminal.spawnError}`;
  } else if (aborted && !modelBody) {
    modelBody = "Command aborted";
  } else if (terminal.signal && !modelBody) {
    modelBody = `Command terminated by signal ${terminal.signal}`;
  }
  const modelResult = formatExecOutputForModel(provisional, modelBody);
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
    modelResult,
  });

  return {
    content: [{ type: "text", text: modelResult.text }],
    details,
  };
}

export const __test = {
  assertDirectoryExists,
  executeCodexShellCommand,
  killProcessTree,
  resolveWorkdir,
  shellInvocation,
};

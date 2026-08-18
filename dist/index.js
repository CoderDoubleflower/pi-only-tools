import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { CONFIG_DIR_NAME, getAgentDir, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { SettingsList, truncateToWidth } from "@earendil-works/pi-tui";

const ONLY_TOOLS = Object.freeze(["shell_command", "apply_patch"]);
const PI_STANDARD_DEFAULT_TOOLS = Object.freeze(["read", "bash", "edit", "write"]);
const TOOLS_STATE_ENTRY = "tools-config";
const TOOL_ITEM_PREFIX = "tool:";
const ACTION_SAVE_CURRENT = "__save_current_builtins__";
const ACTION_USE_PI_DEFAULTS = "__use_pi_defaults__";
const ACTION_DISABLE_ALL = "__disable_all_builtins__";
const ACTION_ENABLE_ALL = "__enable_all_builtins__";
const SETTINGS_LOCK_RETRY_MS = 20;
const SETTINGS_LOCK_TIMEOUT_MS = 2_000;
const SETTINGS_LOCK_STALE_MS = 10_000;
const SHELL_DEFAULT_TIMEOUT_MS = 10_000;
const PATCH_DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 2_147_483_647;
const UPDATE_THROTTLE_MS = 100;
const MAX_CAPTURE_CHARS = 400_000;
const MAX_FILE_DIFF_BYTES = 2 * 1024 * 1024;
const MAX_DIFF_MATRIX_CELLS = 2_000_000;
const CLAUDE_COMMAND_MAX_LINES = 2;
const CLAUDE_COMMAND_MAX_CHARS = 160;
const CLAUDE_OUTPUT_MAX_LINES = 3;
const CLAUDE_DIFF_MAX_LINES = 12;
const RESPONSE_PREFIX = "  ⎿  ";
const RESPONSE_CONTINUATION = "     ";

const shellCommandSchema = Type.Object(
  {
    command: Type.String({
      minLength: 1,
      description: "Shell command to execute.",
    }),
    workdir: Type.Optional(
      Type.String({
        description: "Working directory. Relative paths resolve against the current Pi working directory.",
      }),
    ),
    timeout_ms: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: MAX_TIMEOUT_MS,
        description: `Maximum runtime in milliseconds. Defaults to ${SHELL_DEFAULT_TIMEOUT_MS}.`,
      }),
    ),
  },
  { additionalProperties: false },
);

const applyPatchSchema = Type.Object(
  {
    patch: Type.String({
      minLength: 1,
      description:
        "Raw apply_patch input. It must begin with `*** Begin Patch` and end with `*** End Patch`. Do not JSON-escape it beyond the normal function-call string encoding.",
    }),
    workdir: Type.Optional(
      Type.String({
        description: "Working directory. Relative paths resolve against the current Pi working directory.",
      }),
    ),
    timeout_ms: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: MAX_TIMEOUT_MS,
        description: `Maximum runtime in milliseconds. Defaults to ${PATCH_DEFAULT_TIMEOUT_MS}.`,
      }),
    ),
  },
  { additionalProperties: false },
);

class DynamicLinesComponent {
  constructor(renderLines) {
    this.renderLines = renderLines;
  }

  render(width) {
    return this.renderLines(Math.max(1, Math.floor(width)));
  }

  invalidate() {}
}

class TailTextCapture {
  constructor(maxChars = MAX_CAPTURE_CHARS) {
    this.maxChars = maxChars;
    this.stdout = "";
    this.stderr = "";
    this.combined = "";
    this.totalChars = 0;
    this.droppedChars = 0;
  }

  append(kind, text) {
    if (!text) return;
    this.totalChars += text.length;
    if (kind === "stdout") this.stdout = appendTail(this.stdout, text, this.maxChars);
    else this.stderr = appendTail(this.stderr, text, this.maxChars);
    const next = this.combined + text;
    if (next.length > this.maxChars) {
      const excess = next.length - this.maxChars;
      this.droppedChars += excess;
      this.combined = next.slice(excess);
    } else {
      this.combined = next;
    }
  }

  snapshot() {
    return {
      stdout: this.stdout,
      stderr: this.stderr,
      combined: this.combined,
      totalChars: this.totalChars,
      droppedChars: this.droppedChars,
    };
  }
}

function appendTail(current, text, maxChars) {
  const next = current + text;
  return next.length <= maxChars ? next : next.slice(next.length - maxChars);
}

function normalizePreparedObject(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return { ...raw };
  return {};
}

function prepareShellArguments(raw) {
  if (typeof raw === "string") return { command: raw };
  const args = normalizePreparedObject(raw);
  if (typeof args.command !== "string" && typeof args.cmd === "string") args.command = args.cmd;
  if (typeof args.workdir !== "string" && typeof args.cwd === "string") args.workdir = args.cwd;
  if (args.timeout_ms === undefined && typeof args.timeout === "number") {
    args.timeout_ms = Math.round(args.timeout * 1000);
  }
  delete args.cmd;
  delete args.cwd;
  delete args.timeout;
  return args;
}

function preparePatchArguments(raw) {
  if (typeof raw === "string") return { patch: raw };
  const args = normalizePreparedObject(raw);
  if (typeof args.patch !== "string") {
    for (const alias of ["input", "patch_text", "patchText", "command"]) {
      if (typeof args[alias] === "string") {
        args.patch = args[alias];
        break;
      }
    }
  }
  if (typeof args.workdir !== "string" && typeof args.cwd === "string") args.workdir = args.cwd;
  if (args.timeout_ms === undefined && typeof args.timeout === "number") {
    args.timeout_ms = Math.round(args.timeout * 1000);
  }
  for (const alias of ["input", "patch_text", "patchText", "command", "cwd", "timeout"]) delete args[alias];
  return args;
}

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

function processDetailsSnapshot(kind, cwd, capture, startedAt, overrides = {}) {
  return {
    kind,
    cwd,
    status: "running",
    exitCode: null,
    signal: null,
    timedOut: false,
    aborted: false,
    spawnError: null,
    durationMs: Date.now() - startedAt,
    ...capture.snapshot(),
    ...overrides,
  };
}

async function runCapturedProcess({
  kind,
  executable,
  args,
  cwd,
  stdin,
  timeoutMs,
  signal,
  onUpdate,
  detailExtras,
}) {
  const startedAt = Date.now();
  const capture = new TailTextCapture();
  await assertDirectoryExists(cwd);

  if (signal?.aborted) {
    return processDetailsSnapshot(kind, cwd, capture, startedAt, {
      status: "completed",
      aborted: true,
      ...detailExtras,
    });
  }

  let child;
  try {
    child = spawn(executable, args, {
      cwd,
      env: { ...process.env },
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
  } catch (error) {
    return processDetailsSnapshot(kind, cwd, capture, startedAt, {
      status: "completed",
      spawnError: error instanceof Error ? error.message : String(error),
      ...detailExtras,
    });
  }

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");

  let updateTimer;
  let updateDirty = false;
  let lastUpdateAt = 0;
  let timedOut = false;
  let aborted = false;
  let terminationRequested = false;
  let forceKillHandle;

  const emitUpdate = () => {
    if (!onUpdate || !updateDirty) return;
    updateDirty = false;
    lastUpdateAt = Date.now();
    const details = processDetailsSnapshot(kind, cwd, capture, startedAt, detailExtras);
    onUpdate({
      content: [{ type: "text", text: partialContentText(details) }],
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

  const onStdout = (text) => {
    capture.append("stdout", text);
    scheduleUpdate();
  };
  const onStderr = (text) => {
    capture.append("stderr", text);
    scheduleUpdate();
  };
  child.stdout?.on("data", onStdout);
  child.stderr?.on("data", onStderr);

  if (onUpdate) {
    const details = processDetailsSnapshot(kind, cwd, capture, startedAt, detailExtras);
    onUpdate({ content: [], details });
  }

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

  let timeoutHandle;
  if (timeoutMs !== undefined) {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      requestTermination();
    }, timeoutMs);
    timeoutHandle.unref?.();
  }

  if (stdin !== undefined) {
    child.stdin?.on("error", () => {});
    child.stdin?.end(stdin);
  }

  const terminal = await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.once("error", (error) => finish({ exitCode: null, signal: null, spawnError: error.message }));
    child.once("close", (exitCode, closeSignal) => finish({ exitCode, signal: closeSignal, spawnError: null }));
  });

  if (timeoutHandle) clearTimeout(timeoutHandle);
  if (forceKillHandle) clearTimeout(forceKillHandle);
  if (updateTimer) clearTimeout(updateTimer);
  if (signal) signal.removeEventListener("abort", abortHandler);
  updateDirty = true;
  emitUpdate();

  return processDetailsSnapshot(kind, cwd, capture, startedAt, {
    status: "completed",
    exitCode: terminal.exitCode,
    signal: terminal.signal,
    spawnError: terminal.spawnError,
    timedOut,
    aborted,
    ...detailExtras,
  });
}

function partialContentText(details) {
  if (details.droppedChars > 0) {
    return `[Earlier output omitted: ${details.droppedChars} characters]\n${details.combined}`;
  }
  return details.combined;
}

function finalProcessContent(details, emptySuccessText) {
  let output = details.combined.trimEnd();
  if (details.droppedChars > 0) {
    output = `[Earlier output omitted: ${details.droppedChars} characters]\n${output}`;
  }
  let status = "";
  if (details.spawnError) status = `Failed to start process: ${details.spawnError}`;
  else if (details.aborted) status = "Command aborted";
  else if (details.timedOut) status = `Command timed out after ${details.timeoutMs} ms`;
  else if (details.exitCode !== 0 && details.exitCode !== null) status = `Command exited with code ${details.exitCode}`;
  else if (details.signal) status = `Command terminated by signal ${details.signal}`;

  if (!output && !status) return emptySuccessText;
  if (!output) return status;
  if (!status) return output;
  return `${output}\n\n${status}`;
}

function isProcessSuccess(details) {
  return (
    !details.spawnError &&
    !details.aborted &&
    !details.timedOut &&
    !details.signal &&
    (details.exitCode === 0 || details.exitCode === null)
  );
}

function formatDisplayPath(filePath, cwd) {
  if (!filePath) return "";
  const absolute = path.isAbsolute(filePath) ? path.normalize(filePath) : path.resolve(cwd, filePath);
  const relative = path.relative(cwd, absolute);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return relative;
  const home = os.homedir();
  const homeRelative = path.relative(home, absolute);
  if (homeRelative && !homeRelative.startsWith("..") && !path.isAbsolute(homeRelative)) {
    return `~${path.sep}${homeRelative}`;
  }
  return filePath;
}

function commandPreview(command) {
  const originalLines = String(command ?? "").replace(/\r\n/g, "\n").split("\n");
  const lines = originalLines.slice(0, CLAUDE_COMMAND_MAX_LINES);
  let consumed = 0;
  const limited = [];
  for (const line of lines) {
    const remaining = Math.max(0, CLAUDE_COMMAND_MAX_CHARS - consumed);
    if (remaining === 0) break;
    const piece = line.slice(0, remaining);
    limited.push(piece.trimEnd());
    consumed += piece.length + 1;
  }
  const truncated =
    originalLines.length > CLAUDE_COMMAND_MAX_LINES || String(command ?? "").length > CLAUDE_COMMAND_MAX_CHARS;
  if (limited.length === 0) limited.push("…");
  if (truncated) limited[limited.length - 1] = `${limited[limited.length - 1]}…`;
  return limited;
}

function claudeCallComponent(name, valueLines, theme) {
  return new DynamicLinesComponent((width) => {
    const title = theme.fg("toolTitle", theme.bold(name));
    const open = theme.fg("muted", "(");
    const close = theme.fg("muted", ")");
    const lines = valueLines.length > 0 ? valueLines : ["…"];
    if (lines.length === 1) {
      return [truncateToWidth(`${title}${open}${theme.fg("toolOutput", lines[0])}${close}`, width, "…")];
    }
    const first = truncateToWidth(`${title}${open}${theme.fg("toolOutput", lines[0])}`, width, "…");
    const indent = " ".repeat(name.length + 2);
    const rest = lines.slice(1).map((line, index) => {
      const suffix = index === lines.length - 2 ? close : "";
      return truncateToWidth(`${indent}${theme.fg("toolOutput", line)}${suffix}`, width, "…");
    });
    return [first, ...rest];
  });
}

function responseLinesComponent(linesFactory, theme) {
  return new DynamicLinesComponent((width) => {
    const lines = linesFactory(width);
    if (lines.length === 0) return [];
    const prefix = theme.fg("muted", RESPONSE_PREFIX);
    return lines.map((line, index) =>
      truncateToWidth(`${index === 0 ? prefix : RESPONSE_CONTINUATION}${line}`, width, "…"),
    );
  });
}

function prefixedGroupsComponent(groupsFactory, theme) {
  return new DynamicLinesComponent((width) => {
    const groups = groupsFactory(width).filter((group) => group.length > 0);
    const lines = [];
    for (const group of groups) {
      group.forEach((line, index) => {
        const prefix = index === 0 ? theme.fg("muted", RESPONSE_PREFIX) : RESPONSE_CONTINUATION;
        lines.push(truncateToWidth(`${prefix}${line}`, width, "…"));
      });
    }
    return lines;
  });
}

function splitOutputLines(text) {
  if (!text) return [];
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd();
  return normalized ? normalized.split("\n") : [];
}

function collapsedLines(lines, maxLines, theme) {
  if (lines.length <= maxLines + 1) return lines;
  const shown = lines.slice(0, maxLines);
  const remaining = lines.length - maxLines;
  shown.push(theme.fg("muted", `… +${remaining} lines (ctrl+o to expand)`));
  return shown;
}

function shellResultComponent(result, options, theme) {
  const details = result.details ?? {};
  return prefixedGroupsComponent(() => {
    const groups = [];
    const stdoutLines = splitOutputLines(details.stdout ?? "").map((line) => theme.fg("toolOutput", line));
    const stderrLines = splitOutputLines(details.stderr ?? "").map((line) => theme.fg("error", line));

    if (stdoutLines.length > 0) {
      groups.push(options.expanded ? stdoutLines : collapsedLines(stdoutLines, CLAUDE_OUTPUT_MAX_LINES, theme));
    }
    if (stderrLines.length > 0) {
      groups.push(options.expanded ? stderrLines : collapsedLines(stderrLines, CLAUDE_OUTPUT_MAX_LINES, theme));
    }

    if (groups.length === 0) {
      if (options.isPartial || details.status === "running") {
        groups.push([theme.fg("muted", "Running…")]);
      } else if (isProcessSuccess(details)) {
        groups.push([theme.fg("muted", "(No output)")]);
      }
    }

    if (details.droppedChars > 0) {
      groups.push([theme.fg("warning", `[Earlier output omitted: ${details.droppedChars} characters]`)]);
    }
    const status = processStatusLine(details, theme);
    if (status) groups.push([status]);
    return groups;
  }, theme);
}

function processStatusLine(details, theme) {
  if (details.spawnError) return theme.fg("error", `Failed to start process: ${details.spawnError}`);
  if (details.aborted) return theme.fg("error", "Command aborted");
  if (details.timedOut) return theme.fg("error", `Command timed out after ${details.timeoutMs} ms`);
  if (details.exitCode !== 0 && details.exitCode !== null) {
    return theme.fg("error", `Command exited with code ${details.exitCode}`);
  }
  if (details.signal) return theme.fg("error", `Command terminated by signal ${details.signal}`);
  return null;
}

function parseApplyPatchMetadata(patchText, cwd) {
  const files = [];
  const lines = String(patchText ?? "").replace(/\r\n/g, "\n").split("\n");
  let current = null;

  for (const line of lines) {
    const fileMatch = line.match(/^\*\*\* (Add|Update|Delete) File:\s*(.+?)\s*$/);
    if (fileMatch) {
      current = {
        operation: fileMatch[1].toLowerCase(),
        path: fileMatch[2],
        moveTo: null,
        additions: 0,
        removals: 0,
      };
      files.push(current);
      continue;
    }
    if (!current) continue;
    const moveMatch = line.match(/^\*\*\* Move to:\s*(.+?)\s*$/);
    if (moveMatch) {
      current.moveTo = moveMatch[1];
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) current.additions += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) current.removals += 1;
  }

  for (const file of files) {
    file.absolutePath = path.isAbsolute(file.path) ? path.normalize(file.path) : path.resolve(cwd, file.path);
    file.absoluteMoveTo = file.moveTo
      ? path.isAbsolute(file.moveTo)
        ? path.normalize(file.moveTo)
        : path.resolve(cwd, file.moveTo)
      : null;
    file.displayPath = formatDisplayPath(file.moveTo || file.path, cwd);
  }

  return {
    files,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    removals: files.reduce((sum, file) => sum + file.removals, 0),
  };
}

function patchCallName(metadata) {
  if (metadata.files.length !== 1) return "Update";
  const operation = metadata.files[0].operation;
  if (operation === "add") return "Create";
  if (operation === "delete") return "Delete";
  return "Update";
}

function patchCallValue(metadata) {
  if (metadata.files.length === 0) return ["patch"];
  if (metadata.files.length === 1) return [metadata.files[0].displayPath];
  return [`${metadata.files.length} files`];
}

async function readTextSnapshot(filePath) {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return { exists: false, text: "", unavailable: "not a regular file" };
    if (info.size > MAX_FILE_DIFF_BYTES) {
      return { exists: true, text: "", unavailable: `file exceeds ${MAX_FILE_DIFF_BYTES} bytes` };
    }
    const buffer = await readFile(filePath);
    if (buffer.includes(0)) return { exists: true, text: "", unavailable: "binary file" };
    return { exists: true, text: buffer.toString("utf8"), unavailable: null };
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return { exists: false, text: "", unavailable: null };
    }
    return {
      exists: false,
      text: "",
      unavailable: error instanceof Error ? error.message : String(error),
    };
  }
}

async function snapshotPatchBefore(metadata) {
  const snapshots = new Map();
  for (const file of metadata.files) {
    snapshots.set(file.absolutePath, await readTextSnapshot(file.absolutePath));
  }
  return snapshots;
}

async function buildPatchChanges(metadata, beforeSnapshots) {
  const changes = [];
  for (const file of metadata.files) {
    const before = beforeSnapshots.get(file.absolutePath) ?? { exists: false, text: "", unavailable: null };
    const finalPath = file.absoluteMoveTo || file.absolutePath;
    const after = await readTextSnapshot(finalPath);
    const change = {
      operation: file.operation,
      path: file.path,
      moveTo: file.moveTo,
      displayPath: file.displayPath,
      additions: file.additions,
      removals: file.removals,
      hunks: [],
      unavailable: before.unavailable || after.unavailable,
    };
    if (!change.unavailable) {
      const diff = buildLineDiff(before.exists ? before.text : "", after.exists ? after.text : "");
      if (diff) {
        change.additions = diff.additions;
        change.removals = diff.removals;
        change.hunks = diff.hunks;
      } else {
        change.unavailable = "file is too large to diff efficiently";
      }
    }
    changes.push(change);
  }
  return {
    files: changes,
    additions: changes.reduce((sum, file) => sum + file.additions, 0),
    removals: changes.reduce((sum, file) => sum + file.removals, 0),
  };
}

function splitFileLines(text) {
  const normalized = String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (normalized === "") return [];
  const lines = normalized.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function buildLineDiff(beforeText, afterText) {
  const before = splitFileLines(beforeText);
  const after = splitFileLines(afterText);
  const cells = (before.length + 1) * (after.length + 1);
  if (cells > MAX_DIFF_MATRIX_CELLS) return null;

  const columns = after.length + 1;
  const table = new Uint32Array((before.length + 1) * columns);
  for (let i = before.length - 1; i >= 0; i -= 1) {
    const row = i * columns;
    const nextRow = (i + 1) * columns;
    for (let j = after.length - 1; j >= 0; j -= 1) {
      table[row + j] =
        before[i] === after[j]
          ? table[nextRow + j + 1] + 1
          : Math.max(table[nextRow + j], table[row + j + 1]);
    }
  }

  const operations = [];
  let i = 0;
  let j = 0;
  let oldLine = 1;
  let newLine = 1;
  let additions = 0;
  let removals = 0;

  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      operations.push({ kind: "context", text: before[i], oldLine, newLine });
      i += 1;
      j += 1;
      oldLine += 1;
      newLine += 1;
    } else if (
      j < after.length &&
      (i >= before.length || table[i * columns + j + 1] > table[(i + 1) * columns + j])
    ) {
      operations.push({ kind: "add", text: after[j], oldLine: null, newLine });
      j += 1;
      newLine += 1;
      additions += 1;
    } else {
      operations.push({ kind: "remove", text: before[i], oldLine, newLine: null });
      i += 1;
      oldLine += 1;
      removals += 1;
    }
  }

  const changeIndexes = [];
  for (let index = 0; index < operations.length; index += 1) {
    if (operations[index].kind !== "context") changeIndexes.push(index);
  }
  if (changeIndexes.length === 0) return { additions: 0, removals: 0, hunks: [] };

  const contextLines = 3;
  const ranges = [];
  for (const index of changeIndexes) {
    const start = Math.max(0, index - contextLines);
    const end = Math.min(operations.length, index + contextLines + 1);
    const previous = ranges.at(-1);
    if (previous && start <= previous.end) previous.end = Math.max(previous.end, end);
    else ranges.push({ start, end });
  }

  const hunks = ranges.map(({ start, end }) => {
    const lines = operations.slice(start, end);
    const first = lines[0];
    const oldStart = first.oldLine ?? first.newLine ?? 1;
    const newStart = first.newLine ?? first.oldLine ?? 1;
    return { oldStart, newStart, lines };
  });
  return { additions, removals, hunks };
}

function patchSummaryText(summary, theme) {
  const parts = [];
  if (summary.additions > 0) {
    parts.push(`Added ${theme.bold(String(summary.additions))} ${summary.additions === 1 ? "line" : "lines"}`);
  }
  if (summary.removals > 0) {
    const label = parts.length === 0 ? "Removed" : "removed";
    parts.push(`${label} ${theme.bold(String(summary.removals))} ${summary.removals === 1 ? "line" : "lines"}`);
  }
  return parts.length > 0 ? parts.join(", ") : "Done";
}

function renderDiffLine(line, digits, theme) {
  const number = line.kind === "remove" ? line.oldLine : line.newLine;
  const numberText = number == null ? "".padStart(digits + 1) : String(number).padStart(digits + 1);
  const gutter = theme.fg("muted", `${numberText} `);
  if (line.kind === "add") {
    return `${gutter}${theme.fg("toolDiffAdded", `+${line.text}`)}`;
  }
  if (line.kind === "remove") {
    return `${gutter}${theme.fg("toolDiffRemoved", `-${line.text}`)}`;
  }
  return `${gutter}${theme.fg("toolDiffContext", ` ${line.text}`)}`;
}

function patchDiffDisplayLines(patchSummary, theme) {
  const lines = [];
  const multipleFiles = patchSummary.files.length > 1;
  patchSummary.files.forEach((file, fileIndex) => {
    if (multipleFiles) lines.push(theme.fg("muted", file.displayPath));
    if (file.hunks.length === 0) {
      if (file.unavailable) lines.push(theme.fg("muted", `[Diff unavailable: ${file.unavailable}]`));
      return;
    }
    file.hunks.forEach((hunk, hunkIndex) => {
      if (hunkIndex > 0) lines.push(theme.fg("muted", "..."));
      const maxLine = Math.max(
        ...hunk.lines.map((line) => line.oldLine ?? 0),
        ...hunk.lines.map((line) => line.newLine ?? 0),
        1,
      );
      const digits = String(maxLine).length;
      for (const line of hunk.lines) lines.push(renderDiffLine(line, digits, theme));
    });
    if (fileIndex < patchSummary.files.length - 1) lines.push(theme.fg("muted", "..."));
  });
  return lines;
}

function patchResultComponent(result, options, theme) {
  const details = result.details ?? {};
  if (!details.patchSummary || !isProcessSuccess(details)) {
    return shellResultComponent(result, options, theme);
  }
  return responseLinesComponent(() => {
    const lines = [patchSummaryText(details.patchSummary, theme)];
    const diffLines = patchDiffDisplayLines(details.patchSummary, theme);
    if (options.expanded) lines.push(...diffLines);
    else lines.push(...collapsedLines(diffLines, CLAUDE_DIFF_MAX_LINES, theme));
    if (details.combined && details.combined.trim() && details.combined.trim() !== "Done!") {
      lines.push(theme.fg("muted", details.combined.trim()));
    }
    return lines;
  }, theme);
}

function ensurePatchEnvelope(patchText) {
  const trimmed = String(patchText ?? "").trim();
  if (!trimmed.startsWith("*** Begin Patch") || !trimmed.endsWith("*** End Patch")) {
    throw new Error("apply_patch input must begin with `*** Begin Patch` and end with `*** End Patch`");
  }
  return `${trimmed}\n`;
}

function getGlobalSettingsPath() {
  return path.join(getAgentDir(), "settings.json");
}

function getToolsConfigPath() {
  return path.join(getAgentDir(), "tools.json");
}

function getProjectSettingsPath(cwd) {
  return path.join(cwd, CONFIG_DIR_NAME, "settings.json");
}

function normalizeToolNameList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flatMap((name) => (typeof name === "string" && name.trim() !== "" ? [name.trim()] : [])))];
}

async function readSettingsDocument(settingsPath) {
  try {
    const parsed = JSON.parse(await readFile(settingsPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("settings root must be a JSON object");
    }
    return parsed;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return {};
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read ${settingsPath}: ${message}`);
  }
}

async function readDefaultToolsSetting(settingsPath = getGlobalSettingsPath()) {
  const settings = await readSettingsDocument(settingsPath);
  if (!Object.prototype.hasOwnProperty.call(settings, "defaultTools")) {
    return { settings, defaultTools: undefined };
  }
  if (!Array.isArray(settings.defaultTools)) {
    throw new Error(`${settingsPath}: defaultTools must be an array of tool names`);
  }
  return { settings, defaultTools: normalizeToolNameList(settings.defaultTools) };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireSettingsLock(settingsPath) {
  const lockPath = `${settingsPath}.lock`;
  const startedAt = Date.now();
  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      return async () => {
        await rm(lockPath, { recursive: true, force: true });
      };
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "EEXIST") throw error;
      try {
        const lockInfo = await stat(lockPath);
        if (Date.now() - lockInfo.mtimeMs > SETTINGS_LOCK_STALE_MS) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch (statError) {
        if (statError && typeof statError === "object" && statError.code === "ENOENT") continue;
      }
      if (Date.now() - startedAt >= SETTINGS_LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for settings lock: ${lockPath}`);
      }
      await delay(SETTINGS_LOCK_RETRY_MS);
    }
  }
}

async function writeDefaultToolsSetting(defaultTools, settingsPath = getGlobalSettingsPath()) {
  await mkdir(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
  const release = await acquireSettingsLock(settingsPath);
  try {
    const settings = await readSettingsDocument(settingsPath);
    if (defaultTools === undefined) delete settings.defaultTools;
    else settings.defaultTools = normalizeToolNameList(defaultTools);
    await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    return defaultTools === undefined ? undefined : [...settings.defaultTools];
  } finally {
    await release();
  }
}

async function readPermanentlyDisabledTools(configPath = getToolsConfigPath()) {
  try {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new Error("config root must be a JSON object");
    }
    if (!Array.isArray(config.permanentlyDisabledTools)) {
      throw new Error("permanentlyDisabledTools must be an array");
    }
    return normalizeToolNameList(config.permanentlyDisabledTools);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return [];
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read ${configPath}: ${message}`);
  }
}

async function writePermanentlyDisabledTools(names, configPath = getToolsConfigPath()) {
  await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  const release = await acquireSettingsLock(configPath);
  try {
    const permanentlyDisabledTools = normalizeToolNameList(names).sort((a, b) => a.localeCompare(b, "en"));
    await writeFile(
      configPath,
      `${JSON.stringify({ version: 1, permanentlyDisabledTools }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    return permanentlyDisabledTools;
  } finally {
    await release();
  }
}

function getAllManagedTools(pi) {
  const byName = new Map();
  for (const tool of pi.getAllTools?.() ?? []) {
    if (!tool || typeof tool.name !== "string" || tool.name.trim() === "") continue;
    byName.set(tool.name, {
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : "",
      isBuiltin: tool.sourceInfo?.source === "builtin",
    });
  }
  return [...byName.values()].sort((left, right) => {
    if (left.isBuiltin !== right.isBuiltin) return left.isBuiltin ? -1 : 1;
    return left.name.localeCompare(right.name, "en");
  });
}

function getBuiltinTools(pi) {
  const byName = new Map();
  for (const tool of pi.getAllTools?.() ?? []) {
    if (!tool || typeof tool.name !== "string" || tool.sourceInfo?.source !== "builtin") continue;
    byName.set(tool.name, {
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : "",
    });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, "en"));
}

function equalToolLists(left, right) {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

function setActiveToolsIfChanged(pi, names) {
  const current = pi.getActiveTools?.() ?? [];
  if (!equalToolLists(current, names)) pi.setActiveTools(names);
  return names;
}

function applyBuiltinSelection(pi, builtins, enabledBuiltinNames) {
  const builtinNames = new Set(builtins.map((tool) => tool.name));
  const enabled = new Set(enabledBuiltinNames);
  const next = [];
  const seen = new Set();

  for (const name of pi.getActiveTools?.() ?? []) {
    if (builtinNames.has(name)) continue;
    if (!seen.has(name)) {
      seen.add(name);
      next.push(name);
    }
  }

  for (const tool of builtins) {
    if (enabled.has(tool.name) && !seen.has(tool.name)) {
      seen.add(tool.name);
      next.push(tool.name);
    }
  }

  return setActiveToolsIfChanged(pi, next);
}

function standardDefaultBuiltinNames(builtins) {
  const available = new Set(builtins.map((tool) => tool.name));
  return PI_STANDARD_DEFAULT_TOOLS.filter((name) => available.has(name));
}

function isChineseLocale() {
  const locale = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || "";
  return /^zh(?:[_\-.]|$)/i.test(locale);
}

function settingsCopy() {
  if (isChineseLocale()) {
    return {
      title: "工具管理",
      subtitle: "管理全部工具的会话状态、永久禁用状态和内置工具启动默认值。",
      enabled: "启用",
      disabled: "禁用（当前会话）",
      permanentlyDisabled: "禁用（永久）",
      run: "执行",
      saveCurrent: "将当前内置工具设为启动默认值",
      useDefaults: "恢复 Pi 标准默认值",
      disableAll: "禁用全部内置工具",
      enableAll: "启用全部内置工具",
      saveCurrentDescription: "把当前启用的内置工具写入全局 settings.json 的 defaultTools。",
      useDefaultsDescription: "删除全局 settings.json 中的 defaultTools，让 Pi 使用标准默认工具集。",
      disableAllDescription: "立即禁用全部内置工具，并把 defaultTools 写为空数组。",
      enableAllDescription: "立即启用全部内置工具，清除其永久禁用状态，并写入 defaultTools。",
      closeHint: "Esc：保存并关闭",
      noTools: "没有检测到可管理的工具。",
      requiresTui: "该设置界面只能在 Pi TUI 模式中打开。",
      saved: "工具设置已更新",
      readError: "读取 Pi settings.json 失败",
      saveError: "写入 Pi settings.json 失败",
      toolsReadError: "读取永久工具设置失败",
      toolsSaveError: "写入永久工具设置失败",
      projectOverride: "当前项目的 .pi/settings.json 含有 defaultTools，会在下次启动时覆盖全局值。",
      modeDefaults: "Pi 默认值",
      modeCustom: "全局自定义",
      status: (enabled, total, permanent, mode) =>
        `${enabled}/${total} 个工具已启用 · ${permanent} 个永久禁用 · 内置启动配置：${mode}`,
    };
  }
  return {
    title: "Tool configuration",
    subtitle: "Manage session state, permanent disables, and startup defaults for Pi built-in tools.",
    enabled: "Enabled",
    disabled: "Disabled (session)",
    permanentlyDisabled: "Disabled (permanent)",
    run: "Run",
    saveCurrent: "Use current built-ins as startup defaults",
    useDefaults: "Restore Pi standard defaults",
    disableAll: "Disable all built-ins",
    enableAll: "Enable all built-ins",
    saveCurrentDescription: "Write the currently enabled built-in tools to defaultTools in global settings.json.",
    useDefaultsDescription: "Remove defaultTools from global settings.json so Pi uses its standard built-in defaults.",
    disableAllDescription: "Disable all built-ins now and write an empty defaultTools array.",
    enableAllDescription: "Enable all built-ins now, clear their permanent disables, and write them to defaultTools.",
    closeHint: "Esc: save and close",
    noTools: "No tools were detected.",
    requiresTui: "This settings screen is available only in Pi TUI mode.",
    saved: "Tool settings updated",
    readError: "Failed to read Pi settings.json",
    saveError: "Failed to update Pi settings.json",
    toolsReadError: "Failed to read permanent tool settings",
    toolsSaveError: "Failed to update permanent tool settings",
    projectOverride: "This project's .pi/settings.json contains defaultTools and will override the global value on next startup.",
    modeDefaults: "Pi defaults",
    modeCustom: "Global custom",
    status: (enabled, total, permanent, mode) =>
      `${enabled}/${total} tools enabled · ${permanent} permanently disabled · built-in startup: ${mode}`,
  };
}

class ToolSettingsComponent {
  constructor(settingsList, tui, headerProvider) {
    this.settingsList = settingsList;
    this.tui = tui;
    this.headerProvider = headerProvider;
  }

  render(width) {
    const safeWidth = Math.max(1, Math.floor(width));
    const header = this.headerProvider().map((line) => truncateToWidth(line, safeWidth, "…"));
    return [...header, "", ...this.settingsList.render(safeWidth)];
  }

  handleInput(data) {
    this.settingsList.handleInput?.(data);
    this.tui.requestRender?.();
  }

  invalidate() {
    this.settingsList.invalidate?.();
  }
}

export default function piOnlyTools(pi) {
  pi.registerTool({
    name: "shell_command",
    label: "Bash",
    description:
      "Run a shell command and return its output. Use this to inspect files, search code, run builds/tests, and perform non-editing workspace operations. The command runs synchronously and defaults to a 10-second timeout.",
    promptSnippet: "Run shell commands to inspect the workspace and execute builds or tests",
    promptGuidelines: [
      "Use shell_command for reading files, searching code, checking git state, and running builds or tests.",
      "Use apply_patch for file modifications instead of shell redirection, sed -i, or generated scripts whenever practical.",
      "Set workdir when a command should run outside the current Pi working directory.",
    ],
    parameters: shellCommandSchema,
    prepareArguments: prepareShellArguments,
    executionMode: "sequential",
    renderShell: "self",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const cwd = resolveWorkdir(ctx.cwd, params.workdir);
      const timeoutMs = params.timeout_ms ?? SHELL_DEFAULT_TIMEOUT_MS;
      const invocation = shellInvocation(params.command);
      const details = await runCapturedProcess({
        kind: "shell",
        executable: invocation.executable,
        args: invocation.args,
        cwd,
        stdin: undefined,
        timeoutMs,
        signal,
        onUpdate,
        detailExtras: {
          command: params.command,
          timeoutMs,
        },
      });
      return {
        content: [{ type: "text", text: finalProcessContent(details, "(No output)") }],
        details,
      };
    },
    renderCall(args, theme) {
      return claudeCallComponent("Bash", commandPreview(args?.command), theme);
    },
    renderResult(result, options, theme) {
      return shellResultComponent(result, options, theme);
    },
  });

  pi.registerTool({
    name: "apply_patch",
    label: "Update",
    description:
      "Apply a structured patch by invoking the local `apply_patch` command. Pass the entire patch in `patch`, beginning with `*** Begin Patch` and ending with `*** End Patch`. Supports Add File, Update File, Delete File, and Move to operations.",
    promptSnippet: "Create, update, move, or delete files with apply_patch",
    promptGuidelines: [
      "Use apply_patch for all ordinary file edits.",
      "The patch string must include the complete `*** Begin Patch` and `*** End Patch` envelope.",
      "Keep each patch focused and verify important changes with shell_command afterwards.",
    ],
    parameters: applyPatchSchema,
    prepareArguments: preparePatchArguments,
    executionMode: "sequential",
    renderShell: "self",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const cwd = resolveWorkdir(ctx.cwd, params.workdir);
      const patch = ensurePatchEnvelope(params.patch);
      const metadata = parseApplyPatchMetadata(patch, cwd);
      await assertDirectoryExists(cwd);
      const beforeSnapshots = await snapshotPatchBefore(metadata);
      const timeoutMs = params.timeout_ms ?? PATCH_DEFAULT_TIMEOUT_MS;
      const executable = process.env.PI_ONLY_TOOLS_APPLY_PATCH_COMMAND || "apply_patch";
      const details = await runCapturedProcess({
        kind: "patch",
        executable,
        args: [],
        cwd,
        stdin: patch,
        timeoutMs,
        signal,
        onUpdate,
        detailExtras: {
          timeoutMs,
          patchMetadata: metadata,
        },
      });
      if (isProcessSuccess(details)) {
        details.patchSummary = await buildPatchChanges(metadata, beforeSnapshots);
      }
      return {
        content: [{ type: "text", text: finalProcessContent(details, "Done") }],
        details,
      };
    },
    renderCall(args, theme, context) {
      const cwd = resolveWorkdir(context.cwd, args?.workdir);
      const metadata = parseApplyPatchMetadata(args?.patch ?? "", cwd);
      return claudeCallComponent(patchCallName(metadata), patchCallValue(metadata), theme);
    },
    renderResult(result, options, theme) {
      return patchResultComponent(result, options, theme);
    },
  });

  let enabledTools = new Set();
  let permanentlyDisabledTools = new Set();
  let managedTools = [];

  const applyManagedTools = () => {
    const available = new Set(managedTools.map((tool) => tool.name));
    const next = [...enabledTools].filter(
      (name) => available.has(name) && !permanentlyDisabledTools.has(name),
    );
    return setActiveToolsIfChanged(pi, next);
  };

  const persistSessionState = () => {
    pi.appendEntry?.(TOOLS_STATE_ENTRY, { enabledTools: [...enabledTools] });
  };

  const restoreToolState = async (ctx) => {
    const copy = settingsCopy();
    managedTools = getAllManagedTools(pi);
    try {
      permanentlyDisabledTools = new Set(await readPermanentlyDisabledTools());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`${copy.toolsReadError}: ${message}`, "error");
      permanentlyDisabledTools = new Set();
    }

    let savedTools;
    for (const entry of ctx.sessionManager?.getBranch?.() ?? []) {
      if (entry.type !== "custom" || entry.customType !== TOOLS_STATE_ENTRY) continue;
      if (Array.isArray(entry.data?.enabledTools)) savedTools = normalizeToolNameList(entry.data.enabledTools);
    }

    const available = new Set(managedTools.map((tool) => tool.name));
    enabledTools = new Set(
      (savedTools ?? pi.getActiveTools?.() ?? []).filter((name) => available.has(name)),
    );
    applyManagedTools();
  };

  pi.on?.("session_start", async (_event, ctx) => restoreToolState(ctx));
  pi.on?.("session_tree", async (_event, ctx) => restoreToolState(ctx));
  pi.on?.("before_agent_start", async (_event, ctx) => {
    const copy = settingsCopy();
    try {
      permanentlyDisabledTools = new Set(await readPermanentlyDisabledTools());
      const active = pi.getActiveTools?.() ?? [];
      setActiveToolsIfChanged(pi, active.filter((name) => !permanentlyDisabledTools.has(name)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`${copy.toolsReadError}: ${message}`, "error");
    }
  });

  const openSettings = async (ctx) => {
    const copy = settingsCopy();
    if (ctx.mode !== "tui") {
      ctx.ui.notify(copy.requiresTui, "warning");
      return;
    }

    const builtins = getBuiltinTools(pi);
    managedTools = getAllManagedTools(pi);
    if (managedTools.length === 0) {
      ctx.ui.notify(copy.noTools, "warning");
      return;
    }

    for (const name of pi.getActiveTools?.() ?? []) enabledTools.add(name);

    try {
      permanentlyDisabledTools = new Set(await readPermanentlyDisabledTools());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`${copy.toolsReadError}: ${message}`, "error");
      return;
    }

    const globalSettingsPath = getGlobalSettingsPath();
    let globalSelection;
    try {
      globalSelection = await readDefaultToolsSetting(globalSettingsPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`${copy.readError}: ${message}`, "error");
      return;
    }

    let projectOverridesGlobal = false;
    try {
      const projectSelection = await readDefaultToolsSetting(getProjectSettingsPath(ctx.cwd));
      projectOverridesGlobal = projectSelection.defaultTools !== undefined;
    } catch {
      // The global editor still works even when an unrelated project settings file is malformed.
    }

    const detectedNames = new Set(builtins.map((tool) => tool.name));
    let usePiDefaults = globalSelection.defaultTools === undefined;
    let unknownConfiguredNames = usePiDefaults
      ? []
      : globalSelection.defaultTools.filter((name) => !detectedNames.has(name));
    let enabledBuiltins = new Set(
      usePiDefaults
        ? standardDefaultBuiltinNames(builtins)
        : globalSelection.defaultTools.filter((name) => detectedNames.has(name)),
    );
    let dirty = false;
    let saveFailed = false;
    let settingsSaveQueue = Promise.resolve();
    let toolsSaveQueue = Promise.resolve();

    const scheduleSettingsSave = (selection) => {
      const snapshot = selection === undefined
        ? undefined
        : [...new Set([...unknownConfiguredNames, ...selection])].sort((a, b) => a.localeCompare(b, "en"));
      settingsSaveQueue = settingsSaveQueue
        .then(() => writeDefaultToolsSetting(snapshot, globalSettingsPath))
        .catch((error) => {
          saveFailed = true;
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`${copy.saveError}: ${message}`, "error");
        });
      return settingsSaveQueue;
    };

    const scheduleToolsSave = () => {
      const snapshot = [...permanentlyDisabledTools];
      toolsSaveQueue = toolsSaveQueue
        .then(() => writePermanentlyDisabledTools(snapshot))
        .catch((error) => {
          saveFailed = true;
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`${copy.toolsSaveError}: ${message}`, "error");
        });
      return toolsSaveQueue;
    };

    await ctx.ui.custom((tui, theme, _keybindings, done) => {
      let settingsList;
      const valuesFor = (name) => {
        if (permanentlyDisabledTools.has(name)) return copy.permanentlyDisabled;
        return enabledTools.has(name) ? copy.enabled : copy.disabled;
      };
      const items = [
        {
          id: ACTION_SAVE_CURRENT,
          label: copy.saveCurrent,
          currentValue: copy.run,
          values: [copy.run],
          description: copy.saveCurrentDescription,
        },
        {
          id: ACTION_USE_PI_DEFAULTS,
          label: copy.useDefaults,
          currentValue: copy.run,
          values: [copy.run],
          description: copy.useDefaultsDescription,
        },
        {
          id: ACTION_DISABLE_ALL,
          label: copy.disableAll,
          currentValue: copy.run,
          values: [copy.run],
          description: copy.disableAllDescription,
        },
        {
          id: ACTION_ENABLE_ALL,
          label: copy.enableAll,
          currentValue: copy.run,
          values: [copy.run],
          description: copy.enableAllDescription,
        },
        ...managedTools.map((tool) => ({
          id: `${TOOL_ITEM_PREFIX}${tool.name}`,
          label: tool.name,
          currentValue: valuesFor(tool.name),
          values: [copy.enabled, copy.disabled, copy.permanentlyDisabled],
          description: tool.description,
        })),
      ];

      const updateAllRows = () => {
        for (const tool of managedTools) {
          settingsList.updateValue(`${TOOL_ITEM_PREFIX}${tool.name}`, valuesFor(tool.name));
        }
      };

      const commitChange = ({ savePermanent = false, saveSession = true } = {}) => {
        dirty = true;
        applyManagedTools();
        if (saveSession) persistSessionState();
        if (savePermanent) void scheduleToolsSave();
        tui.requestRender?.();
      };

      const onChange = (id, newValue) => {
        if (id === ACTION_SAVE_CURRENT) {
          usePiDefaults = false;
          enabledBuiltins = new Set(
            builtins
              .map((tool) => tool.name)
              .filter((name) => enabledTools.has(name) && !permanentlyDisabledTools.has(name)),
          );
          void scheduleSettingsSave(enabledBuiltins);
          commitChange({ saveSession: false });
          return;
        }
        if (id === ACTION_USE_PI_DEFAULTS) {
          usePiDefaults = true;
          unknownConfiguredNames = [];
          enabledBuiltins = new Set(standardDefaultBuiltinNames(builtins));
          const builtinNames = new Set(builtins.map((tool) => tool.name));
          enabledTools = new Set([...enabledTools].filter((name) => !builtinNames.has(name)));
          for (const name of enabledBuiltins) enabledTools.add(name);
          updateAllRows();
          void scheduleSettingsSave(undefined);
          commitChange();
          return;
        }
        if (id === ACTION_DISABLE_ALL) {
          usePiDefaults = false;
          unknownConfiguredNames = [];
          enabledBuiltins = new Set();
          const builtinNames = new Set(builtins.map((tool) => tool.name));
          enabledTools = new Set([...enabledTools].filter((name) => !builtinNames.has(name)));
          updateAllRows();
          void scheduleSettingsSave(enabledBuiltins);
          commitChange();
          return;
        }
        if (id === ACTION_ENABLE_ALL) {
          usePiDefaults = false;
          unknownConfiguredNames = [];
          enabledBuiltins = new Set(builtins.map((tool) => tool.name));
          for (const name of enabledBuiltins) {
            enabledTools.add(name);
            permanentlyDisabledTools.delete(name);
          }
          updateAllRows();
          void scheduleSettingsSave(enabledBuiltins);
          commitChange({ savePermanent: true });
          return;
        }
        if (!id.startsWith(TOOL_ITEM_PREFIX)) return;

        const name = id.slice(TOOL_ITEM_PREFIX.length);
        if (newValue === copy.enabled) {
          permanentlyDisabledTools.delete(name);
          enabledTools.add(name);
        } else if (newValue === copy.disabled) {
          permanentlyDisabledTools.delete(name);
          enabledTools.delete(name);
        } else {
          permanentlyDisabledTools.add(name);
          enabledTools.delete(name);
        }
        commitChange({ savePermanent: true });
      };

      const close = () => {
        void Promise.all([settingsSaveQueue, toolsSaveQueue]).finally(() => done(undefined));
      };

      settingsList = new SettingsList(
        items,
        Math.min(16, Math.max(8, items.length)),
        getSettingsListTheme(),
        onChange,
        close,
        { enableSearch: true },
      );

      return new ToolSettingsComponent(settingsList, tui, () => {
        const mode = usePiDefaults ? copy.modeDefaults : copy.modeCustom;
        const lines = [
          theme.bold(copy.title),
          theme.fg("dim", copy.subtitle),
          theme.fg(
            "muted",
            `${copy.status(
              [...enabledTools].filter((name) => !permanentlyDisabledTools.has(name)).length,
              managedTools.length,
              permanentlyDisabledTools.size,
              mode,
            )} · ${globalSettingsPath}`,
          ),
        ];
        if (projectOverridesGlobal) lines.push(theme.fg("warning", copy.projectOverride));
        lines.push(theme.fg("muted", copy.closeHint));
        return lines;
      });
    });

    await Promise.all([settingsSaveQueue, toolsSaveQueue]);
    if (dirty && !saveFailed) ctx.ui.notify(copy.saved, "info");
  };

  pi.registerCommand("only-tools", {
    description: "Manage active tools, permanent disables, and built-in startup defaults",
    handler: async (_args, ctx) => openSettings(ctx),
  });
  pi.registerCommand("pi-only-tools", {
    description: "Alias for /only-tools",
    handler: async (_args, ctx) => openSettings(ctx),
  });

}

export const __test = {
  ONLY_TOOLS,
  PI_STANDARD_DEFAULT_TOOLS,
  applyBuiltinSelection,
  getAllManagedTools,
  getBuiltinTools,
  getGlobalSettingsPath,
  getProjectSettingsPath,
  getToolsConfigPath,
  normalizeToolNameList,
  readDefaultToolsSetting,
  readPermanentlyDisabledTools,
  standardDefaultBuiltinNames,
  writeDefaultToolsSetting,
  writePermanentlyDisabledTools,
  buildLineDiff,
  commandPreview,
  parseApplyPatchMetadata,
  preparePatchArguments,
  prepareShellArguments,
};

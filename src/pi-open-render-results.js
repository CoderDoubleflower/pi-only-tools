import os from "node:os";
import path from "node:path";

import {
  BASH_PROGRESS_LINES,
  BASH_RESULT_LINES,
  EXPAND_HINT,
  PATCH_DIFF_MAX_LINES,
  detailsOf,
  isObject,
  isProcessSuccess,
  processStatusLine,
  stripAnsi,
  textOutput,
} from "./pi-open-render-core.js";

function displayPath(filePath, cwd) {
  if (!filePath) return "";
  const absolute = path.isAbsolute(filePath) ? path.normalize(filePath) : path.resolve(cwd, filePath);
  const relative = path.relative(cwd, absolute);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return relative;
  const homeRelative = path.relative(os.homedir(), absolute);
  return homeRelative && !homeRelative.startsWith("..") && !path.isAbsolute(homeRelative)
    ? `~${path.sep}${homeRelative}`
    : filePath;
}

export function patchUse(patchText, cwd) {
  const files = [];
  let current;
  for (const line of String(patchText ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    const file = line.match(/^\*\*\* (Add|Update|Delete) File:\s*(.+?)\s*$/);
    if (file) {
      current = { operation: file[1].toLowerCase(), path: file[2], moveTo: undefined };
      files.push(current);
      continue;
    }
    const move = current && line.match(/^\*\*\* Move to:\s*(.+?)\s*$/);
    if (move) current.moveTo = move[1];
  }
  files.forEach((file) => {
    file.displayPath = displayPath(file.moveTo || file.path, cwd);
  });
  const detail = files.length === 0 ? "patch" : files.length === 1 ? files[0].displayPath : `${files.length} files`;
  if (files.length !== 1) return { name: "Update", detail };
  return {
    name: files[0].operation === "add" ? "Create" : files[0].operation === "delete" ? "Delete" : "Update",
    detail,
  };
}

function splitLines(value, keepEmpty = true) {
  const normalized = stripAnsi(String(value ?? ""))
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trimEnd();
  if (!normalized) return [];
  const lines = normalized.split("\n");
  return keepEmpty ? lines : lines.filter(Boolean);
}

function shellOutput(result) {
  const details = detailsOf(result);
  const chunks = [details.stdout, details.stderr]
    .filter((value) => typeof value === "string" && value.length > 0)
    .map((value) => value.replace(/\r\n?/g, "\n").trimEnd())
    .filter(Boolean);
  if (chunks.length > 0) return chunks.join("\n");
  return typeof details.combined === "string" ? details.combined : "";
}

function collapse(lines, limit) {
  if (lines.length <= limit + 1) return lines;
  return [...lines.slice(0, limit), `… +${lines.length - limit} lines ${EXPAND_HINT}`];
}

function resultStatus(result, options, context) {
  const details = detailsOf(result);
  if (options?.isPartial === true || details.status === "running") return "running";
  return context.isError === true || result?.isError === true || !isProcessSuccess(details)
    ? "error"
    : "success";
}

function errorLines(result, expanded, useContentFallback, fallback) {
  const details = detailsOf(result);
  const output = shellOutput(result) || (useContentFallback ? textOutput(result) : "");
  const lines = splitLines(output);
  const visible = expanded ? lines : collapse(lines, BASH_RESULT_LINES);
  const status = processStatusLine(details);
  if (status && visible.at(-1) !== status) visible.push(status);
  return visible.length > 0 ? visible : [status || fallback];
}

function patchSummary(summary) {
  const additions = Number.isFinite(summary?.additions) ? summary.additions : 0;
  const removals = Number.isFinite(summary?.removals) ? summary.removals : 0;
  const parts = [];
  if (additions > 0) parts.push(`Added ${additions} ${additions === 1 ? "line" : "lines"}`);
  if (removals > 0) {
    parts.push(`${parts.length > 0 ? "removed" : "Removed"} ${removals} ${removals === 1 ? "line" : "lines"}`);
  }
  return parts.length > 0 ? parts.join(", ") : "Updated file";
}

function patchLine(line, digits) {
  const number = line?.kind === "remove" ? line.oldLine : line?.newLine ?? line?.oldLine;
  const numberText = Number.isInteger(number)
    ? String(number).padStart(digits + 1)
    : "".padStart(digits + 1);
  const marker = line?.kind === "add" ? "+" : line?.kind === "remove" ? "-" : " ";
  return `${numberText} ${marker}${line?.text ?? ""}`;
}

function patchDiff(summary) {
  const files = Array.isArray(summary?.files) ? summary.files : [];
  const lines = [];
  files.forEach((file, fileIndex) => {
    if (files.length > 1 && file?.displayPath) lines.push(String(file.displayPath));
    const hunks = Array.isArray(file?.hunks) ? file.hunks : [];
    if (hunks.length === 0 && file?.unavailable) lines.push(`[Diff unavailable: ${file.unavailable}]`);
    hunks.forEach((hunk, hunkIndex) => {
      if (hunkIndex > 0) lines.push("...");
      const hunkLines = Array.isArray(hunk?.lines) ? hunk.lines : [];
      const maxLine = Math.max(
        ...hunkLines.map((line) => line?.oldLine ?? 0),
        ...hunkLines.map((line) => line?.newLine ?? 0),
        1,
      );
      const digits = String(maxLine).length;
      for (const line of hunkLines) lines.push(patchLine(line, digits));
    });
    if (fileIndex < files.length - 1) lines.push("...");
  });
  return lines;
}

export function formatResult(kind, result, options = {}, context = {}) {
  const status = resultStatus(result, options, context);
  const expanded = options.expanded === true;
  if (kind === "bash") {
    if (status === "error") return { status, lines: errorLines(result, expanded, false, "Tool failed") };
    const lines = splitLines(shellOutput(result), status !== "running");
    if (status === "running") {
      if (lines.length === 0) return { status, lines: ["Running…"] };
      if (expanded) return { status, lines };
      const visible = lines.slice(-BASH_PROGRESS_LINES);
      return { status, lines: lines.length > visible.length ? [...visible, `+${lines.length - visible.length} lines`] : visible };
    }
    return { status, lines: lines.length === 0 ? ["(No output)"] : expanded ? lines : collapse(lines, BASH_RESULT_LINES) };
  }
  if (status === "running") return { status, lines: [] };
  if (status === "error") return { status, lines: errorLines(result, expanded, true, "Error applying patch") };
  const details = detailsOf(result);
  const summary = details.patchSummary;
  if (!isObject(summary)) return { status, lines: ["Updated file"] };
  const diff = patchDiff(summary);
  const visibleDiff = expanded ? diff : collapse(diff, PATCH_DIFF_MAX_LINES);
  const combined = splitLines(details.combined);
  const processLines = combined.length === 1 && combined[0] === "Done!" ? [] : combined;
  return { status, lines: [patchSummary(summary), ...visibleDiff, ...processLines] };
}

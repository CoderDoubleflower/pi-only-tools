// Keep these values aligned with openai/codex:
// - codex-rs/utils/pty/src/lib.rs::DEFAULT_OUTPUT_BYTES_CAP
// - current Codex model metadata truncation_policy (10,000 tokens)
export const CODEX_CAPTURE_MAX_BYTES = 1024 * 1024;
export const CODEX_TOOL_OUTPUT_TOKEN_LIMIT = 10_000;
export const CODEX_APPROX_BYTES_PER_TOKEN = 4;

const TUI_STREAM_PREVIEW_MAX_BYTES = 16 * 1024;
const TUI_PARTIAL_PREVIEW_MAX_BYTES = 8 * 1024;
const MAX_TUI_PREVIEW_LINES = 40;

export class HeadByteCapture {
  constructor(maxBytes = CODEX_CAPTURE_MAX_BYTES) {
    this.maxBytes = maxBytes;
    this.chunks = [];
    this.capturedBytes = 0;
    this.totalBytes = 0;
  }

  append(chunk) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (buffer.length === 0) return;
    this.totalBytes += buffer.length;
    if (this.capturedBytes >= this.maxBytes) return;
    const remaining = this.maxBytes - this.capturedBytes;
    const retained = buffer.subarray(0, Math.min(remaining, buffer.length));
    if (retained.length > 0) {
      this.chunks.push(Buffer.from(retained));
      this.capturedBytes += retained.length;
    }
  }

  toBuffer() {
    return Buffer.concat(this.chunks, this.capturedBytes);
  }
}

export class TailByteCapture {
  constructor(maxBytes = TUI_PARTIAL_PREVIEW_MAX_BYTES) {
    this.maxBytes = maxBytes;
    this.buffer = Buffer.alloc(0);
  }

  append(chunk) {
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (next.length === 0 || this.maxBytes === 0) return;
    if (next.length >= this.maxBytes) {
      this.buffer = Buffer.from(next.subarray(next.length - this.maxBytes));
      return;
    }
    const combined = Buffer.concat([this.buffer, next]);
    this.buffer =
      combined.length <= this.maxBytes
        ? combined
        : combined.subarray(combined.length - this.maxBytes);
  }

  toString() {
    return decodeUtf8Lossy(trimLeadingUtf8Continuation(this.buffer));
  }
}

// Retain the actual beginning and end while keeping each stream's storage bounded.
export class HeadTailByteCapture {
  constructor(maxBytes = CODEX_CAPTURE_MAX_BYTES) {
    this.maxBytes = Math.max(0, Math.floor(maxBytes));
    this.head = new HeadByteCapture(Math.ceil(this.maxBytes / 2));
    this.tail = new TailByteCapture(Math.floor(this.maxBytes / 2));
    this.totalBytes = 0;
    this.newlineCount = 0;
    this.lastByte = undefined;
  }

  get capturedBytes() {
    return Math.min(this.totalBytes, this.maxBytes);
  }

  append(chunk) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (buffer.length === 0) return;
    this.totalBytes += buffer.length;
    for (const byte of buffer) if (byte === 10) this.newlineCount += 1;
    this.lastByte = buffer[buffer.length - 1];
    this.head.append(buffer);
    this.tail.append(buffer);
  }

  toBuffer() {
    const head = this.head.toBuffer();
    const tail = this.tail.buffer;
    if (this.totalBytes <= this.maxBytes) {
      const overlap = Math.max(0, head.length + tail.length - this.totalBytes);
      return Buffer.concat([head, tail.subarray(overlap)]);
    }
    return Buffer.concat([trimIncompleteUtf8Suffix(head), trimLeadingUtf8Continuation(tail)]);
  }
}

function trimIncompleteUtf8Suffix(buffer) {
  if (buffer.length === 0) return buffer;
  let start = buffer.length - 1;
  while (start > 0 && (buffer[start] & 0xc0) === 0x80) start -= 1;
  const first = buffer[start];
  const size = first >= 0xf0 ? 4 : first >= 0xe0 ? 3 : first >= 0xc0 ? 2 : 1;
  return buffer.length - start < size ? buffer.subarray(0, start) : buffer;
}

function trimLeadingUtf8Continuation(buffer) {
  let start = 0;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start);
}

export function decodeUtf8Lossy(buffer) {
  return buffer.toString("utf8");
}

export function countLinesLikeRust(text) {
  if (!text) return 0;
  let lines = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10 && index < text.length - 1) lines += 1;
  }
  return lines;
}

export function approxTokenCount(text) {
  return Math.ceil(Buffer.byteLength(String(text ?? ""), "utf8") / CODEX_APPROX_BYTES_PER_TOKEN);
}

function prefixBoundary(buffer, target) {
  let end = Math.min(Math.max(0, target), buffer.length);
  while (end > 0 && end < buffer.length && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return end;
}

function suffixBoundary(buffer, target) {
  let start = Math.min(Math.max(0, target), buffer.length);
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
  return start;
}

export function truncateMiddleWithTokenBudget(
  text,
  maxTokens = CODEX_TOOL_OUTPUT_TOKEN_LIMIT,
) {
  const content = String(text ?? "");
  const buffer = Buffer.from(content, "utf8");
  const maxBytes = Math.max(0, Math.floor(maxTokens)) * CODEX_APPROX_BYTES_PER_TOKEN;
  const originalTokenCount = Math.ceil(buffer.length / CODEX_APPROX_BYTES_PER_TOKEN);

  if (buffer.length <= maxBytes) {
    return {
      text: content,
      truncated: false,
      originalTokenCount,
      removedTokenCount: 0,
    };
  }

  if (maxBytes === 0) {
    return {
      text: `…${originalTokenCount} tokens truncated…`,
      truncated: true,
      originalTokenCount,
      removedTokenCount: originalTokenCount,
    };
  }

  const leftBudget = Math.floor(maxBytes / 2);
  const rightBudget = maxBytes - leftBudget;
  const prefixEnd = prefixBoundary(buffer, leftBudget);
  const suffixStart = Math.max(prefixEnd, suffixBoundary(buffer, buffer.length - rightBudget));
  const removedTokenCount = Math.ceil(
    Math.max(0, buffer.length - maxBytes) / CODEX_APPROX_BYTES_PER_TOKEN,
  );
  const marker = `…${removedTokenCount} tokens truncated…`;
  const prefix = decodeUtf8Lossy(buffer.subarray(0, prefixEnd));
  const suffix = decodeUtf8Lossy(buffer.subarray(suffixStart));

  return {
    text: `${prefix}${marker}${suffix}`,
    truncated: true,
    originalTokenCount,
    removedTokenCount,
  };
}

export function aggregateCodexOutput(
  stdout,
  stderr,
  maxBytes = CODEX_CAPTURE_MAX_BYTES,
) {
  const stdoutBuffer = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? "");
  const stderrBuffer = Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? "");
  const limit = Math.max(0, Math.floor(maxBytes));
  const totalLength = stdoutBuffer.length + stderrBuffer.length;

  if (totalLength <= limit) return Buffer.concat([stdoutBuffer, stderrBuffer], totalLength);
  if (limit === 0) return Buffer.alloc(0);

  const [stdoutTake, stderrTake] = allocateOutputBytes(stdoutBuffer.length, stderrBuffer.length, limit);

  return Buffer.concat(
    [retainBufferEnds(stdoutBuffer, stdoutTake), retainBufferEnds(stderrBuffer, stderrTake)],
  );
}

function allocateOutputBytes(stdoutLength, stderrLength, limit) {
  // Reserve 1/3 for stdout and 2/3 for stderr, returning unused capacity.
  const wantedStdout = Math.min(stdoutLength, Math.floor(limit / 3));
  const stderrTake = Math.min(stderrLength, limit - wantedStdout);
  return [Math.min(stdoutLength, limit - stderrTake), stderrTake];
}

function retainBufferEnds(buffer, limit) {
  if (buffer.length <= limit) return buffer;
  const head = prefixBoundary(buffer, Math.ceil(limit / 2));
  const tail = suffixBoundary(buffer, buffer.length - Math.floor(limit / 2));
  return Buffer.concat([buffer.subarray(0, head), buffer.subarray(tail)]);
}

export function formatCapturedOutputForModel(details, stdout, stderr) {
  // Budget each stream separately so a large stderr cannot hide stdout's final
  // diagnostic, or vice versa. Reserve space for truncation notices and status.
  const budget = (CODEX_TOOL_OUTPUT_TOKEN_LIMIT - 64) * CODEX_APPROX_BYTES_PER_TOKEN;
  const [stdoutBudget, stderrBudget] = allocateOutputBytes(stdout.length, stderr.length, budget);
  // Round up so a stream that fits its byte budget keeps its final partial token.
  // The reserved margin also covers the at most three extra bytes per stream.
  const out = truncateMiddleWithTokenBudget(
    decodeUtf8Lossy(stdout), Math.ceil(stdoutBudget / CODEX_APPROX_BYTES_PER_TOKEN),
  );
  const err = truncateMiddleWithTokenBudget(
    decodeUtf8Lossy(stderr), Math.ceil(stderrBudget / CODEX_APPROX_BYTES_PER_TOKEN),
  );
  const omitted = Math.max(0, (details.totalOutputBytes ?? 0) - stdout.length - stderr.length);
  const notice = omitted > 0
    ? `[Capture omitted ${omitted} bytes; beginning and end of each stream retained.]\n`
    : "";
  return formatExecOutputForModel({
    ...details,
    outputTruncated: omitted > 0 || out.truncated || err.truncated,
  }, notice + out.text + err.text);
}

function buildExecBody(details, aggregatedText) {
  if (details.timedOut) {
    return `command timed out after ${details.durationMs} milliseconds\n${aggregatedText}`;
  }
  return aggregatedText;
}

function modelExitCode(details) {
  if (Number.isInteger(details.exitCode)) return details.exitCode;
  if (details.aborted) return 1;
  return -1;
}

export function formatExecOutputForModel(
  details,
  aggregatedText,
  tokenLimit = CODEX_TOOL_OUTPUT_TOKEN_LIMIT,
) {
  const content = buildExecBody(details, aggregatedText);
  const totalLines = details.totalOutputLines ?? countLinesLikeRust(content);
  const truncated = truncateMiddleWithTokenBudget(content, tokenLimit);
  const outputTruncated = details.outputTruncated === true || truncated.truncated;
  const durationSeconds = Math.round((details.durationMs / 1000) * 10) / 10;
  const sections = [
    `Exit code: ${modelExitCode(details)}`,
    `Wall time: ${durationSeconds} seconds`,
  ];
  if (outputTruncated) sections.push(`Total output lines: ${totalLines}`);
  sections.push("Output:");
  sections.push(truncated.text);

  return {
    ...truncated,
    truncated: outputTruncated,
    originalTokenCount: details.totalOutputBytes === undefined
      ? truncated.originalTokenCount
      : Math.ceil(details.totalOutputBytes / CODEX_APPROX_BYTES_PER_TOKEN),
    text: sections.join("\n"),
    body: content,
    totalLines,
    truncatedText: truncated.text,
  };
}

export function truncatePreview(text, maxBytes) {
  const content = String(text ?? "");
  const buffer = Buffer.from(content, "utf8");
  if (buffer.length <= maxBytes) return content;

  const leftBudget = Math.floor(maxBytes / 2);
  const rightBudget = maxBytes - leftBudget;
  const prefixEnd = prefixBoundary(buffer, leftBudget);
  const suffixStart = Math.max(prefixEnd, suffixBoundary(buffer, buffer.length - rightBudget));
  const omitted = Math.max(0, buffer.length - maxBytes);
  return `${decodeUtf8Lossy(buffer.subarray(0, prefixEnd))}…${omitted} bytes omitted…${decodeUtf8Lossy(
    buffer.subarray(suffixStart),
  )}`;
}

export function lastLines(text, maxLines = MAX_TUI_PREVIEW_LINES) {
  const normalized = String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length <= maxLines) return normalized;
  return lines.slice(lines.length - maxLines).join("\n");
}

export function buildRenderDetails({
  command,
  cwd,
  timeoutMs,
  status,
  exitCode,
  signal,
  timedOut,
  aborted,
  spawnError,
  durationMs,
  stdoutBuffer = Buffer.alloc(0),
  stderrBuffer = Buffer.alloc(0),
  stdoutCapturedBytes = stdoutBuffer.length,
  stderrCapturedBytes = stderrBuffer.length,
  stdoutTotalBytes,
  stderrTotalBytes,
  modelResult,
  partialStdout,
  partialStderr,
}) {
  const stdout =
    status === "running"
      ? lastLines(partialStdout)
      : truncatePreview(decodeUtf8Lossy(stdoutBuffer), TUI_STREAM_PREVIEW_MAX_BYTES);
  const stderr =
    status === "running"
      ? lastLines(partialStderr)
      : truncatePreview(decodeUtf8Lossy(stderrBuffer), TUI_STREAM_PREVIEW_MAX_BYTES);
  const previewBytes = Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(stderr, "utf8");
  const totalOutputBytes = stdoutTotalBytes + stderrTotalBytes;

  return {
    kind: "shell",
    command,
    cwd,
    timeoutMs,
    status,
    exitCode,
    signal,
    timedOut,
    aborted,
    spawnError,
    durationMs,
    stdout,
    stderr,
    totalStdoutBytes: stdoutTotalBytes,
    totalStderrBytes: stderrTotalBytes,
    capturedStdoutBytes: stdoutCapturedBytes,
    capturedStderrBytes: stderrCapturedBytes,
    captureMaxBytes: CODEX_CAPTURE_MAX_BYTES,
    captureTruncated:
      stdoutTotalBytes > stdoutCapturedBytes || stderrTotalBytes > stderrCapturedBytes,
    modelOutputTokenLimit: CODEX_TOOL_OUTPUT_TOKEN_LIMIT,
    modelOutputTruncated: modelResult?.truncated ?? false,
    modelOutputOriginalTokens: modelResult?.originalTokenCount ?? 0,
    modelOutputBytes: modelResult ? Buffer.byteLength(modelResult.text, "utf8") : 0,
    droppedChars: Math.max(0, totalOutputBytes - previewBytes),
  };
}

export function partialContentText(stdout, stderr) {
  const combined = [stdout, stderr].filter(Boolean).join("\n");
  return truncatePreview(lastLines(combined), TUI_PARTIAL_PREVIEW_MAX_BYTES);
}

export const __test = {
  HeadByteCapture,
  HeadTailByteCapture,
  TailByteCapture,
  aggregateCodexOutput,
  approxTokenCount,
  buildRenderDetails,
  countLinesLikeRust,
  formatExecOutputForModel,
  lastLines,
  partialContentText,
  truncateMiddleWithTokenBudget,
  truncatePreview,
};

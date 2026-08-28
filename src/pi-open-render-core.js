export const DOT = "●";
export const RESPONSE = "⎿";
export const DIM = "\x1b[2m";
export const DIM_RESET = "\x1b[22m";
export const BACKGROUND_RESET = "\x1b[49m";
export const EXPAND_HINT = "(ctrl+o to expand)";
export const BASH_COMMAND_MAX_LINES = 2;
export const BASH_COMMAND_MAX_CHARS = 160;
export const BASH_PROGRESS_LINES = 5;
export const BASH_RESULT_LINES = 3;
export const PATCH_DIFF_MAX_LINES = 12;
export const EDIT_DIFF_ADDED_BACKGROUND = "\x1b[48;5;22m";
export const EDIT_DIFF_REMOVED_BACKGROUND = "\x1b[48;5;52m";

export class DynamicLinesComponent {
  constructor(renderLines) {
    this.renderLines = renderLines;
  }

  render(width) {
    return this.renderLines(Math.max(1, Math.floor(width)));
  }

  invalidate() {}
}

const defaultScheduler = {
  setInterval: (callback, delayMs) => setInterval(callback, delayMs),
  clearInterval: (handle) => clearInterval(handle),
};

export class ClaudeToolBlinkController {
  constructor(scheduler = defaultScheduler) {
    this.scheduler = scheduler;
    this.running = new Map();
    this.interval = undefined;
    this.lit = true;
  }

  isLit() {
    return this.lit;
  }

  runningCount() {
    return this.running.size;
  }

  sync(component, requestRender, running) {
    if (!running || typeof requestRender !== "function") {
      this.remove(component);
      return;
    }
    const first = this.running.size === 0;
    this.running.set(component, requestRender);
    if (!first) return;
    this.lit = true;
    this.interval = this.scheduler.setInterval(() => this.tick(), 600);
    this.interval?.unref?.();
  }

  remove(component) {
    if (!this.running.delete(component) || this.running.size > 0) return;
    this.stop();
    this.lit = true;
  }

  dispose() {
    this.running.clear();
    this.stop();
    this.lit = true;
  }

  tick() {
    this.lit = !this.lit;
    for (const requestRender of new Set(this.running.values())) {
      try {
        requestRender();
      } catch {
        // Ignore invalidation callbacks retained by a disposed TUI.
      }
    }
  }

  stop() {
    if (this.interval === undefined) return;
    this.scheduler.clearInterval(this.interval);
    this.interval = undefined;
  }
}

export function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function detailsOf(result) {
  return isObject(result?.details) ? result.details : {};
}

export function textOutput(result) {
  if (!Array.isArray(result?.content)) return "";
  return result.content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "")
    .trimEnd();
}

export function stripAnsi(text) {
  const value = String(text ?? "");
  let clean = "";
  for (let index = 0; index < value.length;) {
    const code = value.charCodeAt(index);
    if (code === 0x1b) {
      const kind = value[index + 1];
      if (kind === "[") {
        index = consumeCsi(value, index + 2);
        continue;
      }
      if ("]PX^_".includes(kind)) {
        index = consumeControlString(value, index + 2);
        continue;
      }
      index = consumeEscapeSequence(value, index + 1);
      continue;
    }
    if (code === 0x9b) {
      index = consumeCsi(value, index + 1);
      continue;
    }
    if ([0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(code)) {
      index = consumeControlString(value, index + 1);
      continue;
    }
    if (code >= 0x80 && code <= 0x9f) {
      index += 1;
      continue;
    }
    clean += value[index++];
  }
  return clean;
}

function consumeCsi(text, index) {
  while (index < text.length) {
    const code = text.charCodeAt(index++);
    if (code >= 0x40 && code <= 0x7e) break;
  }
  return index;
}

function consumeControlString(text, index) {
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === 0x07 || code === 0x9c) return index + 1;
    if (code === 0x1b && text[index + 1] === "\\") return index + 2;
    index += 1;
  }
  return index;
}

function consumeEscapeSequence(text, index) {
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code >= 0x20 && code <= 0x2f) {
      index += 1;
      continue;
    }
    return code >= 0x30 && code <= 0x7e ? index + 1 : index;
  }
  return index;
}

export function isProcessSuccess(details) {
  return (
    !details.spawnError &&
    !details.aborted &&
    !details.timedOut &&
    !details.signal &&
    (details.exitCode === 0 || details.exitCode === null || details.exitCode === undefined)
  );
}

export function processStatusLine(details) {
  if (details.spawnError) return `Failed to start process: ${details.spawnError}`;
  if (details.aborted) return "Command aborted";
  if (details.timedOut) return `Command timed out after ${details.timeoutMs} ms`;
  if (details.exitCode !== 0 && details.exitCode !== null && details.exitCode !== undefined) {
    return `Command exited with code ${details.exitCode}`;
  }
  if (details.signal) return `Command terminated by signal ${details.signal}`;
  return undefined;
}

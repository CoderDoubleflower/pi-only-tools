import { Text, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import {
  BACKGROUND_RESET,
  BASH_COMMAND_MAX_CHARS,
  BASH_COMMAND_MAX_LINES,
  DIM,
  DIM_RESET,
  DOT,
  DynamicLinesComponent,
  EDIT_DIFF_ADDED_BACKGROUND,
  EDIT_DIFF_REMOVED_BACKGROUND,
  EXPAND_HINT,
  RESPONSE,
} from "./pi-open-render-core.js";

const HEADING_INDENT = "  ";
const DIFF_INDENT = "     ";

function padLine(line, width) {
  return line + " ".repeat(Math.max(0, width - visibleWidth(line)));
}

export function renderToolHeading(title, detail, width) {
  const safeWidth = Math.max(1, width);
  if (!detail) return new Text(title, 0, 0).render(safeWidth);
  const indentWidth = Math.min(HEADING_INDENT.length, Math.max(0, safeWidth - 1));
  const indent = HEADING_INDENT.slice(0, indentWidth);
  const contentWidth = Math.max(1, safeWidth - indentWidth);
  const detailLines = detail.replaceAll("\t", "   ").split("\n");
  const logical = [`${title}(${detailLines[0] ?? ""}`, ...detailLines.slice(1)];
  logical[logical.length - 1] = `${logical.at(-1) ?? ""})`;
  const rendered = [];
  logical.forEach((line, lineIndex) => {
    const wrapped = wrapTextWithAnsi(line, contentWidth);
    (wrapped.length > 0 ? wrapped : [""]).forEach((fragment, fragmentIndex) => {
      const continuation = lineIndex > 0 || fragmentIndex > 0;
      rendered.push(padLine(`${continuation ? indent : ""}${fragment}`, safeWidth));
    });
  });
  return rendered;
}

function responsePrefix() {
  return `${DIM}  ${RESPONSE}  ${DIM_RESET}`;
}

function renderResultBody(lines, width) {
  if (lines.length === 0) return [];
  return new Text(
    [`${responsePrefix()}${lines[0]}`, ...lines.slice(1).map((line) => `     ${line}`)].join("\n"),
    0,
    0,
  ).render(Math.max(1, width));
}

function editKind(line) {
  const normalized = String(line ?? "").trimStart();
  if ((normalized.startsWith("+") && !normalized.startsWith("+++")) || /^\d+\s+\+/.test(normalized)) {
    return "add";
  }
  if ((normalized.startsWith("-") && !normalized.startsWith("---")) || /^\d+\s+-/.test(normalized)) {
    return "remove";
  }
  return undefined;
}

function editBackground(line) {
  const kind = editKind(line);
  if (kind === "add") return EDIT_DIFF_ADDED_BACKGROUND;
  if (kind === "remove") return EDIT_DIFF_REMOVED_BACKGROUND;
  return undefined;
}

function renderEditResult(rawLines, styledLines, width) {
  const safeWidth = Math.max(1, width);
  const rendered = new Text(`${responsePrefix()}${styledLines[0]}`, 0, 0).render(safeWidth);
  const indentWidth = Math.min(DIFF_INDENT.length, Math.max(0, safeWidth - 1));
  const indent = DIFF_INDENT.slice(0, indentWidth);
  const contentWidth = Math.max(1, safeWidth - indentWidth);
  for (let index = 1; index < styledLines.length; index += 1) {
    const background = editBackground(rawLines[index] ?? "");
    for (const line of new Text(styledLines[index] ?? "", 0, 0).render(contentWidth)) {
      rendered.push(background ? `${indent}${background}${line}${BACKGROUND_RESET}` : `${indent}${line}`);
    }
  }
  return rendered;
}

function styleLine(kind, status, index, line, theme) {
  if (status === "error") return theme.fg("error", line);
  if (status === "pending" || status === "running") return `${DIM}${line}${DIM_RESET}`;
  if (line.startsWith("… +")) return `${DIM}${line}${DIM_RESET}`;
  if (kind === "edit" && index > 0) {
    if (editKind(line)) return theme.fg("text", line);
    return theme.fg("toolDiffContext", line);
  }
  if (kind === "bash" && ["(No output)", "Done"].includes(line)) {
    return `${DIM}${line}${DIM_RESET}`;
  }
  const withCounts = kind === "edit" && index === 0
    ? line.replace(/\b(Added|removed|Removed) (\d+) /g, (_match, verb, count) =>
        `${verb} ${theme.bold(count)} `)
    : line;
  return withCounts.replace(` ${EXPAND_HINT}`, ` ${DIM}${EXPAND_HINT}${DIM_RESET}`);
}

function statusFromContext(context) {
  if (context.executionStarted !== true) return "pending";
  if (context.isPartial === true) return "running";
  return context.isError === true ? "error" : "success";
}

function statusDot(status, blink, theme) {
  if (status === "running" && !blink.isLit()) return " ";
  if (status === "pending" || status === "running") return `${DIM}${DOT}${DIM_RESET}`;
  return theme.fg(status === "success" ? "success" : "error", DOT);
}

export function compactCommand(command, expanded) {
  const value = String(command ?? "").replace(/\r\n?/g, "\n");
  if (expanded) return value;
  const lines = value.split("\n");
  if (lines.length <= BASH_COMMAND_MAX_LINES && value.length <= BASH_COMMAND_MAX_CHARS) return value;
  let truncated = lines.length > BASH_COMMAND_MAX_LINES
    ? lines.slice(0, BASH_COMMAND_MAX_LINES).join("\n")
    : value;
  if (truncated.length > BASH_COMMAND_MAX_CHARS) truncated = truncated.slice(0, BASH_COMMAND_MAX_CHARS);
  return `${truncated.trim()}…`;
}

class ToolCallComponent {
  constructor(blink) {
    this.blink = blink;
  }

  update(name, detail, kind, theme, context) {
    this.name = name;
    this.detail = detail;
    this.kind = kind;
    this.theme = theme;
    this.state = context.state;
    this.status = statusFromContext(context);
    this.blink.sync(this, context.invalidate, this.status === "running");
    return this;
  }

  render(width) {
    const safeWidth = Math.max(1, Math.floor(width));
    const title = `${statusDot(this.status, this.blink, this.theme)} ${this.theme.bold(this.name)}`;
    const heading = renderToolHeading(title, this.detail, safeWidth);
    const progress = this.kind === "bash"
      ? this.status === "pending"
        ? "Waiting…"
        : this.status === "running" && this.state?.piOpenHasResult !== true
          ? "Running…"
          : undefined
      : undefined;
    return progress
      ? [...heading, ...renderResultBody([`${DIM}${progress}${DIM_RESET}`], safeWidth)]
      : heading;
  }

  invalidate() {}
}

export function callComponent(name, detail, kind, theme, context, blink) {
  const component = context.lastComponent instanceof ToolCallComponent
    ? context.lastComponent
    : new ToolCallComponent(blink);
  return component.update(name, detail, kind, theme, context);
}

export function resultComponent(kind, formatted, theme) {
  return new DynamicLinesComponent((width) => {
    const styled = formatted.lines.map((line, index) =>
      styleLine(kind, formatted.status, index, line, theme));
    return kind === "edit" && formatted.status === "success" && styled.length > 1
      ? renderEditResult(formatted.lines, styled, width)
      : renderResultBody(styled, width);
  });
}

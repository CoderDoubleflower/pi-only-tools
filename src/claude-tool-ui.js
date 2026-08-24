import { truncateToWidth } from "@earendil-works/pi-tui";

export const RESPONSE_PREFIX = "  ⎿  ";
export const RESPONSE_CONTINUATION = "     ";

export class DynamicLinesComponent {
  constructor(renderLines) {
    this.renderLines = renderLines;
  }

  render(width) {
    return this.renderLines(Math.max(1, Math.floor(width)));
  }

  invalidate() {}
}

export function claudeCallComponent(name, valueLines, theme) {
  return new DynamicLinesComponent((width) => {
    const title = theme.fg("toolTitle", theme.bold(name));
    const open = theme.fg("muted", "(");
    const close = theme.fg("muted", ")");
    const lines = valueLines.length > 0 ? valueLines : ["…"];
    if (lines.length === 1) {
      return [
        truncateToWidth(
          `${title}${open}${theme.fg("toolOutput", lines[0])}${close}`,
          width,
          "…",
        ),
      ];
    }
    const first = truncateToWidth(
      `${title}${open}${theme.fg("toolOutput", lines[0])}`,
      width,
      "…",
    );
    const indent = " ".repeat(name.length + 2);
    const rest = lines.slice(1).map((line, index) => {
      const suffix = index === lines.length - 2 ? close : "";
      return truncateToWidth(
        `${indent}${theme.fg("toolOutput", line)}${suffix}`,
        width,
        "…",
      );
    });
    return [first, ...rest];
  });
}

export function responseLinesComponent(linesFactory, theme) {
  return new DynamicLinesComponent((width) => {
    const lines = typeof linesFactory === "function" ? linesFactory(width) : linesFactory;
    if (lines.length === 0) return [];
    const prefix = theme.fg("muted", RESPONSE_PREFIX);
    return lines.map((line, index) =>
      truncateToWidth(
        `${index === 0 ? prefix : RESPONSE_CONTINUATION}${line}`,
        width,
        "…",
      ),
    );
  });
}

export function prefixedGroupsComponent(groupsFactory, theme) {
  return new DynamicLinesComponent((width) => {
    const groups = groupsFactory(width).filter((group) => group.length > 0);
    const lines = [];
    for (const group of groups) {
      group.forEach((line, index) => {
        const prefix =
          index === 0 ? theme.fg("muted", RESPONSE_PREFIX) : RESPONSE_CONTINUATION;
        lines.push(truncateToWidth(`${prefix}${line}`, width, "…"));
      });
    }
    return lines;
  });
}

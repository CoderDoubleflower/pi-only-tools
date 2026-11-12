import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, truncateToWidth } from "@earendil-works/pi-tui";
import {
  claudeCallComponent,
  DynamicLinesComponent,
  RESPONSE_CONTINUATION,
  RESPONSE_PREFIX,
  responseLinesComponent,
} from "./claude-tool-ui.js";
import { countPlanSteps } from "./plan/plan-store.js";

const PLAN_API_MARKER = Symbol.for("pi-only-tools.user-controlled-plan-api");
const PLAN_UI_TOOL_NAMES = new Set(["EnterPlanMode", "plan_write"]);

function textResult(result) {
  return (result?.content ?? [])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trimEnd();
}

function firstHeading(content) {
  const match = String(content ?? "").match(/^#\s+(.+?)\s*$/m);
  return match?.[1]?.trim() || "…";
}

function stepCount(content) {
  return countPlanSteps(String(content ?? ""));
}

function planRevision(result) {
  const revision = result?.details?.plan?.revision;
  return Number.isInteger(revision) ? revision : undefined;
}

function planStatus(result, content, theme) {
  if (result?.isError) {
    return theme.fg("error", textResult(result) || "Plan update failed");
  }
  const revision = planRevision(result);
  const readiness = result?.details?.readiness;
  const ready = readiness?.ready === true;
  const steps = stepCount(content);
  const label = revision ? `Plan r${revision} saved` : "Plan saved";
  const summary = steps > 0 ? ` · ${steps} ${steps === 1 ? "step" : "steps"}` : "";
  const state = ready ? "awaiting your review" : readiness?.reason || "needs revision";
  return theme.fg(ready ? "success" : "warning", `${label}${summary} · ${state}`);
}

function fallbackMarkdownLines(content, width) {
  const innerWidth = Math.max(1, width);
  return String(content ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .flatMap((line) => {
      if (!line) return [""];
      const pieces = [];
      let rest = line;
      while (rest.length > innerWidth) {
        pieces.push(rest.slice(0, innerWidth));
        rest = rest.slice(innerWidth);
      }
      pieces.push(rest);
      return pieces;
    });
}

function renderMarkdownLines(content, width) {
  try {
    return new Markdown(content, 0, 0, getMarkdownTheme()).render(width);
  } catch {
    return fallbackMarkdownLines(content, width);
  }
}

function planStreamingComponent(content, theme) {
  return new DynamicLinesComponent((width) => {
    const headerLines = claudeCallComponent(
      "Write Plan",
      [firstHeading(content)],
      theme,
    ).render(width);
    const normalized = String(content ?? "").trimEnd();
    const prefix = theme.fg("muted", RESPONSE_PREFIX);
    if (!normalized) {
      return [
        ...headerLines,
        truncateToWidth(`${prefix}${theme.fg("muted", "Writing plan…")}`, width, "…"),
      ];
    }

    const innerWidth = Math.max(1, width - RESPONSE_CONTINUATION.length);
    const planLines = renderMarkdownLines(normalized, innerWidth);
    return [
      ...headerLines,
      "",
      ...planLines.map((line, index) =>
        truncateToWidth(
          `${index === 0 ? prefix : RESPONSE_CONTINUATION}${line}`,
          width,
          "…",
        ),
      ),
    ];
  });
}

function planResultComponent(result, content, theme) {
  return new DynamicLinesComponent((width) => {
    const prefix = theme.fg("muted", RESPONSE_PREFIX);
    const status = planStatus(result, content, theme);
    const innerWidth = Math.max(1, width - RESPONSE_CONTINUATION.length);
    const planLines = renderMarkdownLines(content, innerWidth);
    return [
      truncateToWidth(`${prefix}${status}`, width, "…"),
      "",
      ...planLines.map((line) =>
        truncateToWidth(`${RESPONSE_CONTINUATION}${line}`, width, "…"),
      ),
    ];
  });
}

function renderEnterResult(result, options, theme) {
  if (options.isPartial) {
    return responseLinesComponent([theme.fg("muted", "Entering Plan Mode…")], theme);
  }
  const status = textResult(result) || "Plan Mode enabled";
  return responseLinesComponent(
    [theme.fg(result?.isError ? "error" : "muted", status)],
    theme,
  );
}

export function wrapPlanToolDefinition(tool) {
  if (!tool || !PLAN_UI_TOOL_NAMES.has(tool.name)) return tool;
  const wrapped = { ...tool, renderShell: "self" };

  if (tool.name === "EnterPlanMode") {
    return {
      ...wrapped,
      renderCall(args, theme) {
        const reason = typeof args?.reason === "string" ? args.reason.trim() : "";
        return claudeCallComponent("Enter Plan Mode", [reason || "planning workflow"], theme);
      },
      renderResult: renderEnterResult,
    };
  }

  return {
    ...wrapped,
    renderCall(args, theme, context) {
      const content = typeof args?.content === "string" ? args.content : "";
      if (context?.isPartial === true) {
        return planStreamingComponent(content, theme);
      }
      return claudeCallComponent("Write Plan", [firstHeading(content)], theme);
    },
    renderResult(result, options, theme, context) {
      if (options.isPartial) {
        const streamingContent =
          typeof context?.args?.content === "string" ? context.args.content.trimEnd() : "";
        return streamingContent
          ? responseLinesComponent([], theme)
          : responseLinesComponent([theme.fg("muted", "Writing plan…")], theme);
      }
      if (result?.isError) {
        return responseLinesComponent(
          [theme.fg("error", textResult(result) || "Plan update failed")],
          theme,
        );
      }
      const planContent =
        typeof context?.args?.content === "string" ? context.args.content.trimEnd() : "";
      if (!planContent && typeof tool.renderResult === "function") {
        return tool.renderResult(result, options, theme, context);
      }
      if (!planContent) {
        return responseLinesComponent(
          [theme.fg(result?.isError ? "error" : "muted", textResult(result))],
          theme,
        );
      }
      return planResultComponent(result, planContent, theme);
    },
  };
}

/** Decorate presentation only; Plan publication and review live in the Plan runtime. */
export function createPlanToolUiExtensionApi(pi) {
  if (pi?.[PLAN_API_MARKER]) return pi;
  const registerTool = pi.registerTool.bind(pi);
  return new Proxy(pi, {
    get(target, property) {
      if (property === PLAN_API_MARKER) return true;
      if (property === "registerTool") return (tool) => registerTool(wrapPlanToolDefinition(tool));
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export const __test = {
  firstHeading,
  planStatus,
  planStreamingComponent,
  stepCount,
  textResult,
  wrapPlanToolDefinition,
};

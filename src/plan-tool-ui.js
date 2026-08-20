import { Text } from "@earendil-works/pi-tui";

const PLAN_UI_TOOL_NAMES = new Set(["EnterPlanMode", "plan_write", "ExitPlanMode"]);

function textResult(result) {
  return (result?.content ?? [])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trimEnd();
}

export function wrapPlanToolDefinition(tool) {
  if (!tool || !PLAN_UI_TOOL_NAMES.has(tool.name)) return tool;

  const wrapped = {
    ...tool,
    // Pi's default tool shell is a Box with one cell of horizontal padding.
    // The rest of pi-only-tools uses self-rendered shells, so the Plan workflow
    // tools must opt out as well to keep every tool call on the same left edge.
    renderShell: "self",
  };

  if (tool.name !== "plan_write") return wrapped;

  return {
    ...wrapped,
    renderResult(result, options, theme, context) {
      if (options.isPartial) {
        return new Text(theme.fg("muted", "Writing plan…"), 0, 0);
      }

      const status = textResult(result);
      const planContent =
        typeof context?.args?.content === "string" ? context.args.content.trimEnd() : "";

      // Keep the model-visible tool result compact; render the already-present
      // plan_write call argument only in the TUI so each revision is reviewable
      // immediately without duplicating the entire plan in conversation context.
      if (!planContent && typeof tool.renderResult === "function") {
        return tool.renderResult(result, options, theme, context);
      }

      const sections = [];
      if (status) sections.push(theme.fg("muted", status));
      if (planContent) sections.push(theme.fg("toolOutput", planContent));
      return new Text(sections.join("\n\n"), 0, 0);
    },
  };
}

export function createPlanToolUiExtensionApi(pi) {
  const registerTool = pi.registerTool.bind(pi);
  return new Proxy(pi, {
    get(target, property) {
      if (property === "registerTool") {
        return (tool) => registerTool(wrapPlanToolDefinition(tool));
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export const __test = {
  textResult,
  wrapPlanToolDefinition,
};

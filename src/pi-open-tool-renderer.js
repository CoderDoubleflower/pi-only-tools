import {
  ClaudeToolBlinkController,
  EDIT_DIFF_ADDED_BACKGROUND,
  EDIT_DIFF_REMOVED_BACKGROUND,
  isObject,
  isProcessSuccess,
  stripAnsi,
} from "./pi-open-render-core.js";
import { callComponent, compactCommand, resultComponent } from "./pi-open-render-layout.js";
import { formatResult, patchUse } from "./pi-open-render-results.js";

export {
  ClaudeToolBlinkController,
  EDIT_DIFF_ADDED_BACKGROUND,
  EDIT_DIFF_REMOVED_BACKGROUND,
  stripAnsi,
};

export function wrapClaudeToolRenderDefinition(tool, options = {}) {
  if (!tool || !["shell_command", "apply_patch"].includes(tool.name)) return tool;
  const blink = options.blink ?? new ClaudeToolBlinkController();
  if (tool.name === "shell_command") {
    return {
      ...tool,
      renderShell: "self",
      renderCall(args, theme, context = {}) {
        if (isObject(context.state) && context.executionStarted !== true) {
          context.state.piOpenHasResult = false;
        }
        return callComponent(
          "Bash",
          compactCommand(args?.command ?? "", context.expanded === true),
          "bash",
          theme,
          context,
          blink,
        );
      },
      renderResult(result, renderOptions, theme, context = {}) {
        if (isObject(context.state)) context.state.piOpenHasResult = true;
        return resultComponent("bash", formatResult("bash", result, renderOptions, context), theme);
      },
    };
  }
  return {
    ...tool,
    renderShell: "self",
    renderCall(args, theme, context = {}) {
      const use = patchUse(args?.patch ?? "", typeof context.cwd === "string" ? context.cwd : process.cwd());
      return callComponent(use.name, use.detail, "edit", theme, context, blink);
    },
    renderResult(result, renderOptions, theme, context = {}) {
      return resultComponent("edit", formatResult("edit", result, renderOptions, context), theme);
    },
  };
}

export function createClaudeToolRenderExtensionApi(pi) {
  const blink = new ClaudeToolBlinkController();
  const registerTool = pi.registerTool.bind(pi);
  for (const event of ["session_start", "session_tree", "session_shutdown"]) {
    pi.on?.(event, () => blink.dispose());
  }
  pi.on?.("tool_result", (event) => {
    if (event?.toolName !== "apply_patch" || !isObject(event.details)) return undefined;
    return isProcessSuccess(event.details) ? undefined : { isError: true };
  });
  return new Proxy(pi, {
    get(target, property) {
      if (property === "registerTool") {
        return (tool) => registerTool(wrapClaudeToolRenderDefinition(tool, { blink }));
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

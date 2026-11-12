import { executeCodexShellCommand } from "./codex-shell-process.js";

export {
  CODEX_APPROX_BYTES_PER_TOKEN,
  CODEX_CAPTURE_MAX_BYTES,
  CODEX_TOOL_OUTPUT_TOKEN_LIMIT,
  aggregateCodexOutput,
  approxTokenCount,
  formatExecOutputForModel,
  truncateMiddleWithTokenBudget,
} from "./codex-shell-output.js";

export function wrapShellCommandDefinition(tool) {
  if (!tool || tool.name !== "shell_command") return tool;
  return {
    ...tool,
    description:
      `${tool.description} Output capture retains the beginning and end of stdout and stderr within 1 MiB each, ` +
      "and model-visible output preserves both streams within approximately 10,000 tokens.",
    execute: executeCodexShellCommand,
  };
}

export function createCodexShellExtensionApi(pi) {
  const registerTool = pi.registerTool.bind(pi);
  return new Proxy(pi, {
    get(target, property) {
      if (property === "registerTool") {
        return (tool) => registerTool(wrapShellCommandDefinition(tool));
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export const __test = {
  createCodexShellExtensionApi,
  executeCodexShellCommand,
  wrapShellCommandDefinition,
};

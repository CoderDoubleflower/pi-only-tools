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
      `${tool.description} Output capture matches Codex: stdout and stderr are each capped at 1 MiB, ` +
      "the combined capture is capped at 1 MiB, and model-visible output is middle-truncated to approximately 10,000 tokens.",
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

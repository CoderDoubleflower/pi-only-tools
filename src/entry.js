import basePlugin, { __test as baseTest } from "./index.js";
import {
  __test as codexShellTest,
  createCodexShellExtensionApi,
} from "./codex-shell-command.js";
import { createClaudeToolRenderExtensionApi } from "./pi-open-tool-renderer.js";
import { createPlanToolUiExtensionApi } from "./plan-tool-ui.js";

function createProfileCommandDescriptionApi(pi) {
  if (typeof pi.registerCommand !== "function") return pi;
  const registerCommand = pi.registerCommand.bind(pi);
  return new Proxy(pi, {
    get(target, property) {
      if (property === "registerCommand") {
        return (name, command) =>
          registerCommand(
            name,
            ["only-tools", "pi-only-tools"].includes(name)
              ? {
                  ...command,
                  description: "Manage the persistent Normal/Ask/Plan tool matrix",
                }
              : command,
          );
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export default function piOnlyTools(pi) {
  const codexShellApi = createCodexShellExtensionApi(pi);
  const claudeToolRenderApi = createClaudeToolRenderExtensionApi(codexShellApi);
  const profileCommandApi = createProfileCommandDescriptionApi(claudeToolRenderApi);
  return basePlugin(createPlanToolUiExtensionApi(profileCommandApi));
}

export const __test = baseTest;
export const __codexTest = codexShellTest;
export const __entryTest = { createProfileCommandDescriptionApi };

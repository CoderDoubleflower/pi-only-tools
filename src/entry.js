import basePlugin, { __test as baseTest } from "./index.js";
import {
  __test as codexShellTest,
  createCodexShellExtensionApi,
} from "./codex-shell-command.js";
import { registerCodexWebSearch } from "./codex-web-search.js";
import { createPlanToolUiExtensionApi } from "./plan-tool-ui.js";
import { createToolRendererDelegationApi } from "./tool-renderer-delegation.js";

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
  const profileCommandApi = createProfileCommandDescriptionApi(codexShellApi);
  const planToolUiApi = createPlanToolUiExtensionApi(profileCommandApi);
  const delegatedToolUiApi = createToolRendererDelegationApi(planToolUiApi);
  registerCodexWebSearch(delegatedToolUiApi);
  return basePlugin(delegatedToolUiApi);
}

export const __test = baseTest;
export const __codexTest = codexShellTest;
export const __entryTest = { createProfileCommandDescriptionApi };

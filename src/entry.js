import basePlugin, { __test as baseTest } from "./index.js";
import {
  __test as codexShellTest,
  createCodexShellExtensionApi,
} from "./codex-shell-command.js";
import { createPlanToolUiExtensionApi } from "./plan-tool-ui.js";

export default function piOnlyTools(pi) {
  const codexShellApi = createCodexShellExtensionApi(pi);
  return basePlugin(createPlanToolUiExtensionApi(codexShellApi));
}

export const __test = baseTest;
export const __codexTest = codexShellTest;

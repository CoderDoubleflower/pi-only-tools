import basePlugin, { __test as baseTest } from "./index.js";
import {
  __test as codexShellTest,
  createCodexShellExtensionApi,
} from "./codex-shell-command.js";

export default function piOnlyTools(pi) {
  return basePlugin(createCodexShellExtensionApi(pi));
}

export const __test = baseTest;
export const __codexTest = codexShellTest;

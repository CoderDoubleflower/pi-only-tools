import { createPlanToolUiExtensionApi } from "../plan-tool-ui.js";
import {
  registerClaudePlanMode as registerLegacyClaudePlanMode,
} from "./legacy-index.js";

export * from "./config.js";
export * from "./config-ui.js";
export * from "./constants.js";
export * from "./handoff.js";
export * from "./plan-store.js";
export * from "./profile.js";
export * from "./state.js";
export * from "./tool-set.js";
export * from "./types.js";

export function registerClaudePlanMode(pi, options = {}) {
  return registerLegacyClaudePlanMode(
    createPlanToolUiExtensionApi(pi),
    options,
  );
}

export default function claudePlanModeExtension(pi) {
  return registerClaudePlanMode(pi);
}

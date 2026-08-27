import { registerAskMode } from "../ask-mode.js";
import { registerCacheStableModeRuntime } from "../cache-stable-mode.js";
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

function suppressTerminalInputContext(ctx) {
  if (!ctx?.ui || typeof ctx.ui !== "object") return ctx;
  const ui = new Proxy(ctx.ui, {
    get(target, property) {
      if (property === "onTerminalInput") return () => () => {};
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(ctx, {
    get(target, property) {
      if (property === "ui") return ui;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function createPlanRuntimeBridge(pi) {
  const registerCommand = pi.registerCommand.bind(pi);
  const registerEvent = pi.on.bind(pi);
  let planCommand;
  let commandInterceptor;

  const api = new Proxy(pi, {
    get(target, property) {
      if (property === "registerCommand") {
        return (name, command) => {
          if (name !== "plan") return registerCommand(name, command);
          const bridged = {
            ...command,
            handler: (args, ctx) => {
              const next = () => command.handler(args, ctx);
              return commandInterceptor
                ? commandInterceptor(args, ctx, next)
                : next();
            },
          };
          planCommand = bridged;
          return registerCommand(name, bridged);
        };
      }
      if (property === "on") {
        return (event, handler) =>
          registerEvent(event, (payload, ctx) =>
            handler(
              payload,
              event === "session_start"
                ? suppressTerminalInputContext(ctx)
                : ctx,
            ),
          );
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  return {
    api,
    getPlanCommand: () => planCommand,
    setCommandInterceptor(interceptor) {
      commandInterceptor = interceptor;
    },
  };
}

export function registerClaudePlanMode(pi, options = {}) {
  const decoratedPi = createPlanToolUiExtensionApi(pi);
  if (!options.toolProfiles) {
    return registerLegacyClaudePlanMode(decoratedPi, options);
  }

  const bridge = createPlanRuntimeBridge(decoratedPi);
  const legacyMode = registerLegacyClaudePlanMode(bridge.api, options);
  const planActions = {
    getStage: legacyMode.getStage,
    async enter(ctx, reason) {
      const command = bridge.getPlanCommand();
      if (!command) throw new Error("The Plan command is unavailable.");
      await command.handler(reason ? `on ${reason}` : "on", ctx);
      return ["planning", "ready"].includes(legacyMode.getStage());
    },
    async leave(ctx) {
      if (!["planning", "ready"].includes(legacyMode.getStage())) return;
      const command = bridge.getPlanCommand();
      if (!command) throw new Error("The Plan command is unavailable.");
      await command.handler("off", ctx);
    },
  };

  const askMode = registerAskMode(decoratedPi, {
    toolProfiles: options.toolProfiles,
    planMode: planActions,
    openConfig: legacyMode.openConfig,
  });
  bridge.setCommandInterceptor(askMode.prepareForPlanCommand);

  const integratedMode = {
    ...legacyMode,
    async applySavedConfiguration(ctx) {
      await legacyMode.applySavedConfiguration?.(ctx);
      await askMode.applySavedConfiguration(ctx);
    },
    async openConfig(ctx) {
      const result = await legacyMode.openConfig(ctx);
      if (result?.saved) await askMode.applySavedConfiguration(ctx);
      return result;
    },
    cycleMode: askMode.cycle,
    enterAskMode: askMode.enter,
    getAskState: askMode.getState,
    getMode: askMode.getMode,
    leaveAskMode: askMode.leave,
  };

  registerCacheStableModeRuntime(decoratedPi, {
    toolProfiles: options.toolProfiles,
    getPlanMode: () => integratedMode,
  });

  return integratedMode;
}

export default function claudePlanModeExtension(pi) {
  return registerClaudePlanMode(pi);
}

export const __test = {
  createPlanRuntimeBridge,
  suppressTerminalInputContext,
};

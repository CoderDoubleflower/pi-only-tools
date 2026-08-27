import { registerAskMode } from "../ask-mode.js";
import { buildAskModeContext } from "../ask-mode-policy.js";
import {
  buildModeSystemPrompt,
  buildNormalModeContext,
  createModeContextMessage,
} from "../mode-prompt.js";
import {
  applyOpenAIAllowedTools,
  supportsOpenAIAllowedTools,
} from "../provider-tool-policy.js";
import { createPlanToolUiExtensionApi } from "../plan-tool-ui.js";
import {
  registerClaudePlanMode as registerLegacyClaudePlanMode,
} from "./legacy-index.js";
import {
  ASK_USER_QUESTION_TOOL,
  LEGACY_EXIT_PLAN_MODE_TOOL,
} from "./constants.js";
import {
  buildExecutionModeContext,
  buildPlanningModeContext,
  buildReadyModeContext,
  disableLegacyModeSystemPrompts,
} from "./prompts.js";
import {
  buildPlanningTools,
  getEffectivePlanningToolSelection,
} from "./tool-set.js";

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

function orderedAvailableTools(pi, values) {
  const requested = new Set(values ?? []);
  const result = [];
  const seen = new Set();
  for (const tool of pi.getAllTools?.() ?? []) {
    const name = tool?.name;
    if (typeof name !== "string" || seen.has(name) || !requested.has(name)) continue;
    seen.add(name);
    result.push(name);
  }
  return result;
}

function buildRuntimeSnapshot(pi, legacyMode, askMode, toolProfiles) {
  const state = legacyMode.getState?.();
  const stage = state?.stage ?? "idle";
  const allNames = new Set(
    (pi.getAllTools?.() ?? [])
      .map((tool) => tool?.name)
      .filter((name) => typeof name === "string" && name.length > 0),
  );

  if (stage === "planning") {
    const requested = toolProfiles
      ? toolProfiles.getEffectiveTools("plan")
      : state?.planningTools ?? [];
    const selected = getEffectivePlanningToolSelection(requested, allNames);
    const allowedTools = orderedAvailableTools(
      pi,
      buildPlanningTools(selected, allNames),
    );
    return {
      mode: "plan",
      stage,
      allowedTools,
      content: buildPlanningModeContext(
        state,
        allowedTools,
        allowedTools.includes(ASK_USER_QUESTION_TOOL),
      ),
    };
  }

  if (stage === "ready") {
    return {
      mode: "plan",
      stage,
      allowedTools: [],
      content: buildReadyModeContext(state),
    };
  }

  if (stage === "executing") {
    const requested = toolProfiles
      ? toolProfiles.getEffectiveTools("normal")
      : state?.executionTools ?? state?.baseline?.tools ?? pi.getActiveTools?.() ?? [];
    const allowedTools = orderedAvailableTools(pi, requested);
    return {
      mode: "normal",
      stage,
      allowedTools,
      content: buildExecutionModeContext(state, allowedTools),
    };
  }

  if (askMode?.isActive?.()) {
    const allowedTools = orderedAvailableTools(
      pi,
      toolProfiles?.getEffectiveTools("ask") ?? askMode.getAllowedTools?.() ?? [],
    );
    return {
      mode: "ask",
      stage: "ask",
      allowedTools,
      content: buildAskModeContext(allowedTools),
    };
  }

  const allowedTools = orderedAvailableTools(
    pi,
    toolProfiles?.getEffectiveTools("normal") ?? pi.getActiveTools?.() ?? [],
  );
  return {
    mode: "normal",
    stage: "normal",
    allowedTools,
    content: buildNormalModeContext(allowedTools),
  };
}

function modeBlockReason(snapshot, toolName) {
  if (toolName === LEGACY_EXIT_PLAN_MODE_TOOL && ["planning", "ready"].includes(snapshot.stage)) {
    return "Plan approval is user-controlled; ExitPlanMode is unavailable to the model.";
  }
  if (snapshot.stage === "ready") {
    return `Plan Ready blocks ${toolName}. The published plan is awaiting user review and no tools are allowed.`;
  }
  const label = snapshot.mode === "ask" ? "Ask Mode" : snapshot.mode === "plan" ? "Plan Mode" : "Normal profile";
  return `${label} blocks ${toolName}. Allowed tools: ${snapshot.allowedTools.join(", ") || "none"}.`;
}

function registerRuntimeModePolicy(pi, legacyMode, askMode, toolProfiles) {
  let lastContextFingerprint;
  const resetContext = () => {
    lastContextFingerprint = undefined;
  };

  pi.on("session_start", resetContext);
  pi.on("session_tree", resetContext);
  pi.on("session_compact", resetContext);

  pi.on("before_agent_start", (event) => {
    toolProfiles?.syncCatalog?.();
    const snapshot = buildRuntimeSnapshot(pi, legacyMode, askMode, toolProfiles);
    const fingerprint = JSON.stringify({
      mode: snapshot.mode,
      stage: snapshot.stage,
      allowedTools: snapshot.allowedTools,
      content: snapshot.content,
    });
    const protocol = buildModeSystemPrompt();
    const systemPrompt = event.systemPrompt.includes("[PI ONLY TOOLS MODE PROTOCOL]")
      ? event.systemPrompt
      : `${event.systemPrompt}\n\n${protocol}`;
    if (fingerprint === lastContextFingerprint) return { systemPrompt };
    lastContextFingerprint = fingerprint;
    return {
      systemPrompt,
      message: createModeContextMessage(snapshot, fingerprint),
    };
  });

  pi.on("tool_call", (event) => {
    const snapshot = buildRuntimeSnapshot(pi, legacyMode, askMode, toolProfiles);
    if (snapshot.allowedTools.includes(event.toolName)) return;
    return {
      block: true,
      reason: modeBlockReason(snapshot, event.toolName),
    };
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!supportsOpenAIAllowedTools(ctx.model)) return;
    const snapshot = buildRuntimeSnapshot(pi, legacyMode, askMode, toolProfiles);
    return applyOpenAIAllowedTools(event.payload, snapshot.allowedTools);
  });

  return {
    getAllowedTools: () =>
      buildRuntimeSnapshot(pi, legacyMode, askMode, toolProfiles).allowedTools,
    getSnapshot: () => buildRuntimeSnapshot(pi, legacyMode, askMode, toolProfiles),
    resetContext,
  };
}

export function registerClaudePlanMode(pi, options = {}) {
  disableLegacyModeSystemPrompts();
  const decoratedPi = createPlanToolUiExtensionApi(pi);
  if (!options.toolProfiles) {
    const legacyMode = registerLegacyClaudePlanMode(decoratedPi, options);
    const modePolicy = registerRuntimeModePolicy(decoratedPi, legacyMode, undefined, undefined);
    return {
      ...legacyMode,
      getAllowedTools: modePolicy.getAllowedTools,
      getModeSnapshot: modePolicy.getSnapshot,
    };
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
  const modePolicy = registerRuntimeModePolicy(
    decoratedPi,
    legacyMode,
    askMode,
    options.toolProfiles,
  );
  bridge.setCommandInterceptor(askMode.prepareForPlanCommand);

  return {
    ...legacyMode,
    async applySavedConfiguration(ctx) {
      await legacyMode.applySavedConfiguration?.(ctx);
      await askMode.applySavedConfiguration(ctx);
      modePolicy.resetContext();
    },
    async openConfig(ctx) {
      const result = await legacyMode.openConfig(ctx);
      if (result?.saved) {
        await askMode.applySavedConfiguration(ctx);
        modePolicy.resetContext();
      }
      return result;
    },
    cycleMode: askMode.cycle,
    enterAskMode: askMode.enter,
    getAllowedTools: modePolicy.getAllowedTools,
    getAskState: askMode.getState,
    getMode: askMode.getMode,
    getModeSnapshot: modePolicy.getSnapshot,
    leaveAskMode: askMode.leave,
  };
}

export default function claudePlanModeExtension(pi) {
  return registerClaudePlanMode(pi);
}

export const __test = {
  buildRuntimeSnapshot,
  createPlanRuntimeBridge,
  modeBlockReason,
  orderedAvailableTools,
  registerRuntimeModePolicy,
  suppressTerminalInputContext,
};

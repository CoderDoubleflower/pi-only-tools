import { Key, matchesKey } from "@earendil-works/pi-tui";
import {
  ASK_MODE_PROFILE,
  ASK_MODE_STATE_ENTRY,
  ASK_MODE_STATE_VERSION,
  ASK_MODE_STATUS_KEY,
  buildAskSystemPrompt,
  buildAskTools,
} from "./ask-mode-policy.js";

const PLAN_ACTIVE_STAGES = new Set(["planning", "ready"]);
const PLAN_NON_ENTERING_COMMANDS = new Set([
  "approve",
  "cancel",
  "config",
  "edit",
  "finish",
  "off",
  "path",
  "status",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validState(value) {
  return (
    isRecord(value) &&
    value.schemaVersion === ASK_MODE_STATE_VERSION &&
    typeof value.active === "boolean" &&
    typeof value.updatedAt === "string"
  );
}

function getCurrentBranch(ctx) {
  const manager = ctx.sessionManager;
  return typeof manager.getBranch === "function"
    ? manager.getBranch()
    : manager.getEntries();
}

function restoreState(entries) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== ASK_MODE_STATE_ENTRY) {
      continue;
    }
    if (validState(entry.data)) return structuredClone(entry.data);
  }
  return undefined;
}

function touchState(active) {
  return {
    schemaVersion: ASK_MODE_STATE_VERSION,
    active,
    updatedAt: new Date().toISOString(),
  };
}

function startsPlanWorkflow(args, stage) {
  const raw = String(args ?? "").trim();
  if (!raw) return !stage || stage === "idle" || stage === "handed_off";
  const command = raw.split(/\s+/, 1)[0].toLowerCase();
  if (["on", "start"].includes(command)) return true;
  return !PLAN_NON_ENTERING_COMMANDS.has(command);
}

export function registerAskMode(pi, options) {
  const toolProfiles = options.toolProfiles;
  const planMode = options.planMode;
  let state;
  let removeShiftTabListener;

  function allToolNames() {
    return new Set((pi.getAllTools?.() ?? []).map((tool) => tool?.name).filter(Boolean));
  }

  function isPlanActive() {
    return PLAN_ACTIVE_STAGES.has(planMode.getStage?.());
  }

  function isActive() {
    return state?.active === true && !isPlanActive();
  }

  function getMode() {
    if (isPlanActive()) return "plan";
    return isActive() ? "ask" : "normal";
  }

  function selectedAskTools() {
    const names = allToolNames();
    const configured = toolProfiles.getRequestedTools("plan");
    return buildAskTools(configured, names);
  }

  function updateUi(ctx) {
    const text = isActive()
      ? ctx.ui.theme?.fg?.("accent", "Ask Mode") ?? "Ask Mode"
      : undefined;
    ctx.ui.setStatus(ASK_MODE_STATUS_KEY, text);
  }

  function commit(active, ctx, persist = true) {
    state = touchState(active);
    if (persist) pi.appendEntry(ASK_MODE_STATE_ENTRY, state);
    updateUi(ctx);
    return state;
  }

  function activateAskTools(ctx, { warnIfEmpty = false } = {}) {
    const tools = selectedAskTools();
    toolProfiles.setProfile(ASK_MODE_PROFILE, tools, { apply: false });
    toolProfiles.activate(ASK_MODE_PROFILE);
    updateUi(ctx);
    if (warnIfEmpty && tools.length === 0) {
      ctx.ui.notify(
        "Ask Mode has no available read-only tools. Enable read/search tools in the Plan profile or answer without tools.",
        "warning",
      );
    }
    return tools;
  }

  async function enter(ctx, enterOptions = {}) {
    if (isPlanActive()) await planMode.leave(ctx);
    if (isActive()) {
      activateAskTools(ctx);
      return { entered: false, message: "Ask Mode is already active." };
    }
    commit(true, ctx);
    const tools = activateAskTools(ctx, { warnIfEmpty: true });
    const message = `Ask Mode enabled with read-only tools: ${tools.join(", ") || "none"}.`;
    if (enterOptions.notify !== false) ctx.ui.notify(message, "info");
    return { entered: true, message };
  }

  async function leave(ctx, leaveOptions = {}) {
    const wasActive = state?.active === true;
    if (wasActive) commit(false, ctx);
    else updateUi(ctx);
    if (!isPlanActive()) toolProfiles.activate("normal");
    const message = "Ask Mode disabled; the Normal profile is active.";
    if (wasActive && leaveOptions.notify !== false) ctx.ui.notify(message, "info");
    return { left: wasActive, message };
  }

  async function cycle(ctx) {
    if (typeof ctx.isIdle === "function" && !ctx.isIdle()) {
      ctx.ui.notify(
        "Shift+Tab can switch modes after the current agent turn finishes.",
        "warning",
      );
      return getMode();
    }

    const mode = getMode();
    if (mode === "normal") {
      await enter(ctx, { notify: false });
      ctx.ui.notify("Ask Mode on · Shift+Tab for Plan Mode", "info");
      return "ask";
    }
    if (mode === "ask") {
      await leave(ctx, { notify: false });
      const entered = await planMode.enter(ctx);
      if (!entered) {
        await enter(ctx, { notify: false });
        ctx.ui.notify("Plan Mode could not be entered; Ask Mode was restored.", "warning");
        return "ask";
      }
      return "plan";
    }

    await planMode.leave(ctx);
    return "normal";
  }

  function installShiftTabCycle(ctx) {
    removeShiftTabListener?.();
    removeShiftTabListener = undefined;
    if (ctx.mode !== "tui" || typeof ctx.ui.onTerminalInput !== "function") return;
    removeShiftTabListener = ctx.ui.onTerminalInput((data) => {
      if (!matchesKey(data, Key.shift("tab"))) return;
      void cycle(ctx).catch((error) => {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      });
      return { consume: true };
    });
  }

  async function restoreRuntime(ctx) {
    state = restoreState(getCurrentBranch(ctx));
    if (state?.active && isPlanActive()) commit(false, ctx);
    if (isActive()) activateAskTools(ctx);
    else {
      updateUi(ctx);
      if (toolProfiles.snapshot().mode === ASK_MODE_PROFILE && !isPlanActive()) {
        toolProfiles.activate("normal");
      }
    }
  }

  async function applySavedConfiguration(ctx) {
    if (isActive()) activateAskTools(ctx, { warnIfEmpty: true });
  }

  async function prepareForPlanCommand(args, ctx, next) {
    if (!isActive()) return next();
    if (!startsPlanWorkflow(args, planMode.getStage?.())) {
      const result = await next();
      await applySavedConfiguration(ctx);
      return result;
    }
    await leave(ctx, { notify: false });
    try {
      const result = await next();
      if (!isPlanActive()) await enter(ctx, { notify: false });
      return result;
    } catch (error) {
      await enter(ctx, { notify: false });
      throw error;
    }
  }

  pi.registerCommand("ask", {
    description: "Start, inspect, configure, or stop read-only Ask Mode",
    handler: async (args, ctx) => {
      await ctx.waitForIdle?.();
      const raw = args.trim();
      if (!raw) {
        if (isActive()) {
          ctx.ui.notify(
            `Ask Mode is active. Read-only tools: ${selectedAskTools().join(", ") || "none"}.`,
            "info",
          );
        } else {
          await enter(ctx);
        }
        return;
      }

      const [command = "", ...rest] = raw.split(/\s+/);
      const normalized = command.toLowerCase();
      const task = rest.join(" ").trim();
      if (["on", "start"].includes(normalized)) {
        await enter(ctx);
        if (task) pi.sendUserMessage(task, { expandPromptTemplates: true });
        return;
      }
      if (["off", "stop", "cancel"].includes(normalized)) {
        await leave(ctx);
        return;
      }
      if (normalized === "status") {
        ctx.ui.notify(
          JSON.stringify(
            {
              mode: getMode(),
              active: isActive(),
              tools: selectedAskTools(),
            },
            null,
            2,
          ),
          "info",
        );
        return;
      }
      if (normalized === "config") {
        const result = await options.openConfig?.(ctx);
        if (result?.saved) await applySavedConfiguration(ctx);
        return;
      }

      await enter(ctx);
      pi.sendUserMessage(raw, { expandPromptTemplates: true });
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    await restoreRuntime(ctx);
    installShiftTabCycle(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    await restoreRuntime(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    removeShiftTabListener?.();
    removeShiftTabListener = undefined;
    ctx.ui.setStatus(ASK_MODE_STATUS_KEY, undefined);
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (!isActive()) return;
    toolProfiles.apply();
    const tools = toolProfiles.getEffectiveTools(ASK_MODE_PROFILE);
    return {
      systemPrompt: `${event.systemPrompt}\n\n${buildAskSystemPrompt(tools)}`,
    };
  });

  pi.on("tool_call", (event) => {
    if (!isActive()) return;
    const allowed = toolProfiles.getEffectiveTools(ASK_MODE_PROFILE);
    if (allowed.includes(event.toolName)) return;
    return {
      block: true,
      reason: `Ask Mode blocks ${event.toolName}. Allowed read-only tools: ${allowed.join(", ") || "none"}.`,
    };
  });

  return {
    enabled: true,
    applySavedConfiguration,
    cycle,
    enter,
    getMode,
    getState: () => state,
    isActive,
    leave,
    prepareForPlanCommand,
  };
}

export const __test = {
  PLAN_NON_ENTERING_COMMANDS,
  restoreState,
  startsPlanWorkflow,
  touchState,
  validState,
};

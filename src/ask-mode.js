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
const MODE_NAMES = Object.freeze(["normal", "ask", "plan"]);
const MODE_LABELS = Object.freeze({
  normal: "Normal",
  ask: "Ask",
  plan: "Plan",
});

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

function modeFromChoice(choice) {
  if (typeof choice !== "string") return undefined;
  const normalized = choice.trim().toLowerCase();
  return MODE_NAMES.includes(normalized) ? normalized : undefined;
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
    return buildAskTools(
      toolProfiles.getRequestedTools(ASK_MODE_PROFILE),
      allToolNames(),
    );
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
        "Ask Mode has no available tools. Configure the Ask column in /only-tools.",
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
    const message = `Ask Mode enabled with configured tools: ${tools.join(", ") || "none"}.`;
    if (enterOptions.notify !== false) ctx.ui.notify(message, "info");
    return { entered: true, message };
  }

  async function leave(ctx, leaveOptions = {}) {
    const wasActive = state?.active === true;
    if (wasActive) commit(false, ctx);
    else updateUi(ctx);
    if (!isPlanActive()) toolProfiles.activate("normal");
    const message = "Normal Mode enabled.";
    if (wasActive && leaveOptions.notify !== false) ctx.ui.notify(message, "info");
    return { left: wasActive, message };
  }

  async function setMode(requestedMode, ctx, setOptions = {}) {
    const mode = modeFromChoice(requestedMode);
    if (!mode) throw new Error(`Unknown mode: ${requestedMode}`);
    const current = getMode();
    const notify = setOptions.notify !== false;

    if (mode === current) {
      if (mode === "ask") activateAskTools(ctx);
      if (notify) ctx.ui.notify(`${MODE_LABELS[mode]} Mode is already active.`, "info");
      return { mode, changed: false };
    }

    if (mode === "normal") {
      if (isPlanActive()) await planMode.leave(ctx);
      if (state?.active === true) commit(false, ctx);
      else updateUi(ctx);
      toolProfiles.activate("normal");
      if (notify) ctx.ui.notify("Normal Mode enabled.", "info");
      return { mode: "normal", changed: true };
    }

    if (mode === "ask") {
      await enter(ctx, { notify });
      return { mode: "ask", changed: true };
    }

    if (state?.active === true) commit(false, ctx);
    toolProfiles.activate("normal");
    let entered = false;
    try {
      entered = await planMode.enter(ctx);
    } catch (error) {
      toolProfiles.activate("normal");
      updateUi(ctx);
      throw error;
    }
    if (!entered) {
      toolProfiles.activate("normal");
      updateUi(ctx);
      if (notify) {
        ctx.ui.notify(
          "Plan Mode is unavailable in the current workflow state; Normal Mode remains active.",
          "warning",
        );
      }
      return { mode: "normal", changed: current !== "normal" };
    }
    return { mode: "plan", changed: true };
  }

  async function cycle(ctx) {
    if (typeof ctx.isIdle === "function" && !ctx.isIdle()) {
      ctx.ui.notify(
        "Shift+Tab can switch modes after the current agent turn finishes.",
        "warning",
      );
      return getMode();
    }

    const current = getMode();
    const next = current === "normal" ? "ask" : current === "ask" ? "plan" : "normal";
    const result = await setMode(next, ctx, { notify: false });
    if (current === "normal" && result.mode === "ask") {
      ctx.ui.notify("Ask Mode on · Shift+Tab for Plan Mode", "info");
    } else if (current === "ask" && result.mode === "plan") {
      ctx.ui.notify("Plan Mode on · Shift+Tab for Normal Mode", "info");
    } else if (result.mode === "normal") {
      const type = next === "plan" ? "warning" : "info";
      const message =
        next === "plan"
          ? "Plan Mode is unavailable in the current workflow state; switched to Normal."
          : "Normal Mode enabled.";
      ctx.ui.notify(message, type);
    }
    return result.mode;
  }

  async function openModeMenu(ctx) {
    await ctx.waitForIdle?.();
    if (!ctx.hasUI || typeof ctx.ui.select !== "function") {
      ctx.ui.notify("The /mode selector requires interactive UI.", "warning");
      return { mode: getMode(), changed: false };
    }
    const current = getMode();
    const choice = await ctx.ui.select(
      `Select mode · current: ${MODE_LABELS[current]}`,
      MODE_NAMES.map((name) => MODE_LABELS[name]),
    );
    const selected = modeFromChoice(choice);
    if (!selected) return { mode: current, changed: false };
    return setMode(selected, ctx);
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

  pi.registerCommand("mode", {
    description: "Choose Normal, Ask, or Plan mode",
    handler: async (_args, ctx) => {
      await openModeMenu(ctx);
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

  pi.on("before_agent_start", (event) => {
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
      reason: `Ask Mode blocks ${event.toolName}. Allowed tools from /only-tools: ${allowed.join(", ") || "none"}.`,
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
    openModeMenu,
    prepareForPlanCommand,
    setMode,
  };
}

export const __test = {
  MODE_LABELS,
  MODE_NAMES,
  PLAN_NON_ENTERING_COMMANDS,
  modeFromChoice,
  restoreState,
  startsPlanWorkflow,
  touchState,
  validState,
};

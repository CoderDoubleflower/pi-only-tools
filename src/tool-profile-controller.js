import {
  appendModeProtocol,
  buildModeStateSnapshot,
  createModeStateMessage,
  fingerprintModeState,
  MODE_STATE_CUSTOM_TYPE,
  rewriteOpenAIResponsesToolChoice,
  uniqueToolNames,
} from "./mode-cache-policy.js";
import { LEGACY_EXIT_PLAN_MODE_TOOL, PLAN_STATE_ENTRY } from "./plan/constants.js";

const PROFILE_NAMES = Object.freeze(["normal", "ask", "plan"]);
const PLAN_ACTIVE_STAGES = new Set(["planning", "ready"]);
const CACHE_STRATEGIES = new Set(["stable-catalog", "dynamic-catalog"]);

function equalToolLists(left, right) {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getCurrentBranch(ctx) {
  const manager = ctx?.sessionManager;
  if (!manager) return [];
  if (typeof manager.getBranch === "function") return manager.getBranch();
  if (typeof manager.getEntries === "function") return manager.getEntries();
  return [];
}

function latestPlanState(ctx) {
  const branch = getCurrentBranch(ctx);
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type !== "custom" || entry.customType !== PLAN_STATE_ENTRY) continue;
    return isRecord(entry.data) ? entry.data : undefined;
  }
  return undefined;
}

function modeStateFingerprintFromEntry(entry) {
  const message = entry?.type === "message" ? entry.message : entry;
  if (message?.role !== "custom" || message.customType !== MODE_STATE_CUSTOM_TYPE) return undefined;
  const fingerprint = message.details?.fingerprint;
  return typeof fingerprint === "string" ? fingerprint : undefined;
}

function latestModeStateFingerprint(ctx) {
  const branch = getCurrentBranch(ctx);
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const fingerprint = modeStateFingerprintFromEntry(branch[index]);
    if (fingerprint) return fingerprint;
  }
  return undefined;
}

function runtimeMode(controllerMode, planState) {
  if (PLAN_ACTIVE_STAGES.has(planState?.stage)) return "plan";
  return PROFILE_NAMES.includes(controllerMode) ? controllerMode : "normal";
}

function blockedReason(mode, toolName, allowedTools, planState) {
  if (toolName === LEGACY_EXIT_PLAN_MODE_TOOL) {
    return "Plan approval and execution are user-controlled; ExitPlanMode is not callable by the model.";
  }
  if (mode === "plan" && planState?.stage === "ready") {
    return `Plan Ready blocks ${toolName}; the published plan is awaiting an explicit user action.`;
  }
  const label = mode === "ask" ? "Ask Mode" : mode === "plan" ? "Plan Mode" : "Normal Mode";
  return `${label} blocks ${toolName}. Allowed tools: ${allowedTools.join(", ") || "none"}.`;
}

export class ToolProfileController {
  constructor(pi, options = {}) {
    this.pi = pi;
    this.mode = "normal";
    this.cacheStrategy = CACHE_STRATEGIES.has(options.cacheStrategy)
      ? options.cacheStrategy
      : "stable-catalog";
    // Extension action methods are unavailable while extensions are being loaded.
    // The normal profile is initialized from runtime state during session_start instead.
    const initial = uniqueToolNames(options.initialTools ?? []);
    this.profiles = new Map([
      ["normal", initial],
      ["ask", []],
      ["plan", []],
    ]);
    this.catalogTools = [];
    this.catalogInitialized = false;
    this.lastModeStateFingerprint = undefined;
    this.forceModeStateMessage = false;

    this.installRuntimePolicy();
  }

  installRuntimePolicy() {
    if (typeof this.pi.on !== "function") return;

    this.pi.on("session_start", async () => {
      // A replacement session has its own prompt-cache key. Restore the previous
      // Normal allowlist before default discovery, then build a fresh catalog for
      // the new session once configuration is loaded by the host extension.
      const normalTools = this.getEffectiveTools("normal");
      const current = uniqueToolNames(this.pi.getActiveTools?.() ?? []);
      if (normalTools.length > 0 && !equalToolLists(current, normalTools)) {
        this.pi.setActiveTools(normalTools);
      }
      this.mode = "normal";
      this.catalogTools = [];
      this.catalogInitialized = false;
      this.lastModeStateFingerprint = undefined;
      this.forceModeStateMessage = true;
    });

    this.pi.on("session_tree", async () => {
      // The selected branch may contain a different last mode-state message or
      // a compaction boundary that no longer carries the previous state block.
      this.lastModeStateFingerprint = undefined;
      this.forceModeStateMessage = true;
    });

    this.pi.on("session_compact", async () => {
      // Compaction may summarize away hidden custom messages even though their
      // original entries remain in the session tree. Re-emit the state once.
      this.lastModeStateFingerprint = undefined;
      this.forceModeStateMessage = true;
    });

    this.pi.on("before_agent_start", async (event, ctx) => {
      this.apply();
      const state = this.getRuntimeState(ctx);
      const fingerprint = fingerprintModeState(state.snapshot);
      const persistedFingerprint = latestModeStateFingerprint(ctx);
      const messageChanged =
        this.forceModeStateMessage ||
        (fingerprint !== this.lastModeStateFingerprint && fingerprint !== persistedFingerprint);
      this.lastModeStateFingerprint = fingerprint;
      this.forceModeStateMessage = false;

      const result = {};
      // Ask and Plan handlers append the same fixed protocol later in extension
      // order. Normal has no mode-specific handler, so the controller owns it.
      if (state.mode === "normal") {
        result.systemPrompt = appendModeProtocol(event.systemPrompt);
      }
      if (messageChanged) result.message = createModeStateMessage(state.snapshot);
      return Object.keys(result).length > 0 ? result : undefined;
    });

    this.pi.on("before_provider_request", (event, ctx) => {
      const state = this.getRuntimeState(ctx);
      return rewriteOpenAIResponsesToolChoice(event.payload, ctx?.model, state.allowedTools);
    });

    this.pi.on("tool_call", (event, ctx) => {
      const state = this.getRuntimeState(ctx);
      if (state.allowedTools.includes(event.toolName)) return;
      return {
        block: true,
        reason: blockedReason(state.mode, event.toolName, state.allowedTools, state.planState),
      };
    });
  }

  assertProfile(profile) {
    if (!this.profiles.has(profile)) throw new Error(`Unknown tool profile: ${profile}`);
  }

  setProfile(profile, names, options = {}) {
    this.assertProfile(profile);
    this.profiles.set(profile, uniqueToolNames(names));
    if (options.activate === true) this.mode = profile;
    if (options.apply === false || (options.activate !== true && this.mode !== profile)) {
      return this.getEffectiveTools(profile);
    }
    return this.apply();
  }

  activate(profile, names) {
    this.assertProfile(profile);
    if (names !== undefined) this.profiles.set(profile, uniqueToolNames(names));
    this.mode = profile;
    return this.apply();
  }

  getRequestedTools(profile = this.mode) {
    this.assertProfile(profile);
    return [...(this.profiles.get(profile) ?? [])];
  }

  getRegisteredToolOrder() {
    return uniqueToolNames(
      (this.pi.getAllTools?.() ?? [])
        .map((tool) => tool?.name)
        .filter((name) => typeof name === "string" && name.length > 0),
    );
  }

  getRegisteredToolNames() {
    return new Set(this.getRegisteredToolOrder());
  }

  getUnavailableTools(names) {
    const registered = this.getRegisteredToolNames();
    return uniqueToolNames(names).flatMap((name) =>
      registered.has(name) ? [] : [{ name, reason: "not registered" }],
    );
  }

  getEffectiveTools(profile = this.mode) {
    const unavailable = new Set(this.getUnavailableTools(this.getRequestedTools(profile)).map((entry) => entry.name));
    return this.getRequestedTools(profile).filter((name) => !unavailable.has(name));
  }

  getAllowedTools(profile = this.mode, planState) {
    this.assertProfile(profile);
    if (profile === "plan" && planState?.stage === "ready") return [];
    return this.getEffectiveTools(profile);
  }

  getCatalogCandidates() {
    const requested = new Set(
      PROFILE_NAMES.flatMap((profile) => this.getEffectiveTools(profile)),
    );
    return this.getRegisteredToolOrder().filter((name) => requested.has(name));
  }

  syncStableCatalog() {
    const candidates = this.getCatalogCandidates();
    if (!this.catalogInitialized) {
      this.catalogTools = candidates;
      this.catalogInitialized = true;
    } else {
      const known = new Set(this.catalogTools);
      for (const name of candidates) {
        if (known.has(name)) continue;
        known.add(name);
        this.catalogTools.push(name);
      }
    }

    const registered = this.getRegisteredToolNames();
    const availableCatalog = this.catalogTools.filter((name) => registered.has(name));
    const current = uniqueToolNames(this.pi.getActiveTools?.() ?? []);
    if (!equalToolLists(current, availableCatalog)) this.pi.setActiveTools(availableCatalog);
    return availableCatalog;
  }

  apply() {
    if (this.cacheStrategy === "dynamic-catalog") {
      const effective = this.getEffectiveTools();
      const current = uniqueToolNames(this.pi.getActiveTools?.() ?? []);
      if (!equalToolLists(current, effective)) this.pi.setActiveTools(effective);
      return effective;
    }
    return this.syncStableCatalog();
  }

  getRuntimeState(ctx) {
    const planState = latestPlanState(ctx);
    const mode = runtimeMode(this.mode, planState);
    const allowedTools = this.getAllowedTools(mode, planState);
    return {
      mode,
      planState,
      allowedTools,
      snapshot: buildModeStateSnapshot({ mode, allowedTools, planState }),
    };
  }

  snapshot(ctx) {
    const runtime = this.getRuntimeState(ctx);
    return {
      mode: runtime.mode,
      cacheStrategy: this.cacheStrategy,
      requested: {
        normal: this.getRequestedTools("normal"),
        ask: this.getRequestedTools("ask"),
        plan: this.getRequestedTools("plan"),
      },
      effective: {
        normal: this.getEffectiveTools("normal"),
        ask: this.getEffectiveTools("ask"),
        plan: this.getEffectiveTools("plan"),
      },
      allowedTools: runtime.allowedTools,
      catalogTools:
        this.cacheStrategy === "stable-catalog"
          ? this.catalogTools.filter((name) => this.getRegisteredToolNames().has(name))
          : this.getEffectiveTools(),
      // Backward-compatible field: this is what Pi currently exposes to the provider.
      activeTools: uniqueToolNames(this.pi.getActiveTools?.() ?? []),
    };
  }
}

export function createToolProfileController(pi, options) {
  return new ToolProfileController(pi, options);
}

export const __test = {
  blockedReason,
  equalToolLists,
  getCurrentBranch,
  latestModeStateFingerprint,
  latestPlanState,
  modeStateFingerprintFromEntry,
  runtimeMode,
};

import { truncateToWidth } from "@earendil-works/pi-tui";
import {
  DEFAULT_ASK_TOOLS,
  isAskToolConfigurable,
  normalizeAskTools,
} from "./ask-mode-policy.js";
import { loadPlanModeConfig, savePlanModeConfig } from "./plan/config.js";
import {
  ENTER_PLAN_MODE_TOOL,
  LEGACY_EXIT_PLAN_MODE_TOOL,
  PLAN_WRITE_TOOL,
} from "./plan/constants.js";
import { THINKING_LEVELS } from "./plan/types.js";
import {
  loadProfileConfig,
  PROFILE_NAMES,
  saveProfileConfig,
} from "./profile-config.js";

const PROFILE_LABELS = Object.freeze({
  normal: "Normal",
  ask: "Ask",
  plan: "Plan",
});
const CONTROL_TOOLS = new Set([ENTER_PLAN_MODE_TOOL, PLAN_WRITE_TOOL]);
const MODEL_ROW = 0;
const EFFORT_ROW = 1;
const TOOL_ROW_OFFSET = 2;
const MAX_VISIBLE_TOOLS = 18;

function isChineseLocale() {
  const locale =
    process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || "";
  return /^zh(?:[_\-.]|$)/i.test(locale);
}

function copy() {
  return isChineseLocale()
    ? {
        title: "Only Tools",
        model: "Model",
        effort: "Effort",
        modelCurrent: "Pi 当前",
        effortCurrent: "Pi 当前",
        inheritNormal: "继承 Normal",
        lockedRequired: "Plan 工作流必需",
        lockedControl: "该 Profile 不使用此控制工具",
        lockedAskWrite: "Ask 模式禁止命令/编辑工具",
        askPolicy: "Ask 列是显式只读 allowlist；第三方/MCP 工具请仅启用读取类操作。",
        unregistered: "当前未注册",
        help: "↑↓ 行  ←→ Profile  Enter/Space 切换  M 模型  E/T Effort  A/N/R  Esc 保存",
        saved: "Profile 工具矩阵已保存",
        requiresTui: "Profile 工具矩阵仅在 Pi TUI 模式中可用。",
      }
    : {
        title: "Only Tools",
        model: "Model",
        effort: "Effort",
        modelCurrent: "Pi current",
        effortCurrent: "Pi current",
        inheritNormal: "inherit Normal",
        lockedRequired: "required by Plan workflow",
        lockedControl: "control tool is not used by this profile",
        lockedAskWrite: "command/edit tool is blocked in Ask Mode",
        askPolicy: "Ask is an explicit read-only allowlist; enable only read operations for third-party/MCP tools.",
        unregistered: "not registered now",
        help: "↑↓ row  ←→ profile  Enter/Space toggle  M model  E/T effort  A/N/R  Esc save",
        saved: "Tool profile matrix saved",
        requiresTui: "The tool profile matrix is available only in Pi TUI mode.",
      };
}

function modelKey(model) {
  return `${model.provider}/${model.id}`;
}

function selectableModels(ctx) {
  const scoped = ctx.scopedModels ?? [];
  const candidates =
    scoped.length > 0
      ? scoped.map((entry) => entry.model)
      : (ctx.modelRegistry?.getAvailable?.() ?? (ctx.model ? [ctx.model] : []));
  const byKey = new Map();
  for (const model of candidates) {
    if (model?.provider && model?.id) byKey.set(modelKey(model), model);
  }
  return [...byKey.values()].sort((a, b) =>
    modelKey(a).localeCompare(modelKey(b)),
  );
}

function formatModel(profile, fallback) {
  return profile?.provider && profile?.model
    ? `${profile.provider}/${profile.model}`
    : fallback;
}

function clearModel(profile) {
  const next = { ...(profile ?? {}) };
  delete next.provider;
  delete next.model;
  return next;
}

function clearThinking(profile) {
  const next = { ...(profile ?? {}) };
  delete next.thinkingLevel;
  return next;
}

async function selectModel(ctx, profileName, profile) {
  const models = selectableModels(ctx);
  const inherit = "Inherit current/default model";
  const labels = models.map((model) => {
    const suffix =
      model.name && model.name !== model.id ? ` — ${model.name}` : "";
    return `${modelKey(model)}${suffix}`;
  });
  const choice = await ctx.ui.select(`${PROFILE_LABELS[profileName]} model`, [
    inherit,
    ...labels,
  ]);
  if (!choice) return profile;
  if (choice === inherit) return clearModel(profile);
  const index = labels.indexOf(choice);
  const model = index >= 0 ? models[index] : undefined;
  return model
    ? { ...(profile ?? {}), provider: model.provider, model: model.id }
    : profile;
}

async function selectThinking(ctx, profileName, profile) {
  const inherit = "Inherit current/default effort";
  const choice = await ctx.ui.select(`${PROFILE_LABELS[profileName]} effort`, [
    inherit,
    ...THINKING_LEVELS,
  ]);
  if (!choice) return profile;
  if (choice === inherit) return clearThinking(profile);
  return THINKING_LEVELS.includes(choice)
    ? { ...(profile ?? {}), thinkingLevel: choice }
    : profile;
}

function lockedCell(profile, toolName) {
  if (toolName === LEGACY_EXIT_PLAN_MODE_TOOL) {
    return { locked: true, value: false, reason: "control" };
  }
  if (toolName === PLAN_WRITE_TOOL) {
    return profile === "plan"
      ? { locked: true, value: true, reason: "required" }
      : { locked: true, value: false, reason: "control" };
  }
  if (toolName === ENTER_PLAN_MODE_TOOL && profile !== "normal") {
    return { locked: true, value: false, reason: "control" };
  }
  if (profile === "ask" && !isAskToolConfigurable(toolName)) {
    return { locked: true, value: false, reason: "ask" };
  }
  return { locked: false, value: undefined, reason: undefined };
}

function enforceProfileRules(profile, names) {
  const result = new Set(names ?? []);
  result.delete(LEGACY_EXIT_PLAN_MODE_TOOL);
  if (profile === "plan") {
    result.delete(ENTER_PLAN_MODE_TOOL);
    result.add(PLAN_WRITE_TOOL);
  } else {
    result.delete(PLAN_WRITE_TOOL);
  }
  if (profile === "ask") {
    result.delete(ENTER_PLAN_MODE_TOOL);
    return normalizeAskTools([...result]);
  }
  return [...result];
}

function storedProfileTools(profile, names) {
  return enforceProfileRules(profile, names).filter(
    (name) => !(profile === "plan" && name === PLAN_WRITE_TOOL),
  );
}

function toolRows(pi, config) {
  const registered = new Map();
  for (const tool of pi.getAllTools?.() ?? []) {
    if (!tool?.name || tool.name === LEGACY_EXIT_PLAN_MODE_TOOL) continue;
    registered.set(tool.name, {
      name: tool.name,
      registered: true,
      builtin: tool.sourceInfo?.source === "builtin",
    });
  }
  for (const profile of PROFILE_NAMES) {
    for (const name of config.profiles[profile] ?? []) {
      if (name === LEGACY_EXIT_PLAN_MODE_TOOL) continue;
      if (!registered.has(name)) {
        registered.set(name, {
          name,
          registered: false,
          builtin: false,
        });
      }
    }
  }
  for (const name of [ENTER_PLAN_MODE_TOOL, PLAN_WRITE_TOOL]) {
    if (!registered.has(name)) {
      registered.set(name, {
        name,
        registered: false,
        builtin: false,
      });
    }
  }
  return [...registered.values()].sort((a, b) => {
    const ai = CONTROL_TOOLS.has(a.name);
    const bi = CONTROL_TOOLS.has(b.name);
    if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
    if (ai !== bi) return ai ? 1 : -1;
    return a.name.localeCompare(b.name, "en");
  });
}

class ProfileMatrixComponent {
  constructor({
    tui,
    theme,
    done,
    config,
    defaults,
    tools,
    phaseProfiles,
    copyText,
    initialRow = MODEL_ROW,
    initialCol = 0,
  }) {
    this.tui = tui;
    this.theme = theme;
    this.done = done;
    this.config = config;
    this.defaults = defaults;
    this.tools = tools;
    this.phaseProfiles = phaseProfiles;
    this.copy = copyText;
    this.row = Math.max(0, Math.min(this.rowCount() - 1, initialRow));
    this.col = Math.max(0, Math.min(PROFILE_NAMES.length - 1, initialCol));
    this.scroll = 0;
    this.dirty = false;
  }

  rowCount() {
    return TOOL_ROW_OFFSET + this.tools.length;
  }

  currentProfile() {
    return PROFILE_NAMES[this.col];
  }

  currentTool() {
    if (this.row < TOOL_ROW_OFFSET) return undefined;
    return this.tools[this.row - TOOL_ROW_OFFSET];
  }

  currentKind() {
    if (this.row === MODEL_ROW) return "model";
    if (this.row === EFFORT_ROW) return "effort";
    return "tool";
  }

  phaseEditable(profile = this.currentProfile()) {
    return profile !== "ask";
  }

  phaseProfile(profile) {
    return profile === "plan"
      ? this.phaseProfiles.planning
      : this.phaseProfiles.normal;
  }

  selectedSet(profile = this.currentProfile()) {
    return new Set(this.config.profiles[profile] ?? []);
  }

  cellValue(profile, toolName) {
    const lock = lockedCell(profile, toolName);
    return lock.locked ? lock.value : this.selectedSet(profile).has(toolName);
  }

  toolCell(profile, tool) {
    const lock = lockedCell(profile, tool.name);
    const enabled = this.cellValue(profile, tool.name);
    let value = lock.locked ? (enabled ? "◆" : "◇") : enabled ? "●" : "○";
    if (!tool.registered) value += "?";
    return value;
  }

  toggleCurrentTool() {
    const profile = this.currentProfile();
    const tool = this.currentTool();
    if (!tool) return;
    const lock = lockedCell(profile, tool.name);
    if (lock.locked) return;
    const selected = this.selectedSet(profile);
    if (selected.has(tool.name)) selected.delete(tool.name);
    else selected.add(tool.name);
    this.config.profiles[profile] = storedProfileTools(profile, [...selected]);
    this.dirty = true;
  }

  setProfileTools(mode) {
    const profile = this.currentProfile();
    const next = new Set();
    if (mode === "all") {
      for (const tool of this.tools) {
        const lock = lockedCell(profile, tool.name);
        if (!lock.locked && tool.registered) next.add(tool.name);
      }
    } else if (mode === "reset") {
      for (const name of this.defaults[profile] ?? []) next.add(name);
    }
    this.config.profiles[profile] = storedProfileTools(profile, [...next]);
    this.dirty = true;
  }

  finish(action) {
    this.done({
      action,
      profile: this.currentProfile(),
      dirty: this.dirty,
      row: this.row,
      col: this.col,
    });
  }

  activateCurrent() {
    const kind = this.currentKind();
    if (kind === "model" && this.phaseEditable()) this.finish("model");
    else if (kind === "effort" && this.phaseEditable()) this.finish("thinking");
    else if (kind === "tool") this.toggleCurrentTool();
  }

  handleInput(data) {
    if (data === "\u001b[A") this.row = Math.max(0, this.row - 1);
    else if (data === "\u001b[B") {
      this.row = Math.min(this.rowCount() - 1, this.row + 1);
    } else if (data === "\u001b[D") this.col = Math.max(0, this.col - 1);
    else if (data === "\u001b[C") {
      this.col = Math.min(PROFILE_NAMES.length - 1, this.col + 1);
    } else if (data === "\r") this.activateCurrent();
    else if (data === " " && this.currentKind() === "tool") {
      this.toggleCurrentTool();
    } else if (data.toLowerCase?.() === "a") this.setProfileTools("all");
    else if (data.toLowerCase?.() === "n") this.setProfileTools("none");
    else if (data.toLowerCase?.() === "r") this.setProfileTools("reset");
    else if (data.toLowerCase?.() === "m" && this.phaseEditable()) {
      this.finish("model");
    } else if (
      ["e", "t"].includes(data.toLowerCase?.()) &&
      this.phaseEditable()
    ) {
      this.finish("thinking");
    } else if (
      data === "\u001b" ||
      data.toLowerCase?.() === "q" ||
      data.toLowerCase?.() === "s"
    ) {
      this.finish("save");
    }
    this.tui.requestRender?.();
  }

  visibleToolRange() {
    if (this.tools.length <= MAX_VISIBLE_TOOLS) {
      return { start: 0, end: this.tools.length };
    }
    const selectedTool = Math.max(0, this.row - TOOL_ROW_OFFSET);
    if (this.row >= TOOL_ROW_OFFSET) {
      if (selectedTool < this.scroll) this.scroll = selectedTool;
      if (selectedTool >= this.scroll + MAX_VISIBLE_TOOLS) {
        this.scroll = selectedTool - MAX_VISIBLE_TOOLS + 1;
      }
    }
    const maxStart = Math.max(0, this.tools.length - MAX_VISIBLE_TOOLS);
    this.scroll = Math.min(this.scroll, maxStart);
    return {
      start: this.scroll,
      end: Math.min(this.tools.length, this.scroll + MAX_VISIBLE_TOOLS),
    };
  }

  render(width) {
    const w = Math.max(48, Math.floor(width));
    const longestTool = this.tools.reduce(
      (max, tool) => Math.max(max, tool.name.length),
      0,
    );
    const maxLabelForWidth = Math.max(10, Math.floor(w * 0.35));
    const labelWidth = Math.min(
      30,
      maxLabelForWidth,
      Math.max(12, longestTool + 4),
    );
    const gap = 2;
    const availableProfileWidth = Math.max(
      7,
      Math.floor((w - labelWidth - gap * PROFILE_NAMES.length) / PROFILE_NAMES.length),
    );
    const profileWidth = Math.min(24, availableProfileWidth);
    const pad = (value, size) =>
      truncateToWidth(String(value), Math.max(1, size - 1), "…").padEnd(size);
    const isSelected = (rowIndex, colIndex) =>
      rowIndex === this.row && colIndex === this.col;
    const styleSelected = (value) =>
      this.theme.fg("accent", this.theme.bold(value));
    const renderCell = (value, rowIndex, colIndex) => {
      const padded = pad(value, profileWidth);
      return isSelected(rowIndex, colIndex) ? styleSelected(padded) : padded;
    };
    const renderRowLabel = (label, rowIndex) => {
      const padded = pad(
        `${rowIndex === this.row ? "›" : " "} ${label}`,
        labelWidth,
      );
      return rowIndex === this.row
        ? this.theme.fg("accent", this.theme.bold(padded))
        : padded;
    };
    const renderHeaderCell = (profile, colIndex) => {
      const name = PROFILE_LABELS[profile].toUpperCase();
      const padded = pad(
        colIndex === this.col ? `› ${name}` : `  ${name}`,
        profileWidth,
      );
      return colIndex === this.col
        ? this.theme.fg("accent", this.theme.bold(padded))
        : this.theme.fg("muted", padded);
    };

    const header = [
      pad("", labelWidth),
      ...PROFILE_NAMES.map(renderHeaderCell),
    ];

    const lines = [
      this.theme.bold(this.copy.title),
      header.join(" ".repeat(gap)),
    ];

    const modelValues = PROFILE_NAMES.map((profile) => {
      if (profile === "ask") return this.copy.inheritNormal;
      const phase = this.phaseProfile(profile);
      const fallback = profile === "normal" ? this.copy.modelCurrent : "inherit";
      return formatModel(phase, fallback);
    });
    lines.push(
      [
        renderRowLabel(this.copy.model, MODEL_ROW),
        ...modelValues.map((value, colIndex) =>
          renderCell(value, MODEL_ROW, colIndex),
        ),
      ].join(" ".repeat(gap)),
    );

    const effortValues = PROFILE_NAMES.map((profile) => {
      if (profile === "ask") return this.copy.inheritNormal;
      const phase = this.phaseProfile(profile);
      return (
        phase?.thinkingLevel ??
        (profile === "normal" ? this.copy.effortCurrent : "inherit")
      );
    });
    lines.push(
      [
        renderRowLabel(this.copy.effort, EFFORT_ROW),
        ...effortValues.map((value, colIndex) =>
          renderCell(value, EFFORT_ROW, colIndex),
        ),
      ].join(" ".repeat(gap)),
    );

    lines.push("");
    const { start, end } = this.visibleToolRange();
    this.tools.slice(start, end).forEach((tool, visibleIndex) => {
      const toolIndex = start + visibleIndex;
      const rowIndex = TOOL_ROW_OFFSET + toolIndex;
      const values = PROFILE_NAMES.map((profile) =>
        this.toolCell(profile, tool),
      );
      lines.push(
        [
          renderRowLabel(tool.name, rowIndex),
          ...values.map((value, colIndex) =>
            renderCell(value, rowIndex, colIndex),
          ),
        ].join(" ".repeat(gap)),
      );
    });

    const profile = this.currentProfile();
    const tool = this.currentTool();
    const notes = [];
    if (profile === "ask") notes.push(this.copy.askPolicy);
    if (tool) {
      const lock = lockedCell(profile, tool.name);
      if (!tool.registered) notes.push(`${tool.name}: ${this.copy.unregistered}`);
      if (lock.locked) {
        const reason =
          lock.reason === "required"
            ? this.copy.lockedRequired
            : lock.reason === "ask"
              ? this.copy.lockedAskWrite
              : this.copy.lockedControl;
        notes.push(`${tool.name}: ${reason}`);
      }
    }
    if (notes.length > 0) {
      lines.push("", ...notes.map((note) => this.theme.fg("muted", note)));
    }
    lines.push("", this.theme.fg("muted", this.copy.help));
    if (start > 0 || end < this.tools.length) {
      lines.push(
        this.theme.fg("dim", `tools ${start + 1}-${end}/${this.tools.length}`),
      );
    }
    return lines;
  }

  invalidate() {}
}

export function runtimeToolsForProfile(profile, names) {
  return enforceProfileRules(profile, names);
}

export async function openProfileMatrix(pi, ctx, options) {
  const text = copy();
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    ctx.ui.notify(text.requiresTui, "warning");
    return { saved: false };
  }

  const defaults = Object.fromEntries(
    PROFILE_NAMES.map((profile) => [
      profile,
      storedProfileTools(
        profile,
        options.defaults?.[profile] ?? (profile === "ask" ? DEFAULT_ASK_TOOLS : []),
      ),
    ]),
  );
  const loaded = await loadProfileConfig(options.configPath, defaults);
  for (const warning of loaded.warnings) ctx.ui.notify(warning, "warning");
  const config = {
    version: loaded.config.version,
    profiles: Object.fromEntries(
      PROFILE_NAMES.map((profile) => [
        profile,
        storedProfileTools(profile, loaded.config.profiles[profile]),
      ]),
    ),
  };

  const planLoaded = loadPlanModeConfig(ctx.cwd, {
    agentDir: options.agentDir,
    configDirName: options.configDirName,
    loadProjectConfig: false,
  });
  for (const warning of planLoaded.warnings) ctx.ui.notify(warning, "warning");
  const phaseProfiles = {
    planning: { ...planLoaded.globalConfig.planning },
    normal: { ...planLoaded.globalConfig.normal },
  };
  const tools = toolRows(pi, config);
  let dirty = loaded.migrated;
  let cursor = { row: MODEL_ROW, col: 0 };

  while (true) {
    const result = await ctx.ui.custom((tui, theme, _keybindings, done) =>
      new ProfileMatrixComponent({
        tui,
        theme,
        done,
        config,
        defaults,
        tools,
        phaseProfiles,
        copyText: text,
        initialRow: cursor.row,
        initialCol: cursor.col,
      }),
    );
    dirty = dirty || result?.dirty === true;
    cursor = {
      row: Number.isInteger(result?.row) ? result.row : cursor.row,
      col: Number.isInteger(result?.col) ? result.col : cursor.col,
    };
    if (result?.action === "model" || result?.action === "thinking") {
      const key = result.profile === "plan" ? "planning" : "normal";
      const before = JSON.stringify(phaseProfiles[key]);
      const next =
        result.action === "model"
          ? await selectModel(ctx, result.profile, phaseProfiles[key])
          : await selectThinking(ctx, result.profile, phaseProfiles[key]);
      phaseProfiles[key] = next;
      if (JSON.stringify(next) !== before) dirty = true;
      continue;
    }
    break;
  }

  if (!dirty) return { saved: false, config };
  const savedConfig = await saveProfileConfig(options.configPath, config);
  await savePlanModeConfig(planLoaded.globalPath, {
    planning: phaseProfiles.planning,
    normal: phaseProfiles.normal,
  });

  if (options.toolProfiles) {
    for (const profile of PROFILE_NAMES) {
      options.toolProfiles.setProfile(
        profile,
        runtimeToolsForProfile(profile, savedConfig.profiles[profile]),
        { apply: false },
      );
    }
    options.toolProfiles.apply();
  }
  ctx.ui.notify(`${text.saved}: ${options.configPath}`, "info");
  return { saved: true, config: savedConfig, phaseProfiles };
}

export const __test = {
  ProfileMatrixComponent,
  lockedCell,
  storedProfileTools,
  toolRows,
};

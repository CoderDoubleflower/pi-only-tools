import { truncateToWidth } from "@earendil-works/pi-tui";
import { loadPlanModeConfig, savePlanModeConfig } from "./plan/config.js";
import {
  ENTER_PLAN_MODE_TOOL,
  EXIT_PLAN_MODE_TOOL,
  PLAN_WRITE_TOOL,
} from "./plan/constants.js";
import { THINKING_LEVELS } from "./plan/types.js";
import { loadProfileConfig, PROFILE_NAMES, saveProfileConfig } from "./profile-config.js";

const PROFILE_LABELS = Object.freeze({
  normal: "Normal",
  plan: "Plan",
});
const CONTROL_TOOLS = new Set([ENTER_PLAN_MODE_TOOL, PLAN_WRITE_TOOL, EXIT_PLAN_MODE_TOOL]);
const CELL_WIDTH = 11;
const PROFILE_WIDTH = 11;
const MODEL_WIDTH = 22;
const THINK_WIDTH = 9;

function isChineseLocale() {
  const locale = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || "";
  return /^zh(?:[_\-.]|$)/i.test(locale);
}

function copy() {
  return isChineseLocale()
    ? {
        title: "工具 Profile 矩阵",
        subtitle: "所有勾选都是持久配置；行是 Profile，列是工具。",
        modelCurrent: "Pi 当前",
        thinkingCurrent: "Pi 当前",
        selected: "当前",
        lockedRequired: "Plan 工作流必需",
        lockedControl: "该 Profile 不使用此控制工具",
        unregistered: "当前未注册",
        help: "↑↓ Profile  ←→ 工具  Space/Enter 切换  M 模型  T 思考强度  A 全选  N 清空  R 重置  Esc 保存",
        saved: "Profile 工具矩阵已保存",
        requiresTui: "Profile 工具矩阵仅在 Pi TUI 模式中可用。",
        normalModel: "Normal 与 Plan 的模型/思考强度都可在此配置；inherit 表示继承当前/default。",
      }
    : {
        title: "Tool profile matrix",
        subtitle: "Every selection is persistent; profiles are rows and tools are columns.",
        modelCurrent: "Pi current",
        thinkingCurrent: "Pi current",
        selected: "Selected",
        lockedRequired: "required by Plan workflow",
        lockedControl: "control tool is not used by this profile",
        unregistered: "not registered now",
        help: "↑↓ profile  ←→ tool  Space/Enter toggle  M model  T thinking  A all  N none  R reset  Esc save",
        saved: "Tool profile matrix saved",
        requiresTui: "The tool profile matrix is available only in Pi TUI mode.",
        normalModel: "Normal and Plan model/thinking are configured here; inherit uses the current/default value.",
      };
}

function modelKey(model) {
  return `${model.provider}/${model.id}`;
}

function selectableModels(ctx) {
  const scoped = ctx.scopedModels ?? [];
  const candidates = scoped.length > 0
    ? scoped.map((entry) => entry.model)
    : ctx.modelRegistry?.getAvailable?.() ?? (ctx.model ? [ctx.model] : []);
  const byKey = new Map();
  for (const model of candidates) {
    if (model?.provider && model?.id) byKey.set(modelKey(model), model);
  }
  return [...byKey.values()].sort((a, b) => modelKey(a).localeCompare(modelKey(b)));
}

function formatModel(profile, normalLabel) {
  return profile?.provider && profile?.model ? `${profile.provider}/${profile.model}` : normalLabel;
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
    const suffix = model.name && model.name !== model.id ? ` — ${model.name}` : "";
    return `${modelKey(model)}${suffix}`;
  });
  const choice = await ctx.ui.select(`${PROFILE_LABELS[profileName]} model`, [inherit, ...labels]);
  if (!choice) return profile;
  if (choice === inherit) return clearModel(profile);
  const index = labels.indexOf(choice);
  const model = index >= 0 ? models[index] : undefined;
  return model ? { ...(profile ?? {}), provider: model.provider, model: model.id } : profile;
}

async function selectThinking(ctx, profileName, profile) {
  const inherit = "Inherit current/default thinking level";
  const choice = await ctx.ui.select(`${PROFILE_LABELS[profileName]} thinking`, [inherit, ...THINKING_LEVELS]);
  if (!choice) return profile;
  if (choice === inherit) return clearThinking(profile);
  return THINKING_LEVELS.includes(choice)
    ? { ...(profile ?? {}), thinkingLevel: choice }
    : profile;
}

function lockedCell(profile, toolName) {
  if (toolName === PLAN_WRITE_TOOL || toolName === EXIT_PLAN_MODE_TOOL) {
    return profile === "plan"
      ? { locked: true, value: true, reason: "required" }
      : { locked: true, value: false, reason: "control" };
  }
  if (toolName === ENTER_PLAN_MODE_TOOL && profile !== "normal") {
    return { locked: true, value: false, reason: "control" };
  }
  return { locked: false, value: undefined, reason: undefined };
}

function enforceProfileRules(profile, names) {
  const result = new Set(names ?? []);
  if (profile === "plan") {
    result.delete(ENTER_PLAN_MODE_TOOL);
    result.add(PLAN_WRITE_TOOL);
    result.add(EXIT_PLAN_MODE_TOOL);
  } else {
    result.delete(PLAN_WRITE_TOOL);
    result.delete(EXIT_PLAN_MODE_TOOL);
  }
  return [...result];
}

function storedProfileTools(profile, names) {
  return enforceProfileRules(profile, names).filter((name) => {
    if (profile === "plan" && (name === PLAN_WRITE_TOOL || name === EXIT_PLAN_MODE_TOOL)) return false;
    return true;
  });
}

function toolColumns(pi, config) {
  const registered = new Map();
  for (const tool of pi.getAllTools?.() ?? []) {
    if (!tool?.name) continue;
    registered.set(tool.name, {
      name: tool.name,
      registered: true,
      builtin: tool.sourceInfo?.source === "builtin",
    });
  }
  for (const profile of PROFILE_NAMES) {
    for (const name of config.profiles[profile] ?? []) {
      if (!registered.has(name)) registered.set(name, { name, registered: false, builtin: false });
    }
  }
  for (const name of [ENTER_PLAN_MODE_TOOL, PLAN_WRITE_TOOL, EXIT_PLAN_MODE_TOOL]) {
    if (!registered.has(name)) registered.set(name, { name, registered: false, builtin: false });
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
  constructor({ tui, theme, done, config, defaults, tools, phaseProfiles, copyText }) {
    this.tui = tui;
    this.theme = theme;
    this.done = done;
    this.config = config;
    this.defaults = defaults;
    this.tools = tools;
    this.phaseProfiles = phaseProfiles;
    this.copy = copyText;
    this.row = 0;
    this.col = 0;
    this.scroll = 0;
    this.dirty = false;
  }

  currentProfile() {
    return PROFILE_NAMES[this.row];
  }

  currentTool() {
    return this.tools[this.col];
  }

  selectedSet(profile = this.currentProfile()) {
    return new Set(this.config.profiles[profile] ?? []);
  }

  cellValue(profile, toolName) {
    const lock = lockedCell(profile, toolName);
    return lock.locked ? lock.value : this.selectedSet(profile).has(toolName);
  }

  toggleCurrent() {
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

  setRow(mode) {
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

  handleInput(data) {
    if (data === "\u001b[A") this.row = Math.max(0, this.row - 1);
    else if (data === "\u001b[B") this.row = Math.min(PROFILE_NAMES.length - 1, this.row + 1);
    else if (data === "\u001b[D") this.col = Math.max(0, this.col - 1);
    else if (data === "\u001b[C") this.col = Math.min(Math.max(0, this.tools.length - 1), this.col + 1);
    else if (data === " " || data === "\r") this.toggleCurrent();
    else if (data.toLowerCase?.() === "a") this.setRow("all");
    else if (data.toLowerCase?.() === "n") this.setRow("none");
    else if (data.toLowerCase?.() === "r") this.setRow("reset");
    else if (data.toLowerCase?.() === "m") this.done({ action: "model", profile: this.currentProfile(), dirty: this.dirty });
    else if (data.toLowerCase?.() === "t") this.done({ action: "thinking", profile: this.currentProfile(), dirty: this.dirty });
    else if (data === "\u001b" || data.toLowerCase?.() === "q" || data.toLowerCase?.() === "s") {
      this.done({ action: "save", dirty: this.dirty });
    }
    this.tui.requestRender?.();
  }

  visibleRange(width) {
    const fixed = PROFILE_WIDTH + MODEL_WIDTH + THINK_WIDTH + 6;
    const count = Math.max(1, Math.floor((Math.max(1, width) - fixed) / CELL_WIDTH));
    if (this.col < this.scroll) this.scroll = this.col;
    if (this.col >= this.scroll + count) this.scroll = this.col - count + 1;
    const maxStart = Math.max(0, this.tools.length - count);
    this.scroll = Math.min(this.scroll, maxStart);
    return { start: this.scroll, end: Math.min(this.tools.length, this.scroll + count) };
  }

  render(width) {
    const w = Math.max(40, Math.floor(width));
    const { start, end } = this.visibleRange(w);
    const visible = this.tools.slice(start, end);
    const pad = (value, size) => truncateToWidth(String(value), size - 1, "…").padEnd(size);
    const header = [pad("Profile", PROFILE_WIDTH), pad("Model", MODEL_WIDTH), pad("Think", THINK_WIDTH)];
    for (const tool of visible) header.push(pad(tool.name, CELL_WIDTH));
    const lines = [
      this.theme.bold(this.copy.title),
      this.theme.fg("dim", this.copy.subtitle),
      "",
      this.theme.fg("muted", header.join(" ")),
    ];

    PROFILE_NAMES.forEach((profile, rowIndex) => {
      const phase = profile === "plan" ? this.phaseProfiles.planning : this.phaseProfiles.normal;
      const model = formatModel(phase, profile === "normal" ? this.copy.modelCurrent : "inherit");
      const thinking = phase?.thinkingLevel ?? (profile === "normal" ? this.copy.thinkingCurrent : "inherit");
      const row = [
        pad(`${rowIndex === this.row ? ">" : " "}${PROFILE_LABELS[profile]}`, PROFILE_WIDTH),
        pad(model, MODEL_WIDTH),
        pad(thinking, THINK_WIDTH),
      ];
      visible.forEach((tool, offset) => {
        const absolute = start + offset;
        const value = this.cellValue(profile, tool.name);
        const lock = lockedCell(profile, tool.name);
        let cell = lock.locked ? (value ? "[■]" : "[·]") : value ? "[x]" : "[ ]";
        if (!tool.registered) cell += "?";
        if (rowIndex === this.row && absolute === this.col) cell = `>${cell}<`;
        row.push(pad(cell, CELL_WIDTH));
      });
      lines.push(row.join(" "));
    });

    const tool = this.currentTool();
    if (tool) {
      const profile = this.currentProfile();
      const lock = lockedCell(profile, tool.name);
      let detail = `${this.copy.selected}: ${PROFILE_LABELS[profile]} × ${tool.name}`;
      if (!tool.registered) detail += ` · ${this.copy.unregistered}`;
      if (lock.locked) detail += ` · ${lock.reason === "required" ? this.copy.lockedRequired : this.copy.lockedControl}`;
      lines.push("", this.theme.fg("muted", detail));
    }
    if (this.currentProfile() === "normal") lines.push(this.theme.fg("dim", this.copy.normalModel));
    lines.push(this.theme.fg("muted", this.copy.help));
    if (start > 0 || end < this.tools.length) {
      lines.push(this.theme.fg("dim", `tools ${start + 1}-${end}/${this.tools.length}`));
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

  const defaults = Object.fromEntries(PROFILE_NAMES.map((profile) => [
    profile,
    storedProfileTools(profile, options.defaults?.[profile] ?? []),
  ]));
  const loaded = await loadProfileConfig(options.configPath, defaults);
  for (const warning of loaded.warnings) ctx.ui.notify(warning, "warning");
  const config = {
    version: loaded.config.version,
    profiles: Object.fromEntries(PROFILE_NAMES.map((profile) => [
      profile,
      storedProfileTools(profile, loaded.config.profiles[profile]),
    ])),
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
  const tools = toolColumns(pi, config);
  let dirty = loaded.migrated;

  while (true) {
    const result = await ctx.ui.custom((tui, theme, _keybindings, done) => new ProfileMatrixComponent({
      tui,
      theme,
      done,
      config,
      defaults,
      tools,
      phaseProfiles,
      copyText: text,
    }));
    dirty = dirty || result?.dirty === true;
    if (result?.action === "model" || result?.action === "thinking") {
      const key = result.profile === "plan" ? "planning" : "normal";
      phaseProfiles[key] = result.action === "model"
        ? await selectModel(ctx, result.profile, phaseProfiles[key])
        : await selectThinking(ctx, result.profile, phaseProfiles[key]);
      dirty = true;
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
      options.toolProfiles.setProfile(profile, runtimeToolsForProfile(profile, savedConfig.profiles[profile]), { apply: false });
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
  toolColumns,
};

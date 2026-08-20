import { readFile, writeFile } from "node:fs/promises";

async function read(path) {
  return readFile(path, "utf8");
}
async function write(path, content) {
  await writeFile(path, content, "utf8");
}
function replaceOnce(content, search, replacement, label) {
  const index = content.indexOf(search);
  if (index < 0) throw new Error(`Patch target not found: ${label}`);
  if (content.indexOf(search, index + search.length) >= 0) throw new Error(`Patch target not unique: ${label}`);
  return content.slice(0, index) + replacement + content.slice(index + search.length);
}
function replaceBetween(content, start, end, replacement, label) {
  const a = content.indexOf(start);
  if (a < 0) throw new Error(`Patch start not found: ${label}`);
  const b = content.indexOf(end, a + start.length);
  if (b < 0) throw new Error(`Patch end not found: ${label}`);
  return content.slice(0, a) + replacement + content.slice(b);
}

let index = await read("src/index.js");
index = replaceOnce(
  index,
  'import { registerClaudePlanMode } from "./plan/index.js";\n',
  'import { registerClaudePlanMode } from "./plan/index.js";\n' +
    'import { loadPlanModeConfig } from "./plan/config.js";\n' +
    'import { ENTER_PLAN_MODE_TOOL } from "./plan/constants.js";\n' +
    'import { getEffectivePlanningToolSelection } from "./plan/tool-set.js";\n' +
    'import { loadProfileConfig, PROFILE_NAMES, saveProfileConfig } from "./profile-config.js";\n' +
    'import { openProfileMatrix, runtimeToolsForProfile } from "./profile-matrix-ui.js";\n',
  "index imports",
);

const runtimeBlock = `  let loadedProfileConfig;\n  let planMode;\n\n  const getProfileDefaults = (ctx) => {\n    const allNames = new Set((pi.getAllTools?.() ?? []).map((tool) => tool.name));\n    const normal = (pi.getActiveTools?.() ?? []).filter((name) => !PLAN_REQUIRED_TOOL_SET.has(name));\n    const planConfig = loadPlanModeConfig(ctx.cwd, {\n      agentDir: getAgentDir(),\n      configDirName: CONFIG_DIR_NAME,\n      loadProjectConfig: false,\n    });\n    const plan = getEffectivePlanningToolSelection(planConfig.globalConfig.tools, allNames);\n    const execution = normal.filter((name) => name !== ENTER_PLAN_MODE_TOOL);\n    return { normal, plan, execution };\n  };\n\n  const applyProfileConfig = (config) => {\n    toolProfiles.setPermanentDisabled([], { apply: false });\n    for (const profile of PROFILE_NAMES) {\n      toolProfiles.setProfile(\n        profile,\n        runtimeToolsForProfile(profile, config.profiles[profile]),\n        { apply: false },\n      );\n    }\n    return toolProfiles.apply();\n  };\n\n  const restoreToolState = async (ctx) => {\n    const defaults = getProfileDefaults(ctx);\n    const loaded = await loadProfileConfig(getToolsConfigPath(), defaults);\n    for (const warning of loaded.warnings) ctx.ui.notify(warning, "warning");\n    loadedProfileConfig = loaded.config;\n    if (loaded.migrated) loadedProfileConfig = await saveProfileConfig(getToolsConfigPath(), loadedProfileConfig);\n    applyProfileConfig(loadedProfileConfig);\n  };\n\n  pi.on?.("session_start", async (_event, ctx) => restoreToolState(ctx));\n  pi.on?.("session_tree", async (_event, ctx) => restoreToolState(ctx));\n  pi.on?.("before_agent_start", async () => {\n    toolProfiles.setPermanentDisabled([], { apply: false });\n    toolProfiles.apply();\n  });\n\n  const openUnifiedSettings = async (ctx) => {\n    const defaults = loadedProfileConfig?.profiles ?? getProfileDefaults(ctx);\n    const result = await openProfileMatrix(pi, ctx, {\n      configPath: getToolsConfigPath(),\n      agentDir: getAgentDir(),\n      configDirName: CONFIG_DIR_NAME,\n      defaults,\n      toolProfiles,\n    });\n    if (result.saved && result.config) {\n      loadedProfileConfig = result.config;\n      const normal = new Set(result.config.profiles.normal);\n      const builtins = getBuiltinTools(pi);\n      await writeDefaultToolsSetting(builtins.map((tool) => tool.name).filter((name) => normal.has(name)));\n    }\n    return result;\n  };\n\n`;
index = replaceBetween(
  index,
  "  let enabledTools = new Set();\n",
  "  const supportsPlanModeRuntime = [\n",
  runtimeBlock + "  const supportsPlanModeRuntime = [\n",
  "legacy session/permanent runtime block",
);
index = replaceOnce(
  index,
  '  const planMode = supportsPlanModeRuntime\n    ? registerClaudePlanMode(pi, { toolProfiles })\n',
  '  planMode = supportsPlanModeRuntime\n    ? registerClaudePlanMode(pi, { toolProfiles, openUnifiedConfig: openUnifiedSettings })\n',
  "plan mode registration",
);
const oldMenuStart = "  const openProfileMenu = async (ctx) => {\n";
const oldMenuEnd = "  pi.registerCommand(\"only-tools\", {\n";
const newMenu = `  const openSettings = async (args, ctx) => {\n    const requested = args.trim().toLowerCase();\n    if (requested === "status") {\n      ctx.ui.notify(JSON.stringify({ planStage: planMode.getStage?.(), ...toolProfiles.snapshot() }, null, 2), "info");\n      return;\n    }\n    if (["", "profiles", "profile", "plan", "plan-mode", "session", "tools"].includes(requested)) {\n      const result = await openUnifiedSettings(ctx);\n      if (result.saved) await planMode.applySavedConfiguration?.(ctx);\n      return;\n    }\n    ctx.ui.notify("Use /only-tools to edit the persistent profile × tool matrix, or /only-tools status to inspect effective tools.", "info");\n  };\n\n  pi.registerCommand("only-tools", {\n`;
index = replaceBetween(index, oldMenuStart, oldMenuEnd, newMenu, "profile menu routing");
await write("src/index.js", index);

let planIndex = await read("src/plan/index.js");
planIndex = replaceOnce(
  planIndex,
  `    function selectedPlanningTools(current = state, names = allToolNames()) {\n        return getEffectivePlanningToolSelection(current?.planningTools, names);\n    }\n    function activePlanningTools(current = state, names = allToolNames()) {\n        const selected = selectedPlanningTools(current, names);\n        if (!toolProfiles)\n            return selected;\n        const active = new Set(toolProfiles.getEffectiveTools("plan"));\n        return selected.filter((name) => active.has(name));\n    }`,
  `    function selectedPlanningTools(current = state, names = allToolNames()) {\n        if (toolProfiles)\n            return getEffectivePlanningToolSelection(toolProfiles.getRequestedTools("plan"), names);\n        return getEffectivePlanningToolSelection(current?.planningTools, names);\n    }\n    function activePlanningTools(current = state, names = allToolNames()) {\n        if (!toolProfiles)\n            return selectedPlanningTools(current, names);\n        return getEffectivePlanningToolSelection(toolProfiles.getEffectiveTools("plan"), names);\n    }`,
  "controller-owned planning tools",
);
planIndex = planIndex.replaceAll("loadProjectConfig: ctx.isProjectTrusted(),", "loadProjectConfig: false,");
planIndex = replaceOnce(
  planIndex,
  `        const names = allToolNames();\n        const planningTools = getEffectivePlanningToolSelection(loaded.config.tools, names);\n        const next = commitState({`,
  `        const names = allToolNames();\n        const planningTools = selectedPlanningTools(current, names);\n        const next = commitState({`,
  "apply saved planning tools",
);
planIndex = replaceOnce(
  planIndex,
  `        const result = await openPlanModeConfig(pi, ctx, {\n            agentDir: getAgentDir(),\n            configDirName: CONFIG_DIR_NAME,\n            toolProfiles,\n        });`,
  `        const result = options.openUnifiedConfig\n            ? await options.openUnifiedConfig(ctx)\n            : await openPlanModeConfig(pi, ctx, {\n                agentDir: getAgentDir(),\n                configDirName: CONFIG_DIR_NAME,\n                toolProfiles,\n            });`,
  "unified config callback",
);
planIndex = replaceOnce(
  planIndex,
  `        const planningTools = getEffectivePlanningToolSelection(loaded.config.tools, names);\n        warnUnavailablePlanningTools(ctx, planningTools, "skipped");\n        const planningProfile = resolvePhaseProfile(baselineProfile, loaded.config.planning);\n        const executionProfile = resolvePhaseProfile(baselineProfile, loaded.config.execution);`,
  `        const planningTools = selectedPlanningTools(state, names);\n        warnUnavailablePlanningTools(ctx, planningTools, "skipped");\n        const planningProfile = resolvePhaseProfile(baselineProfile, loaded.config.planning);\n        const executionProfile = resolvePhaseProfile(baselineProfile, loaded.config.execution);\n        const executionTools = toolProfiles\n            ? toolProfiles.getRequestedTools("execution")\n            : baselineTools;`,
  "begin planning profiles",
);
planIndex = replaceOnce(
  planIndex,
  `            executionProfile,\n            executionTools: baselineTools,`,
  `            executionProfile,\n            executionTools,`,
  "execution tool snapshot",
);
planIndex = planIndex.replaceAll("buildExecutionTools(current.baseline.tools, names)", "buildIdleTools(current.baseline.tools, names)");
planIndex = planIndex.replaceAll("buildExecutionTools(baseline.tools, allToolNames())", "buildIdleTools(baseline.tools, allToolNames())");
planIndex = planIndex.replaceAll("buildExecutionTools(next.baseline.tools, allToolNames())", "buildIdleTools(next.baseline.tools, allToolNames())");
planIndex = replaceOnce(
  planIndex,
  `        getStage: () => state?.stage ?? "idle",\n    };`,
  `        getStage: () => state?.stage ?? "idle",\n        applySavedConfiguration,\n    };`,
  "plan API config refresh",
);
await write("src/plan/index.js", planIndex);

let toolSet = await read("src/plan/tool-set.js");
toolSet = replaceOnce(
  toolSet,
  `export function buildExecutionTools(baseline, allToolNames) {\n    return buildIdleTools(baseline, allToolNames);\n}`,
  `export function buildExecutionTools(baseline, allToolNames) {\n    return unique(\n        baseline.filter((name) =>\n            allToolNames.has(name) &&\n            name !== ENTER_PLAN_MODE_TOOL &&\n            name !== PLAN_WRITE_TOOL &&\n            name !== EXIT_PLAN_MODE_TOOL),\n    );\n}`,
  "execution profile control tools",
);
await write("src/plan/tool-set.js", toolSet);

let test = await read("test/test.mjs");
const testStart = "// Seed official global and project settings for the TUI tests.\n";
const testEnd = "// Tool execution and Claude-style rendering remain intact.\n";
const matrixTest = `// Unified profile matrix: legacy permanent/session state migrates once, then\n// all tool choices are persistent per-profile allowlists.\nawait writeFile(\n  globalSettingsPath,\n  \`${JSON.stringify({ theme: "dark", defaultTools: ["read", "bash"] }, null, 2)}\\n\`,\n);\nconst notifications = [];\nconst sessionManager = {\n  getBranch() {\n    return [...sessionEntries];\n  },\n};\nconst eventContext = {\n  cwd: temp,\n  sessionManager,\n  ui: {\n    notify(message, type) {\n      notifications.push({ message, type });\n    },\n  },\n};\nawait handlers.get("session_start")[0]({}, eventContext);\nlet migratedProfileConfig = JSON.parse(await readFile(toolsConfigPath, "utf8"));\nassert.equal(migratedProfileConfig.version, 2);\nassert.ok(Array.isArray(migratedProfileConfig.profiles.normal));\nassert.ok(Array.isArray(migratedProfileConfig.profiles.plan));\nassert.ok(Array.isArray(migratedProfileConfig.profiles.execution));\nassert.equal(migratedProfileConfig.profiles.normal.includes("custom_extra"), false);\n\nconst theme = {\n  fg(_color, text) { return String(text); },\n  bold(text) { return String(text); },\n};\nlet matrixLines = [];\nawait commands.get("only-tools").handler("", {\n  mode: "tui",\n  hasUI: true,\n  cwd: temp,\n  sessionManager,\n  ui: {\n    notify(message, type) { notifications.push({ message, type }); },\n    async custom(factory) {\n      return new Promise((resolve) => {\n        const tui = { requestRender() {} };\n        const component = factory(tui, theme, {}, resolve);\n        matrixLines = component.render(120);\n        component.handleInput("\\u001b");\n      });\n    },\n  },\n});\nassert.ok(matrixLines.some((line) => line.includes("Tool profile matrix")));\nassert.ok(matrixLines.some((line) => line.includes("Normal")));\nassert.ok(matrixLines.some((line) => line.includes("Plan")));\nassert.ok(matrixLines.some((line) => line.includes("Execution")));\nassert.ok(matrixLines.some((line) => line.includes("Model")));\nassert.ok(matrixLines.some((line) => line.includes("Think")));\n\n`;
test = replaceBetween(test, testStart, testEnd, matrixTest + testEnd, "legacy TUI tests");
await write("test/test.mjs", test);

const profileConfigTest = `import assert from "node:assert/strict";\nimport { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";\nimport os from "node:os";\nimport path from "node:path";\nimport { loadProfileConfig, saveProfileConfig } from "../src/profile-config.js";\n\nconst root = await mkdtemp(path.join(os.tmpdir(), "pi-only-tools-profile-config-"));\nconst file = path.join(root, "tools.json");\nconst defaults = {\n  normal: ["read", "bash", "custom"],\n  plan: ["read", "grep", "custom"],\n  execution: ["read", "bash", "custom"],\n};\nawait writeFile(file, JSON.stringify({ version: 1, permanentlyDisabledTools: ["custom"] }));\nconst migrated = await loadProfileConfig(file, defaults);\nassert.equal(migrated.migrated, true);\nassert.deepEqual(migrated.config.profiles.normal, ["read", "bash"]);\nassert.deepEqual(migrated.config.profiles.plan, ["read", "grep"]);\nassert.deepEqual(migrated.config.profiles.execution, ["read", "bash"]);\nawait saveProfileConfig(file, migrated.config);\nconst saved = JSON.parse(await readFile(file, "utf8"));\nassert.equal(saved.version, 2);\nassert.equal(Object.hasOwn(saved, "permanentlyDisabledTools"), false);\nconst reloaded = await loadProfileConfig(file, defaults);\nassert.equal(reloaded.migrated, false);\nassert.deepEqual(reloaded.config, migrated.config);\nawait rm(root, { recursive: true, force: true });\nconsole.log("profile config migration tests passed");\n`;
await write("test/profile-config.test.mjs", profileConfigTest);

const matrixRulesTest = `import assert from "node:assert/strict";\nimport { runtimeToolsForProfile, __test } from "../src/profile-matrix-ui.js";\n\nassert.deepEqual(__test.lockedCell("plan", "plan_write"), { locked: true, value: true, reason: "required" });\nassert.deepEqual(__test.lockedCell("normal", "plan_write"), { locked: true, value: false, reason: "control" });\nassert.deepEqual(__test.lockedCell("execution", "EnterPlanMode"), { locked: true, value: false, reason: "control" });\nassert.deepEqual(runtimeToolsForProfile("plan", ["read", "EnterPlanMode"]), ["read", "plan_write", "ExitPlanMode"]);\nassert.deepEqual(runtimeToolsForProfile("execution", ["read", "EnterPlanMode", "plan_write"]), ["read"]);\nconsole.log("profile matrix rules tests passed");\n`;
await write("test/profile-matrix.test.mjs", matrixRulesTest);

let pkg = JSON.parse(await read("package.json"));
pkg.version = "0.5.0";
pkg.scripts.test += " && node test/profile-config.test.mjs && node test/profile-matrix.test.mjs";
await write("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
let lock = JSON.parse(await read("package-lock.json"));
lock.version = "0.5.0";
if (lock.packages?.[""]) lock.packages[""].version = "0.5.0";
await write("package-lock.json", `${JSON.stringify(lock, null, 2)}\n`);

let changelog = await read("CHANGELOG.md");
changelog = `## 0.5.0\n\n- Replace session/permanent tool states with one persistent profile × tool allowlist matrix.\n- Configure Normal, Plan, and Execution tool access side-by-side in one TUI.\n- Keep Plan/Execution model and thinking settings in the same matrix screen.\n- Migrate legacy permanentlyDisabledTools into profile omissions and stop applying a global denylist at runtime.\n- Make the Execution profile independent from Normal and hide Plan control tools outside their valid profile.\n\n` + changelog.replace(/^# Changelog\\n\\n/, "# Changelog\\n\\n");
await write("CHANGELOG.md", changelog);

let readme = await read("README.md");
const managementStart = "## 工具管理\n";
const managementEnd = "## `shell_command`\n";
const management = `## 工具 Profile 矩阵\n\n从 **0.5.0** 开始，\`/only-tools\` 不再区分“当前会话禁用”和“永久禁用”。工具策略只有一个持久化来源：\n\n\`\`\`text\n~/.pi/agent/tools.json\n\`\`\`\n\n界面把 **Profile 作为行、Tool 作为列**：\n\n\`\`\`text\nProfile     Model                 Think     read      bash      grep      ...\nNormal      Pi current            Pi current [x]       [x]       [ ]\nPlan        provider/model        xhigh      [x]       [ ]       [x]\nExecution   provider/model        high       [x]       [x]       [ ]\n\`\`\`\n\n在 Pi TUI 中执行：\n\n\`\`\`text\n/only-tools\n\`\`\`\n\n操作：\n\n- \`↑ / ↓\`：选择 Normal / Plan / Execution；\n- \`← / →\`：选择工具列；\n- \`Space / Enter\`：切换当前 Profile 对该工具的允许状态；\n- \`M\`：配置当前 Plan/Execution Profile 的模型；\n- \`T\`：配置当前 Plan/Execution Profile 的思考强度；\n- \`A\`：当前 Profile 全选可注册工具；\n- \`N\`：当前 Profile 清空；\n- \`R\`：恢复当前 Profile 的默认值；\n- \`Esc / S\`：保存并关闭。\n\nNormal 的模型与思考强度继续跟随 Pi 当前会话；Plan 和 Execution 的模型/思考强度在同一界面编辑。\n\n### Profile 语义\n\n- \`normal\`：普通会话的持久工具 allowlist。\n- \`plan\`：Plan Mode 的持久工具 allowlist；\`plan_write\` 与 \`ExitPlanMode\` 在表格中锁定为必选。\n- \`execution\`：批准计划后执行阶段的独立持久 allowlist，不再简单复制 Normal。\n\n\`EnterPlanMode\` 只允许出现在 Normal；\`plan_write\` / \`ExitPlanMode\` 只允许出现在 Plan。控制工具在不合法的 Profile 中显示为锁定关闭。\n\n配置保存后立即更新当前 active profile，同时把 Normal 中启用的 Pi 内置工具同步到官方 \`settings.json.defaultTools\`，使下次启动的内置工具状态与矩阵一致。\n\n### 旧配置迁移\n\n旧版 \`tools.json\`：\n\n\`\`\`json\n{\n  "version": 1,\n  "permanentlyDisabledTools": ["example"]\n}\n\`\`\`\n\n会在首次启动时自动迁移为 version 2：原永久禁用项会从三个 Profile 的 allowlist 中移除。迁移后不再存在全局 denylist，也不再保存 session branch 的临时工具状态。\n\n原 \`claude-plan-mode.json\` 中的 Plan/Execution 模型与思考强度会继续兼容；旧的 Plan tool 列表只用于首次生成 Plan 行默认值，之后工具矩阵以 \`tools.json\` 为唯一真相。项目级 Plan 配置不再覆盖这个全局矩阵。\n\n查看运行时最终工具：\n\n\`\`\`text\n/only-tools status\n\`\`\`\n\n### Plan workflow\n\n\`\`\`text\nnormal\n  └─ EnterPlanMode / /plan\n       └─ plan\n            └─ ExitPlanMode + /plan-approve\n                 └─ execution\n                      └─ /plan finish\n                           └─ normal\n\`\`\`\n\n\`/plan config\` 与 \`/only-tools plan\` 都直接打开同一个 Profile 矩阵，不再存在第二套 Plan 工具配置界面。\n\n已安装独立 \`pi-claude-plan-mode\` 的用户仍应卸载旧 package，避免重复注册 Plan workflow。\n\n`;
readme = replaceBetween(readme, managementStart, managementEnd, management + managementEnd, "README tool management");
readme = readme.replace("从 **0.4.0** 开始，Claude 风格 Plan Mode 已合并进本插件，并与普通工具状态共享同一个 ToolProfileController。原 `/tools` 管理能力仍由 `/only-tools` 提供。同一个 TUI 现在同时管理当前会话工具、永久禁用工具，以及 Pi 内置工具的启动默认值。", "从 **0.5.0** 开始，normal、Plan、execution 三个 Profile 在同一张工具矩阵中持久配置，不再区分会话禁用与永久禁用。");
await write("README.md", readme);

console.log("Profile tool matrix changes applied.");

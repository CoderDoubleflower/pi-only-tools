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

// Persistent tool policy has exactly two profiles: Normal and Plan.
let profileConfig = await read("src/profile-config.js");
profileConfig = replaceOnce(
  profileConfig,
  'export const PROFILE_NAMES = Object.freeze(["normal", "plan", "execution"]);',
  'export const PROFILE_NAMES = Object.freeze(["normal", "plan"]);',
  "profile names",
);
profileConfig = replaceBetween(
  profileConfig,
  '    if (parsed.version === PROFILE_CONFIG_VERSION && parsed.profiles && typeof parsed.profiles === "object") {\n',
  '    // Legacy v1 stored one global denylist.',
  `    if (parsed.version === PROFILE_CONFIG_VERSION && parsed.profiles && typeof parsed.profiles === "object") {\n      const hadExecutionProfile = Object.prototype.hasOwnProperty.call(parsed.profiles, "execution");\n      if (hadExecutionProfile) {\n        warnings.push(\`${'${configPath}'}: removed legacy profiles.execution; approved plans now execute with the Normal profile.\`);\n      }\n      return {\n        config: {\n          version: PROFILE_CONFIG_VERSION,\n          profiles: normalizeProfileObject(parsed.profiles, defaults, warnings, configPath),\n        },\n        warnings,\n        migrated: hadExecutionProfile,\n      };\n    }\n\n`,
  "v2 profile migration",
);
await write("src/profile-config.js", profileConfig);

let controller = await read("src/tool-profile-controller.js");
controller = controller
  .replace('      ["execution", []],\n', "")
  .replace('        execution: this.getRequestedTools("execution"),\n', "")
  .replace('        execution: this.getEffectiveTools("execution"),\n', "");
await write("src/tool-profile-controller.js", controller);

// Model/thinking configuration also becomes Normal + Plan. Legacy execution
// values are read as Normal so existing users keep their intended execute model.
let planConfig = await read("src/plan/config.js");
planConfig = replaceOnce(
  planConfig,
  '        planning: {},\n        execution: {},',
  '        planning: {},\n        normal: {},',
  "empty plan config",
);
planConfig = replaceOnce(
  planConfig,
  '        const tools = parseTools(parsed.tools, filePath, warnings);\n        return {\n            ...(tools !== undefined ? { tools } : {}),\n            planning: parseProfile(parsed.planning, filePath, "planning", warnings),\n            execution: parseProfile(parsed.execution, filePath, "execution", warnings),\n        };',
  '        const tools = parseTools(parsed.tools, filePath, warnings);\n        const normalKey = parsed.normal !== undefined ? "normal" : parsed.execution !== undefined ? "execution" : "normal";\n        if (parsed.normal === undefined && parsed.execution !== undefined)\n            warnings.push(`${filePath}: migrated legacy "execution" model/thinking profile to "normal".`);\n        return {\n            ...(tools !== undefined ? { tools } : {}),\n            planning: parseProfile(parsed.planning, filePath, "planning", warnings),\n            normal: parseProfile(parsed[normalKey], filePath, normalKey, warnings),\n        };',
  "read normal profile with execution fallback",
);
planConfig = replaceOnce(
  planConfig,
  '        planning: { ...config.planning },\n        execution: { ...config.execution },',
  '        planning: { ...config.planning },\n        normal: { ...config.normal },',
  "serialize normal profile",
);
planConfig = replaceOnce(
  planConfig,
  '            planning: mergeProfile(globalConfig.planning, projectConfig.planning),\n            execution: mergeProfile(globalConfig.execution, projectConfig.execution),',
  '            planning: mergeProfile(globalConfig.planning, projectConfig.planning),\n            normal: mergeProfile(globalConfig.normal, projectConfig.normal),',
  "merge normal profile",
);
await write("src/plan/config.js", planConfig);

// The fallback Plan config UI should match the integrated matrix semantics too.
let configUi = await read("src/plan/config-ui.js");
configUi = configUi
  .replaceAll("draft.execution", "draft.normal")
  .replaceAll("config.execution", "config.normal")
  .replaceAll("execution: { ...config.execution }", "normal: { ...config.normal }")
  .replaceAll("Execute model", "Normal model")
  .replaceAll("Execute thinking", "Normal thinking")
  .replaceAll("Select Execute", "Select Normal")
  .replaceAll("execution: config.execution", "normal: config.normal");
await write("src/plan/config-ui.js", configUi);

let matrix = await read("src/profile-matrix-ui.js");
matrix = matrix
  .replace('  execution: "Execution",\n', "")
  .replace('        normalModel: "Normal 模型与思考强度继续使用 Pi 当前会话设置；Plan/Execution 可在此界面配置。",', '        normalModel: "Normal 与 Plan 的模型/思考强度都可在此配置；inherit 表示继承当前/default。",')
  .replace('        normalModel: "Normal model/thinking follow the current Pi session; Plan/Execution can be configured here.",', '        normalModel: "Normal and Plan model/thinking are configured here; inherit uses the current/default value.",')
  .replace('    if (profile === "execution") result.delete(ENTER_PLAN_MODE_TOOL);\n', "")
  .replace('      const phase = profile === "plan" ? this.phaseProfiles.planning : profile === "execution" ? this.phaseProfiles.execution : undefined;\n      const model = profile === "normal" ? this.copy.modelCurrent : formatModel(phase, "inherit");\n      const thinking = profile === "normal" ? this.copy.thinkingCurrent : phase?.thinkingLevel ?? "inherit";', '      const phase = profile === "plan" ? this.phaseProfiles.planning : this.phaseProfiles.normal;\n      const model = formatModel(phase, profile === "normal" ? this.copy.modelCurrent : "inherit");\n      const thinking = phase?.thinkingLevel ?? (profile === "normal" ? this.copy.thinkingCurrent : "inherit");')
  .replace('  const phaseProfiles = {\n    planning: { ...planLoaded.globalConfig.planning },\n    execution: { ...planLoaded.globalConfig.execution },\n  };', '  const phaseProfiles = {\n    planning: { ...planLoaded.globalConfig.planning },\n    normal: { ...planLoaded.globalConfig.normal },\n  };')
  .replace('      if (result.profile === "normal") {\n        ctx.ui.notify(text.normalModel, "info");\n        continue;\n      }\n      const key = result.profile === "plan" ? "planning" : "execution";', '      const key = result.profile === "plan" ? "planning" : "normal";')
  .replace('    planning: phaseProfiles.planning,\n    execution: phaseProfiles.execution,', '    planning: phaseProfiles.planning,\n    normal: phaseProfiles.normal,');
await write("src/profile-matrix-ui.js", matrix);

let index = await read("src/index.js");
index = index
  .replace('import { ENTER_PLAN_MODE_TOOL } from "./plan/constants.js";\n', "")
  .replace('    const execution = normal.filter((name) => name !== ENTER_PLAN_MODE_TOOL);\n    return { normal, plan, execution };', '    return { normal, plan };')
  .replace('    description: "Manage the persistent Normal/Plan/Execution tool matrix",', '    description: "Manage the persistent Normal/Plan tool matrix",');
await write("src/index.js", index);

let planIndex = await read("src/plan/index.js");
planIndex = replaceBetween(
  planIndex,
  '    function profileForStage() {\n',
  '    function applyActiveTools(toolNames) {\n',
  '    function profileForStage() {\n        return state?.stage === "planning" || state?.stage === "ready" ? "plan" : "normal";\n    }\n',
  "workflow profile selection",
);
planIndex = replaceOnce(
  planIndex,
  '        if (current.stage === "executing" && current.baseline && current.executionProfile) {\n            const tools = buildExecutionTools(current.executionTools ?? current.baseline.tools, names);\n            applyActiveTools(tools);\n            await applyProfile(pi, ctx, current.executionProfile, current.baseline.profile, "Execution profile");\n            return;\n        }\n        if (current.baseline) {\n            applyActiveTools(buildIdleTools(current.baseline.tools, names));\n            await applyProfile(pi, ctx, current.baseline.profile, current.baseline.profile, "Baseline profile");\n            return;\n        }',
  '        if (current.stage === "executing" && current.baseline && current.executionProfile) {\n            const tools = buildIdleTools(current.executionTools ?? current.baseline.tools, names);\n            applyActiveTools(tools);\n            await applyProfile(pi, ctx, current.executionProfile, current.baseline.profile, "Normal profile");\n            return;\n        }\n        if (current.baseline) {\n            const tools = buildIdleTools(current.executionTools ?? current.baseline.tools, names);\n            const profile = current.executionProfile ?? current.baseline.profile;\n            applyActiveTools(tools);\n            await applyProfile(pi, ctx, profile, current.baseline.profile, "Normal profile");\n            return;\n        }',
  "normal runtime after planning",
);
const savedConfigFunction = `    async function applySavedConfiguration(ctx) {\n        const loaded = loadPlanModeConfig(ctx.cwd, {\n            agentDir: getAgentDir(),\n            configDirName: CONFIG_DIR_NAME,\n            loadProjectConfig: false,\n        });\n        warnConfig(ctx, loaded.warnings);\n        const currentProfile = captureCurrentProfile(pi, ctx);\n        const fallbackProfile = state?.baseline?.profile ?? currentProfile;\n        const normalProfile = resolvePhaseProfile(fallbackProfile, loaded.config.normal);\n        const normalTools = toolProfiles\n            ? toolProfiles.getRequestedTools("normal")\n            : state?.executionTools ?? state?.baseline?.tools ?? pi.getActiveTools();\n\n        if (!state?.baseline) {\n            if (toolProfiles)\n                toolProfiles.activate("normal");\n            await applyProfile(pi, ctx, normalProfile, currentProfile, "Normal profile");\n            return;\n        }\n\n        if (state.stage === "planning" || state.stage === "ready") {\n            const names = allToolNames();\n            const planningTools = selectedPlanningTools(state, names);\n            const next = commitState({\n                ...state,\n                planningTools,\n                planningProfile: resolvePhaseProfile(state.baseline.profile, loaded.config.planning),\n                executionProfile: normalProfile,\n                executionTools: normalTools,\n            }, ctx);\n            await applyStateRuntime(next, ctx);\n            ctx.ui.notify("Profile configuration was applied to the current Plan session.", "info");\n            return;\n        }\n\n        if (state.stage === "executing") {\n            const next = commitState({\n                ...state,\n                executionProfile: normalProfile,\n                executionTools: normalTools,\n            }, ctx);\n            await applyStateRuntime(next, ctx);\n            ctx.ui.notify("Normal profile configuration was applied to the approved-plan execution.", "info");\n            return;\n        }\n\n        applyActiveTools(buildIdleTools(normalTools, allToolNames()));\n        await applyProfile(pi, ctx, normalProfile, fallbackProfile, "Normal profile");\n    }\n`;
planIndex = replaceBetween(
  planIndex,
  '    async function applySavedConfiguration(ctx) {\n',
  '    async function openConfiguration(ctx) {\n',
  savedConfigFunction,
  "saved config runtime",
);
planIndex = replaceOnce(
  planIndex,
  '                const baseline = fallbackState.baseline;\n                applyActiveTools(buildIdleTools(baseline.tools, allToolNames()));\n            }\n            else {\n                applyActiveTools(buildIdleTools(pi.getActiveTools(), allToolNames()));\n            }',
  '                const baseline = fallbackState.baseline;\n                const tools = buildIdleTools(fallbackState.executionTools ?? baseline.tools, allToolNames());\n                const profile = fallbackState.executionProfile ?? baseline.profile;\n                applyActiveTools(tools);\n                await applyProfile(pi, ctx, profile, baseline.profile, "Normal profile");\n            }\n            else {\n                if (toolProfiles)\n                    toolProfiles.activate("normal");\n                else\n                    applyActiveTools(buildIdleTools(pi.getActiveTools(), allToolNames()));\n                const loaded = loadPlanModeConfig(ctx.cwd, {\n                    agentDir: getAgentDir(),\n                    configDirName: CONFIG_DIR_NAME,\n                    loadProjectConfig: false,\n                });\n                warnConfig(ctx, loaded.warnings);\n                const currentProfile = captureCurrentProfile(pi, ctx);\n                const normalProfile = resolvePhaseProfile(currentProfile, loaded.config.normal);\n                await applyProfile(pi, ctx, normalProfile, currentProfile, "Normal profile");\n            }',
  "normal branch restore",
);
planIndex = planIndex
  .replace('        const executionProfile = resolvePhaseProfile(baselineProfile, loaded.config.execution);', '        const executionProfile = resolvePhaseProfile(baselineProfile, loaded.config.normal);')
  .replace('            ? toolProfiles.getRequestedTools("execution")', '            ? toolProfiles.getRequestedTools("normal")')
  .replace('            applyActiveTools(buildIdleTools(pi.getActiveTools(), allToolNames()));', '            if (toolProfiles)\n                toolProfiles.activate("normal");\n            else\n                applyActiveTools(buildIdleTools(pi.getActiveTools(), allToolNames()));')
  .replace('        applyActiveTools(buildIdleTools(next.baseline.tools, allToolNames()));\n        await applyProfile(pi, ctx, next.baseline.profile, next.baseline.profile, "Baseline profile");', '        applyActiveTools(buildIdleTools(next.executionTools ?? next.baseline.tools, allToolNames()));\n        await applyProfile(pi, ctx, next.executionProfile ?? next.baseline.profile, next.baseline.profile, "Normal profile");')
  .replace('        applyActiveTools(buildExecutionTools(executionState.executionTools ?? executionState.baseline.tools, allToolNames()));\n        await applyProfile(pi, ctx, executionState.executionProfile, executionState.baseline.profile, "Execution profile");', '        applyActiveTools(buildIdleTools(executionState.executionTools ?? executionState.baseline.tools, allToolNames()));\n        await applyProfile(pi, ctx, executionState.executionProfile, executionState.baseline.profile, "Normal profile");')
  .replace('                ctx.ui.notify("Plan workflow ended and the pre-Plan profile was restored.", "info");', '                ctx.ui.notify("Plan workflow ended and the Normal profile is active.", "info");')
  .replace('                ctx.ui.notify("Execution profile ended and the pre-Plan profile was restored.", "info");', '                ctx.ui.notify("Approved-plan execution finished; the Normal profile remains active.", "info");');
planIndex = planIndex.replace('import { buildExecutionTools, buildIdleTools,', 'import { buildIdleTools,');
await write("src/plan/index.js", planIndex);

// Tests: two profiles, and approved execution must switch to Normal.
let controllerTest = await read("test/tool-profile-controller.test.mjs");
controllerTest = controllerTest
  .replace('profiles.activate("execution", ["shell_command", "apply_patch"]);\nassert.deepEqual(active, ["shell_command", "apply_patch"]);\nprofiles.activate("normal");', 'profiles.activate("normal");')
  .replace('assert.equal(Object.hasOwn(snapshot, "permanentlyDisabledTools"), false);\n', 'assert.deepEqual(Object.keys(snapshot.requested), ["normal", "plan"]);\n');
await write("test/tool-profile-controller.test.mjs", controllerTest);

let profileConfigTest = await read("test/profile-config.test.mjs");
profileConfigTest = profileConfigTest
  .replace('  plan: ["read", "grep", "custom"],\n  execution: ["read", "bash", "custom"],', '  plan: ["read", "grep", "custom"],')
  .replace('assert.deepEqual(migrated.config.profiles.execution, ["read", "bash"]);\n', '')
  .replace('assert.equal(Object.hasOwn(saved, "permanentlyDisabledTools"), false);', 'assert.equal(Object.hasOwn(saved, "permanentlyDisabledTools"), false);\nassert.equal(Object.hasOwn(saved.profiles, "execution"), false);');
profileConfigTest = profileConfigTest.replace(
  'const reloaded = await loadProfileConfig(file, defaults);\nassert.equal(reloaded.migrated, false);\nassert.deepEqual(reloaded.config, migrated.config);',
  'const reloaded = await loadProfileConfig(file, defaults);\nassert.equal(reloaded.migrated, false);\nassert.deepEqual(reloaded.config, migrated.config);\nawait writeFile(file, JSON.stringify({ version: 2, profiles: { normal: ["read"], plan: ["grep"], execution: ["bash"] } }));\nconst droppedExecution = await loadProfileConfig(file, defaults);\nassert.equal(droppedExecution.migrated, true);\nassert.equal(Object.hasOwn(droppedExecution.config.profiles, "execution"), false);',
);
await write("test/profile-config.test.mjs", profileConfigTest);

let matrixTest = await read("test/profile-matrix.test.mjs");
matrixTest = matrixTest
  .replace('assert.deepEqual(__test.lockedCell("execution", "EnterPlanMode"), { locked: true, value: false, reason: "control" });\n', '')
  .replace('assert.deepEqual(runtimeToolsForProfile("execution", ["read", "EnterPlanMode", "plan_write"]), ["read"]);', 'assert.deepEqual(runtimeToolsForProfile("normal", ["read", "EnterPlanMode", "plan_write"]), ["read", "EnterPlanMode"]);');
await write("test/profile-matrix.test.mjs", matrixTest);

let integrationTest = await read("test/plan-integration.test.mjs");
integrationTest = integrationTest
  .replace('["executor/executor-model", { provider: "executor", id: "executor-model" }],', '["normal/normal-model", { provider: "normal", id: "normal-model" }],')
  .replace('    execution: { provider: "executor", model: "executor-model", thinkingLevel: "xhigh" },', '    normal: { provider: "normal", model: "normal-model", thinkingLevel: "xhigh" },')
  .replace('profiles.setProfile("execution", ["shell_command", "apply_patch"], { apply: false });\n', '')
  .replace('assert.equal(profiles.mode, "execution");', 'assert.equal(profiles.mode, "normal");')
  .replace('assert.equal(ctx.model.provider, "executor");', 'assert.equal(ctx.model.provider, "normal");');
await write("test/plan-integration.test.mjs", integrationTest);

let mainTest = await read("test/test.mjs");
mainTest = mainTest
  .replace('assert.ok(Array.isArray(migratedProfileConfig.profiles.execution));\n', '')
  .replace('assert.ok(matrixLines.some((line) => line.includes("Execution")));\n', 'assert.equal(matrixLines.some((line) => line.includes("Execution")), false);\n');
await write("test/test.mjs", mainTest);

let readme = await read("README.md");
readme = readme
  .replace('从 **0.5.0** 开始，normal、Plan、execution 三个 Profile 在同一张工具矩阵中持久配置，不再区分会话禁用与永久禁用。', '从 **0.5.0** 开始，Normal 与 Plan 两个 Profile 在同一张工具矩阵中持久配置；Plan 批准后直接切回 Normal 执行，不存在独立 Execution Profile。')
  .replace('Normal      Pi current            Pi current [x]       [x]       [ ]\nPlan        provider/model        xhigh      [x]       [ ]       [x]\nExecution   provider/model        high       [x]       [x]       [ ]', 'Normal      provider/model        high       [x]       [x]       [ ]\nPlan        provider/model        xhigh      [x]       [ ]       [x]')
  .replace('- `↑ / ↓`：选择 Normal / Plan / Execution；', '- `↑ / ↓`：选择 Normal / Plan；')
  .replace('- `M`：配置当前 Plan/Execution Profile 的模型；', '- `M`：配置当前 Normal/Plan Profile 的模型；')
  .replace('- `T`：配置当前 Plan/Execution Profile 的思考强度；', '- `T`：配置当前 Normal/Plan Profile 的思考强度；')
  .replace('Normal 的模型与思考强度继续跟随 Pi 当前会话；Plan 和 Execution 的模型/思考强度在同一界面编辑。', 'Normal 与 Plan 的模型/思考强度都在同一界面编辑；选择 inherit 时继承 Pi 当前/default。')
  .replace('- `normal`：普通会话的持久工具 allowlist。', '- `normal`：普通会话以及批准计划后的执行阶段共同使用的持久工具 allowlist、模型和思考强度。')
  .replace('- `execution`：批准计划后执行阶段的独立持久 allowlist，不再简单复制 Normal。\n', '')
  .replace('会在首次启动时自动迁移为 version 2：原永久禁用项会从三个 Profile 的 allowlist 中移除。', '会在首次启动时自动迁移为 version 2：原永久禁用项会从 Normal 与 Plan 两个 Profile 的 allowlist 中移除。')
  .replace('原 `claude-plan-mode.json` 中的 Plan/Execution 模型与思考强度会继续兼容；', '原 `claude-plan-mode.json` 中的 `execution` 模型与思考强度会自动作为新的 Normal 配置读取；')
  .replace('normal\n  └─ EnterPlanMode / /plan\n       └─ plan\n            └─ ExitPlanMode + /plan-approve\n                 └─ execution\n                      └─ /plan finish\n                           └─ normal', 'normal\n  └─ EnterPlanMode / /plan\n       └─ plan\n            └─ ExitPlanMode + /plan-approve\n                 └─ normal（执行已批准计划）\n                      └─ /plan finish（仍保持 normal）');
await write("README.md", readme);

let changelog = await read("CHANGELOG.md");
changelog = changelog
  .replace('- Configure Normal, Plan, and Execution tool access side-by-side in one TUI.', '- Configure Normal and Plan tool access side-by-side in one TUI; approved plans execute with Normal.')
  .replace('- Keep Plan/Execution model and thinking settings in the same matrix screen.', '- Configure Normal/Plan model and thinking settings in the same matrix screen; legacy execution settings migrate to Normal.')
  .replace('- Make the Execution profile independent from Normal and hide Plan control tools outside their valid profile.', '- Remove the separate Execution profile; Plan approval returns directly to Normal for implementation.');
await write("CHANGELOG.md", changelog);

console.log("Removed the separate Execution profile; approved plans now execute in Normal.");

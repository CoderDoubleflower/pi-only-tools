import { readFile, writeFile } from "node:fs/promises";

async function read(path) {
  return readFile(path, "utf8");
}

async function write(path, content) {
  await writeFile(path, content, "utf8");
}

function replaceOnce(content, search, replacement, label = search.slice(0, 80)) {
  const first = content.indexOf(search);
  if (first < 0) throw new Error(`Patch target not found: ${label}`);
  if (content.indexOf(search, first + search.length) >= 0) {
    throw new Error(`Patch target is not unique: ${label}`);
  }
  return content.slice(0, first) + replacement + content.slice(first + search.length);
}

function replaceCount(content, search, replacement, expected, label = search.slice(0, 80)) {
  const count = content.split(search).length - 1;
  if (count !== expected) throw new Error(`Expected ${expected} occurrences for ${label}, found ${count}`);
  return content.split(search).join(replacement);
}

const toolProfileController = `function uniqueToolNames(values) {
  const result = [];
  const seen = new Set();
  for (const value of values ?? []) {
    if (typeof value !== "string") continue;
    const name = value.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    result.push(name);
  }
  return result;
}

function equalToolLists(left, right) {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

export class ToolProfileController {
  constructor(pi, options = {}) {
    this.pi = pi;
    this.mode = "normal";
    this.protectedTools = new Set(uniqueToolNames(options.protectedTools));
    const initial = uniqueToolNames(pi.getActiveTools?.() ?? []);
    this.profiles = new Map([
      ["normal", initial],
      ["plan", []],
      ["execution", []],
    ]);
    this.permanentlyDisabled = new Set();
  }

  assertProfile(profile) {
    if (!this.profiles.has(profile)) throw new Error(\`Unknown tool profile: \${profile}\`);
  }

  setPermanentDisabled(names, options = {}) {
    this.permanentlyDisabled = new Set(uniqueToolNames(names));
    return options.apply === false ? this.getEffectiveTools() : this.apply();
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

  getRegisteredToolNames() {
    return new Set(
      (this.pi.getAllTools?.() ?? [])
        .map((tool) => tool?.name)
        .filter((name) => typeof name === "string" && name.length > 0),
    );
  }

  isPermanentlyDisabled(name) {
    return this.permanentlyDisabled.has(name) && !this.protectedTools.has(name);
  }

  getUnavailableTools(names) {
    const registered = this.getRegisteredToolNames();
    return uniqueToolNames(names).flatMap((name) => {
      if (!registered.has(name)) return [{ name, reason: "not registered" }];
      if (this.isPermanentlyDisabled(name)) return [{ name, reason: "permanently disabled" }];
      return [];
    });
  }

  getEffectiveTools(profile = this.mode) {
    const unavailable = new Set(this.getUnavailableTools(this.getRequestedTools(profile)).map((entry) => entry.name));
    return this.getRequestedTools(profile).filter((name) => !unavailable.has(name));
  }

  apply() {
    const effective = this.getEffectiveTools();
    const current = uniqueToolNames(this.pi.getActiveTools?.() ?? []);
    if (!equalToolLists(current, effective)) this.pi.setActiveTools(effective);
    return effective;
  }

  snapshot() {
    return {
      mode: this.mode,
      requested: {
        normal: this.getRequestedTools("normal"),
        plan: this.getRequestedTools("plan"),
        execution: this.getRequestedTools("execution"),
      },
      effective: {
        normal: this.getEffectiveTools("normal"),
        plan: this.getEffectiveTools("plan"),
        execution: this.getEffectiveTools("execution"),
      },
      permanentlyDisabledTools: [...this.permanentlyDisabled].sort((a, b) => a.localeCompare(b, "en")),
      activeTools: this.getEffectiveTools(),
    };
  }
}

export function createToolProfileController(pi, options) {
  return new ToolProfileController(pi, options);
}
`;
await write("src/tool-profile-controller.js", toolProfileController);

let planIndex = await read("src/plan/index.js");
const activeToolCalls = (planIndex.match(/pi\.setActiveTools\(/g) ?? []).length;
if (activeToolCalls !== 9) throw new Error(`Expected 9 Plan setActiveTools calls, found ${activeToolCalls}`);
planIndex = planIndex.replaceAll("pi.setActiveTools(", "applyActiveTools(");
planIndex = replaceOnce(
  planIndex,
  `export function registerClaudePlanMode(pi) {\n    let state;`,
  `export function registerClaudePlanMode(pi, options = {}) {\n    const toolProfiles = options.toolProfiles;\n    let state;`,
  "Plan registration signature",
);
planIndex = replaceOnce(
  planIndex,
  `    function selectedPlanningTools(current = state, names = allToolNames()) {\n        return getEffectivePlanningToolSelection(current?.planningTools, names);\n    }`,
  `    function selectedPlanningTools(current = state, names = allToolNames()) {\n        return getEffectivePlanningToolSelection(current?.planningTools, names);\n    }\n    function activePlanningTools(current = state, names = allToolNames()) {\n        const selected = selectedPlanningTools(current, names);\n        if (!toolProfiles)\n            return selected;\n        const active = new Set(toolProfiles.getEffectiveTools("plan"));\n        return selected.filter((name) => active.has(name));\n    }\n    function profileForStage() {\n        return state?.stage === "planning" || state?.stage === "ready"\n            ? "plan"\n            : state?.stage === "executing"\n                ? "execution"\n                : "normal";\n    }\n    function applyActiveTools(toolNames) {\n        if (!toolProfiles) {\n            pi.setActiveTools(toolNames);\n            return toolNames;\n        }\n        return toolProfiles.activate(profileForStage(), toolNames);\n    }\n    function unavailablePlanningTools(toolNames) {\n        if (toolProfiles)\n            return toolProfiles.getUnavailableTools(toolNames);\n        return getMissingPlanningTools(toolNames, allToolNames()).map((name) => ({ name, reason: "not registered" }));\n    }\n    function warnUnavailablePlanningTools(ctx, toolNames, suffix) {\n        const unavailable = unavailablePlanningTools(toolNames);\n        if (unavailable.length === 0)\n            return;\n        const details = unavailable.map((entry) => \`\${entry.name} (\${entry.reason})\`).join(", ");\n        ctx.ui.notify(\`Configured Plan Mode tools are unavailable and will be \${suffix}: \${details}.\`, "warning");\n    }`,
  "Plan tool-profile helpers",
);
planIndex = replaceOnce(
  planIndex,
  `            const missing = getMissingPlanningTools(planningTools, names);\n            if (missing.length > 0) {\n                ctx.ui.notify(\`Configured Plan Mode tools are not registered and will be unavailable: \${missing.join(", ")}.\`, "warning");\n            }\n            applyActiveTools(buildPlanningTools(planningTools, names));`,
  `            warnUnavailablePlanningTools(ctx, planningTools, "unavailable");\n            applyActiveTools(buildPlanningTools(planningTools, names));`,
  "restore Plan unavailable warning",
);
planIndex = replaceOnce(
  planIndex,
  `        const missing = getMissingPlanningTools(planningTools, names);\n        if (missing.length > 0) {\n            ctx.ui.notify(\`Configured Plan Mode tools are not registered and will be skipped: \${missing.join(", ")}.\`, "warning");\n        }`,
  `        warnUnavailablePlanningTools(ctx, planningTools, "skipped");`,
  "begin Plan unavailable warning",
);
planIndex = replaceOnce(
  planIndex,
  `        ctx.ui.notify("Plan Mode configuration was applied to the current planning session.", "info");\n    }\n    async function restoreBranchRuntime`,
  `        ctx.ui.notify("Plan Mode configuration was applied to the current planning session.", "info");\n    }\n    async function openConfiguration(ctx) {\n        await ctx.waitForIdle?.();\n        const result = await openPlanModeConfig(pi, ctx, {\n            agentDir: getAgentDir(),\n            configDirName: CONFIG_DIR_NAME,\n            toolProfiles,\n        });\n        if (result.saved)\n            await applySavedConfiguration(ctx);\n        return result;\n    }\n    async function restoreBranchRuntime`,
  "open Plan configuration helper",
);
planIndex = replaceOnce(
  planIndex,
  `            if (normalized === "config") {\n                await ctx.waitForIdle();\n                const result = await openPlanModeConfig(pi, ctx, {\n                    agentDir: getAgentDir(),\n                    configDirName: CONFIG_DIR_NAME,\n                });\n                if (result.saved)\n                    await applySavedConfiguration(ctx);\n                return;\n            }`,
  `            if (normalized === "config") {\n                await openConfiguration(ctx);\n                return;\n            }`,
  "Plan config command",
);
planIndex = replaceOnce(
  planIndex,
  `    pi.registerFlag("plan", {`,
  `    const existingPlanTools = new Set(pi.getAllTools().map((tool) => tool.name));\n    const duplicateTools = [ENTER_PLAN_MODE_TOOL, PLAN_WRITE_TOOL, EXIT_PLAN_MODE_TOOL].filter((name) => existingPlanTools.has(name));\n    if (duplicateTools.length > 0) {\n        pi.on("session_start", (_event, ctx) => {\n            ctx.ui.notify(\n                \`Plan Mode is already registered by another extension (\${duplicateTools.join(", ")}). Remove the standalone pi-claude-plan-mode package to use the integrated tool profiles.\`,\n                "warning",\n            );\n        });\n        return { enabled: false, openConfig: openConfiguration, getState: () => state, getStage: () => state?.stage ?? "idle" };\n    }\n    pi.registerFlag("plan", {`,
  "legacy Plan duplicate guard",
);
planIndex = replaceOnce(
  planIndex,
  `        const toolNames = selectedPlanningTools(state);`,
  `        const toolNames = activePlanningTools(state);`,
  "Plan continuation effective tools",
);
planIndex = replaceCount(
  planIndex,
  `        const planningTools = selectedPlanningTools(state, names);`,
  `        const planningTools = activePlanningTools(state, names);`,
  2,
  "effective tools for prompt and tool guard",
);
planIndex = replaceOnce(
  planIndex,
  `    pi.on("before_agent_start", (event, _ctx) => {\n        if (!state)\n            return;`,
  `    pi.on("before_agent_start", (event, _ctx) => {\n        if (!state)\n            return;\n        toolProfiles?.apply();`,
  "Plan preflight profile reapply",
);
planIndex = replaceOnce(
  planIndex,
  `    });\n}\nexport default function claudePlanModeExtension(pi) {`,
  `    });\n    return {\n        enabled: true,\n        openConfig: openConfiguration,\n        getState: () => state,\n        getStage: () => state?.stage ?? "idle",\n    };\n}\nexport default function claudePlanModeExtension(pi) {`,
  "Plan runtime API return",
);
await write("src/plan/index.js", planIndex);

let configUi = await read("src/plan/config-ui.js");
configUi = replaceOnce(
  configUi,
  `async function selectToolAllowlist(pi, ctx, scope, configured, inheritedTools) {`,
  `async function selectToolAllowlist(pi, ctx, scope, configured, inheritedTools, toolProfiles) {`,
  "Plan tool selector signature",
);
configUi = replaceOnce(
  configUi,
  `            const registered = allToolNames.has(name);\n            const label = \`\${selected.has(name) ? "[x]" : "[ ]"} \${name}\${registered ? "" : " (not registered now)"}\`;\n            return { label, name };`,
  `            const registered = allToolNames.has(name);\n            const unavailable = toolProfiles?.getUnavailableTools([name])?.[0];\n            const availability = unavailable\n                ? \` (\${unavailable.reason})\`\n                : registered\n                    ? ""\n                    : " (not registered now)";\n            const label = \`\${selected.has(name) ? "[x]" : "[ ]"} \${name}\${availability}\`;\n            return { label, name };`,
  "Plan tool availability labels",
);
configUi = replaceOnce(
  configUi,
  `async function editScopeConfig(pi, ctx, scope, filePath, current, inheritedTools) {`,
  `async function editScopeConfig(pi, ctx, scope, filePath, current, inheritedTools, toolProfiles) {`,
  "Plan scope editor signature",
);
configUi = replaceOnce(
  configUi,
  `            const tools = await selectToolAllowlist(pi, ctx, scope, draft.tools, inheritedTools);`,
  `            const tools = await selectToolAllowlist(pi, ctx, scope, draft.tools, inheritedTools, toolProfiles);`,
  "Plan selector controller pass-through",
);
configUi = replaceOnce(
  configUi,
  `function effectiveConfigText(config, allToolNames, globalPath, projectPath) {\n    return [\n        \`Global: \${globalPath}\`,\n        \`Project: \${projectPath}\`,\n        "",\n        JSON.stringify({\n            tools: getEffectivePlanningToolSelection(config.tools, allToolNames),\n            planning: config.planning,\n            execution: config.execution,\n        }, null, 2),\n    ].join("\\n");\n}`,
  `function effectiveConfigText(config, allToolNames, globalPath, projectPath, toolProfiles) {\n    const requestedTools = getEffectivePlanningToolSelection(config.tools, allToolNames);\n    const unavailableTools = toolProfiles\n        ? toolProfiles.getUnavailableTools(requestedTools)\n        : requestedTools.filter((name) => !allToolNames.has(name)).map((name) => ({ name, reason: "not registered" }));\n    const unavailableNames = new Set(unavailableTools.map((entry) => entry.name));\n    const effectiveTools = requestedTools.filter((name) => !unavailableNames.has(name));\n    return [\n        \`Global: \${globalPath}\`,\n        \`Project: \${projectPath}\`,\n        "",\n        JSON.stringify({\n            profile: "plan",\n            requestedTools,\n            effectiveTools,\n            unavailableTools,\n            planning: config.planning,\n            execution: config.execution,\n        }, null, 2),\n    ].join("\\n");\n}`,
  "effective Plan profile display",
);
configUi = replaceCount(
  configUi,
  `effectiveConfigText(loaded.config, allToolNames, loaded.globalPath, loaded.projectPath)`,
  `effectiveConfigText(loaded.config, allToolNames, loaded.globalPath, loaded.projectPath, options.toolProfiles)`,
  2,
  "effective profile calls",
);
configUi = replaceOnce(
  configUi,
  `        const changed = await editScopeConfig(pi, ctx, scope, scope === "global" ? loaded.globalPath : loaded.projectPath, current, inheritedTools);`,
  `        const changed = await editScopeConfig(pi, ctx, scope, scope === "global" ? loaded.globalPath : loaded.projectPath, current, inheritedTools, options.toolProfiles);`,
  "Plan scope editor controller pass-through",
);
await write("src/plan/config-ui.js", configUi);

let base = await read("src/index.js");
base = replaceOnce(
  base,
  `import { SettingsList, truncateToWidth } from "@earendil-works/pi-tui";`,
  `import { SettingsList, truncateToWidth } from "@earendil-works/pi-tui";\nimport { createToolProfileController } from "./tool-profile-controller.js";\nimport { registerClaudePlanMode } from "./plan/index.js";`,
  "unified profile imports",
);
base = replaceOnce(
  base,
  `const PI_STANDARD_DEFAULT_TOOLS = Object.freeze(["read", "bash", "edit", "write"]);`,
  `const PI_STANDARD_DEFAULT_TOOLS = Object.freeze(["read", "bash", "edit", "write"]);\nconst PLAN_REQUIRED_TOOLS = Object.freeze(["plan_write", "ExitPlanMode"]);\nconst PLAN_REQUIRED_TOOL_SET = new Set(PLAN_REQUIRED_TOOLS);`,
  "Plan workflow constants",
);
base = replaceOnce(
  base,
  `    return normalizeToolNameList(config.permanentlyDisabledTools);`,
  `    return normalizeToolNameList(config.permanentlyDisabledTools).filter((name) => !PLAN_REQUIRED_TOOL_SET.has(name));`,
  "read protected permanent tools",
);
base = replaceOnce(
  base,
  `    const permanentlyDisabledTools = normalizeToolNameList(names).sort((a, b) => a.localeCompare(b, "en"));`,
  `    const permanentlyDisabledTools = normalizeToolNameList(names)\n      .filter((name) => !PLAN_REQUIRED_TOOL_SET.has(name))\n      .sort((a, b) => a.localeCompare(b, "en"));`,
  "write protected permanent tools",
);
base = replaceOnce(
  base,
  `    if (!tool || typeof tool.name !== "string" || tool.name.trim() === "") continue;`,
  `    if (!tool || typeof tool.name !== "string" || tool.name.trim() === "") continue;\n    if (PLAN_REQUIRED_TOOL_SET.has(tool.name)) continue;`,
  "hide workflow tools from session manager",
);
base = replaceOnce(
  base,
  `  let enabledTools = new Set();`,
  `  const toolProfiles = createToolProfileController(pi, { protectedTools: PLAN_REQUIRED_TOOLS });\n\n  let enabledTools = new Set();`,
  "tool-profile controller construction",
);
base = replaceOnce(
  base,
  `  const applyManagedTools = () => {\n    const available = new Set(managedTools.map((tool) => tool.name));\n    const next = [...enabledTools].filter(\n      (name) => available.has(name) && !permanentlyDisabledTools.has(name),\n    );\n    return setActiveToolsIfChanged(pi, next);\n  };`,
  `  const applyManagedTools = () => {\n    const available = new Set(managedTools.map((tool) => tool.name));\n    const next = [...enabledTools].filter((name) => available.has(name));\n    toolProfiles.setPermanentDisabled(permanentlyDisabledTools, { apply: false });\n    return toolProfiles.setProfile("normal", next);\n  };`,
  "normal tool profile application",
);
base = replaceOnce(
  base,
  `    let savedTools;`,
  `    toolProfiles.setPermanentDisabled(permanentlyDisabledTools, { apply: false });\n\n    let savedTools;`,
  "restore permanent policy into controller",
);
base = replaceOnce(
  base,
  `      permanentlyDisabledTools = new Set(await readPermanentlyDisabledTools());\n      const active = pi.getActiveTools?.() ?? [];\n      setActiveToolsIfChanged(pi, active.filter((name) => !permanentlyDisabledTools.has(name)));`,
  `      permanentlyDisabledTools = new Set(await readPermanentlyDisabledTools());\n      toolProfiles.setPermanentDisabled(permanentlyDisabledTools, { apply: false });\n      toolProfiles.apply();`,
  "preflight unified profile policy",
);
base = replaceOnce(
  base,
  `  const openSettings = async (ctx) => {`,
  `  const openSessionSettings = async (ctx) => {`,
  "session settings rename",
);
base = replaceOnce(
  base,
  `  pi.registerCommand("only-tools", {\n    description: "Manage active tools, permanent disables, and built-in startup defaults",\n    handler: async (_args, ctx) => openSettings(ctx),\n  });\n  pi.registerCommand("pi-only-tools", {\n    description: "Alias for /only-tools",\n    handler: async (_args, ctx) => openSettings(ctx),\n  });`,
  `  const supportsPlanModeRuntime = [\n    "registerFlag",\n    "getFlag",\n    "sendMessage",\n    "sendUserMessage",\n    "appendEntry",\n    "setSessionName",\n    "getSessionName",\n    "setModel",\n    "getThinkingLevel",\n    "setThinkingLevel",\n  ].every((name) => typeof pi[name] === "function");\n\n  const planMode = supportsPlanModeRuntime\n    ? registerClaudePlanMode(pi, { toolProfiles })\n    : {\n        enabled: false,\n        async openConfig(ctx) {\n          ctx.ui.notify("Plan Mode configuration requires the complete Pi extension API.", "warning");\n          return { saved: false };\n        },\n        getStage: () => "unavailable",\n      };\n\n  if (supportsPlanModeRuntime) {\n    toolProfiles.setProfile("normal", pi.getActiveTools?.() ?? [], { apply: false });\n  }\n\n  const openSettings = async (args, ctx) => {\n    const requested = args.trim().toLowerCase();\n    if (["plan", "plan-mode", "profile:plan"].includes(requested)) {\n      await planMode.openConfig(ctx);\n      return;\n    }\n    if (["status", "profiles", "profile"].includes(requested)) {\n      if (requested === "status" || ctx.mode !== "tui") {\n        ctx.ui.notify(JSON.stringify({ planStage: planMode.getStage?.(), ...toolProfiles.snapshot() }, null, 2), "info");\n        return;\n      }\n      const labels = isChineseLocale()\n        ? { title: "工具 Profile", session: "会话工具", plan: "Plan 模式", status: "显示有效 Profile", close: "关闭" }\n        : { title: "Tool profiles", session: "Session tools", plan: "Plan Mode", status: "Show effective profiles", close: "Close" };\n      const choice = await ctx.ui.select(labels.title, [labels.session, labels.plan, labels.status, labels.close]);\n      if (choice === labels.session) await openSessionSettings(ctx);\n      else if (choice === labels.plan) await planMode.openConfig(ctx);\n      else if (choice === labels.status) ctx.ui.notify(JSON.stringify({ planStage: planMode.getStage?.(), ...toolProfiles.snapshot() }, null, 2), "info");\n      return;\n    }\n    await openSessionSettings(ctx);\n  };\n\n  pi.registerCommand("only-tools", {\n    description: "Manage session tools and normal/Plan/execution tool profiles",\n    handler: async (args, ctx) => openSettings(args, ctx),\n  });\n  pi.registerCommand("pi-only-tools", {\n    description: "Alias for /only-tools",\n    handler: async (args, ctx) => openSettings(args, ctx),\n  });`,
  "integrated profile commands",
);
base = replaceOnce(
  base,
  `  PI_STANDARD_DEFAULT_TOOLS,`,
  `  PI_STANDARD_DEFAULT_TOOLS,\n  PLAN_REQUIRED_TOOLS,`,
  "test exports for required tools",
);
await write("src/index.js", base);

const packageJson = JSON.parse(await read("package.json"));
packageJson.version = "0.4.0";
packageJson.description = "Codex-style shell and patch tools with unified normal, Plan, and execution tool profiles.";
packageJson.scripts.check = "find src -name '*.js' -print0 | xargs -0 -n1 node --check && node --check dist/index.js";
packageJson.scripts.test = "node test/test.mjs && node test/render-lines.test.mjs && node test/entry-registration.test.mjs && node test/codex-shell-command.test.mjs && node test/tool-profile-controller.test.mjs && node test/plan-integration.test.mjs";
packageJson.keywords = [...new Set([...(packageJson.keywords ?? []), "plan-mode", "tool-profiles"])];
await write("package.json", `${JSON.stringify(packageJson, null, 2)}\n`);

const packageLock = JSON.parse(await read("package-lock.json"));
packageLock.version = "0.4.0";
if (packageLock.packages?.[""]) packageLock.packages[""].version = "0.4.0";
await write("package-lock.json", `${JSON.stringify(packageLock, null, 2)}\n`);

const controllerTest = `import assert from "node:assert/strict";
import { createToolProfileController } from "../src/tool-profile-controller.js";

const registered = new Set(["shell_command", "apply_patch", "read", "grep", "plan_write", "ExitPlanMode"]);
let active = ["shell_command", "apply_patch"];
const pi = {
  getAllTools: () => [...registered].map((name) => ({ name })),
  getActiveTools: () => [...active],
  setActiveTools: (names) => { active = [...names]; },
};

const profiles = createToolProfileController(pi, { protectedTools: ["plan_write", "ExitPlanMode"] });
profiles.setProfile("normal", ["shell_command", "apply_patch"]);
profiles.activate("plan", ["read", "grep", "plan_write", "ExitPlanMode"]);
assert.deepEqual(active, ["read", "grep", "plan_write", "ExitPlanMode"]);

profiles.setProfile("normal", ["shell_command"]);
assert.deepEqual(active, ["read", "grep", "plan_write", "ExitPlanMode"], "editing normal tools must not override Plan Mode");

profiles.setPermanentDisabled(["grep", "plan_write"]);
assert.deepEqual(active, ["read", "plan_write", "ExitPlanMode"], "permanent policy filters Plan tools but cannot remove required workflow tools");
assert.deepEqual(profiles.getUnavailableTools(["grep", "missing", "plan_write"]), [
  { name: "grep", reason: "permanently disabled" },
  { name: "missing", reason: "not registered" },
]);

profiles.activate("execution", ["shell_command", "apply_patch"]);
assert.deepEqual(active, ["shell_command", "apply_patch"]);
profiles.activate("normal");
assert.deepEqual(active, ["shell_command"]);
assert.equal(profiles.snapshot().mode, "normal");
console.log("tool profile controller tests passed");
`;
await write("test/tool-profile-controller.test.mjs", controllerTest);

const planIntegrationTest = `import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "pi-only-tools-plan-"));
const agentDir = join(root, "agent");
await mkdir(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;

const { createToolProfileController } = await import("../src/tool-profile-controller.js");
const { registerClaudePlanMode, PLAN_STATE_ENTRY } = await import("../src/plan/index.js");

const handlers = new Map();
const commands = new Map();
const tools = new Map();
const entries = [];
const notifications = [];
const sentMessages = [];
const registered = new Set([
  "shell_command",
  "apply_patch",
  "read",
  "grep",
  "find",
  "ls",
  "web_search",
  "ask_user_question",
]);
let activeTools = ["shell_command", "apply_patch"];
let thinkingLevel = "medium";
let sessionName = "plan-test";
const models = new Map([
  ["base/base-model", { provider: "base", id: "base-model" }],
  ["planner/planner-model", { provider: "planner", id: "planner-model" }],
  ["executor/executor-model", { provider: "executor", id: "executor-model" }],
]);

const sessionManager = {
  getSessionId: () => "plan-session",
  getSessionFile: () => join(root, "plan-session.jsonl"),
  getEntries: () => entries,
  getBranch: () => entries,
};

const ctx = {
  cwd: root,
  mode: "tui",
  hasUI: true,
  sessionManager,
  model: models.get("base/base-model"),
  modelRegistry: {
    find: (provider, model) => models.get(\`\${provider}/\${model}\`),
    getAvailable: () => [...models.values()],
  },
  scopedModels: [],
  thinkingLevel,
  isIdle: () => true,
  isProjectTrusted: () => true,
  hasPendingMessages: () => false,
  getSystemPrompt: () => "base prompt",
  waitForIdle: async () => undefined,
  newSession: async () => ({ cancelled: true }),
  ui: {
    theme: { fg: (_color, text) => text },
    select: async () => undefined,
    confirm: async () => true,
    editor: async () => undefined,
    notify: (message, type = "info") => notifications.push({ message, type }),
    setStatus() {},
    setWidget() {},
    getEditorText: () => "",
    setEditorText() {},
  },
};

const pi = {
  on(event, handler) {
    const list = handlers.get(event) ?? [];
    list.push(handler);
    handlers.set(event, list);
  },
  registerTool(tool) {
    tools.set(tool.name, tool);
    registered.add(tool.name);
    if (!activeTools.includes(tool.name)) activeTools.push(tool.name);
  },
  registerCommand(name, command) { commands.set(name, command); },
  registerFlag() {},
  getFlag: () => false,
  getAllTools: () => [...registered].map((name) => ({ name })),
  getActiveTools: () => [...activeTools],
  setActiveTools: (names) => { activeTools = [...names]; },
  appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
  sendMessage(message, options) { sentMessages.push({ message, options }); },
  sendUserMessage(content, options) { sentMessages.push({ user: content, options }); },
  setSessionName(name) { sessionName = name; },
  getSessionName: () => sessionName,
  async setModel(model) { ctx.model = model; return true; },
  getThinkingLevel: () => thinkingLevel,
  setThinkingLevel(level) { thinkingLevel = level; ctx.thinkingLevel = level; },
};

await writeFile(
  join(agentDir, "claude-plan-mode.json"),
  JSON.stringify({
    tools: ["read", "web_search", "ask_user_question"],
    planning: { provider: "planner", model: "planner-model", thinkingLevel: "high" },
    execution: { provider: "executor", model: "executor-model", thinkingLevel: "xhigh" },
  }),
);

const profiles = createToolProfileController(pi, { protectedTools: ["plan_write", "ExitPlanMode"] });
profiles.setPermanentDisabled(["web_search"], { apply: false });
const plan = registerClaudePlanMode(pi, { toolProfiles: profiles });
assert.equal(plan.enabled, true);

async function emit(event, payload = {}) {
  let result;
  for (const handler of handlers.get(event) ?? []) {
    const next = await handler({ type: event, ...payload }, ctx);
    if (next !== undefined) result = next;
  }
  return result;
}

await emit("session_start", { reason: "startup" });
await commands.get("plan").handler("on Inspect the repository", ctx);
assert.equal(profiles.mode, "plan");
assert.deepEqual(activeTools, ["read", "plan_write", "ExitPlanMode", "ask_user_question"]);
assert.ok(notifications.some((entry) => /web_search \(permanently disabled\)/.test(entry.message)));
assert.equal(ctx.model.provider, "planner");
assert.equal(thinkingLevel, "high");

let promptResult = await emit("before_agent_start", { systemPrompt: "base" });
assert.match(promptResult.systemPrompt, /configured Plan tool allowlist is: \\`read\\`, \\`ask_user_question\\`/);
assert.doesNotMatch(promptResult.systemPrompt, /configured Plan tool allowlist is:[^\\n]*web_search/);

profiles.setProfile("normal", ["shell_command"]);
assert.deepEqual(activeTools, ["read", "plan_write", "ExitPlanMode", "ask_user_question"]);
profiles.setPermanentDisabled(["web_search", "read"]);
assert.deepEqual(activeTools, ["plan_write", "ExitPlanMode", "ask_user_question"]);
promptResult = await emit("before_agent_start", { systemPrompt: "base" });
assert.doesNotMatch(promptResult.systemPrompt, /configured Plan tool allowlist is:[^\\n]*read/);

const validPlan = \`# Implementation Plan

## Context
Replace the printer bitmap rendering path while preserving behavior.

## Implementation Steps
1. \\`src/index.js\\`
   - Reuse the existing profile controller and update the concrete integration path.

## Verification
- \\`npm test\\`
- Confirm the end-to-end Plan handoff.
\`;
await tools.get("plan_write").execute("write", { content: validPlan, expected_revision: 1 }, undefined, undefined, ctx);
await tools.get("ExitPlanMode").execute("exit", {}, undefined, undefined, ctx);
assert.equal(entries.filter((entry) => entry.customType === PLAN_STATE_ENTRY).at(-1).data.stage, "ready");
assert.equal(profiles.mode, "plan");

await commands.get("plan-approve").handler("keep", ctx);
assert.equal(profiles.mode, "execution");
assert.ok(activeTools.includes("shell_command"));
assert.equal(ctx.model.provider, "executor");
assert.equal(thinkingLevel, "xhigh");
assert.ok(sentMessages.some((entry) => entry.message?.customType));

await commands.get("plan").handler("finish", ctx);
assert.equal(profiles.mode, "normal");
assert.ok(activeTools.includes("shell_command"));

await rm(root, { recursive: true, force: true });
console.log("integrated Plan profile tests passed");
`;
await write("test/plan-integration.test.mjs", planIntegrationTest);

let readme = await read("README.md");
readme = replaceOnce(
  readme,
  `一个面向 Pi coding agent 的轻量 package，提供两个 Codex 风格基础工具：`,
  `一个面向 Pi coding agent 的统一工具策略 package：既提供 Codex 风格基础工具，也统一管理 normal、Plan 和 execution 三个工具 Profile。`,
  "README introduction",
);
readme = replaceOnce(readme, `从 **0.3.0** 开始，插件把原 \`/tools\` 扩展的全工具管理功能合并到 \`/only-tools\`。`, `从 **0.4.0** 开始，Claude 风格 Plan Mode 已合并进本插件，并与普通工具状态共享同一个 ToolProfileController。原 \`/tools\` 管理能力仍由 \`/only-tools\` 提供。`, "README version note");
const profileDocs = `## 统一工具 Profile

插件现在只有一个地方负责调用 Pi 的 \`setActiveTools()\`，并维护三个独立 Profile：

- \`normal\`：普通会话工具，由 \`/only-tools\` 管理；
- \`plan\`：Plan Mode 调查工具白名单，并固定加入 \`plan_write\` 与 \`ExitPlanMode\`；
- \`execution\`：计划批准后的执行工具快照。

永久禁用规则位于所有 Profile 之上。普通会话中禁用某个工具不会阻止 Plan Profile 临时启用它；标记为“永久禁用”则会从 Plan 和 execution 中同时移除。\`plan_write\` 与 \`ExitPlanMode\` 是受保护的 workflow 工具，不会进入永久禁用列表。

查看有效 Profile：

\`\`\`text
/only-tools status
/only-tools profiles
\`\`\`

### Plan Mode 配置

Plan 配置已经成为 pi-only-tools 的一部分：

\`\`\`text
/only-tools plan
/plan config
\`\`\`

两条命令打开同一个配置界面，可分别设置：

- Plan Mode 允许使用的工具；
- Plan 模型与思考强度；
- Execute 模型与思考强度；
- 全局配置或受信任项目配置。

“Show effective configuration” 会同时展示 \`requestedTools\`、经过注册状态和永久禁用规则过滤后的 \`effectiveTools\`，以及每个不可用工具的原因。这样配置文件与模型最终实际收到的工具不会再悄悄分叉。

默认 Plan 调查工具为：

\`\`\`text
read
grep
find
ls
ask_user_question（若已安装）
\`\`\`

配置文件继续兼容原插件：

\`\`\`text
~/.pi/agent/claude-plan-mode.json
<project>/.pi/claude-plan-mode.json
\`\`\`

已安装独立 \`pi-claude-plan-mode\` 的用户无需迁移 JSON，但应卸载旧 package，避免重复注册 \`EnterPlanMode\`、\`plan_write\`、\`ExitPlanMode\` 和 \`/plan\`：

\`\`\`bash
pi remove git:github.com/CoderDoubleflower/pi-claude-plan-mode
pi update --extensions
/reload
\`\`\`

集成版本检测到旧插件已先注册 Plan 工具时会停止重复注册并显示 warning。

### Plan workflow

\`\`\`text
normal
  └─ EnterPlanMode / /plan
       └─ plan
            └─ ExitPlanMode + /plan-approve
                 └─ execution
                      └─ /plan finish
                           └─ normal
\`\`\`

Plan 模式继续使用 canonical plan、五阶段内部规划提示、Context / Implementation Steps / Verification 内容契约、keep-context 执行和 fresh child-session handoff。

`;
readme = replaceOnce(readme, `## \`shell_command\``, `${profileDocs}## \`shell_command\``, "README Profile section insertion");
await write("README.md", readme);

const changelog = `# Changelog

## 0.4.0

- Merge Claude-style Plan Mode into pi-only-tools.
- Add unified normal, Plan, and execution tool profiles with one ToolProfileController.
- Add /only-tools plan, /only-tools profiles, and effective-profile diagnostics.
- Preserve legacy claude-plan-mode.json configuration and Plan session state.
- Apply permanent disables consistently without allowing pi-only-tools to overwrite Plan tools.
- Report requested, effective, unregistered, and permanently disabled Plan tools.

`;
await write("CHANGELOG.md", changelog);

console.log("Unified Plan profiles source changes applied.");

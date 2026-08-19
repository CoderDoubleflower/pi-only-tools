import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const temp = await mkdtemp(path.join(os.tmpdir(), "pi-only-tools-test-"));
const agentDir = path.join(temp, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.LC_ALL = "en_US.UTF-8";
process.env.LANG = "en_US.UTF-8";

const { initTheme } = await import("@earendil-works/pi-coding-agent");
initTheme("dark", false);
const { default: plugin, __test } = await import("../src/index.js");

const tools = new Map();
const handlers = new Map();
const commands = new Map();
const sessionEntries = [];
let setActiveToolsCalls = 0;
let activeTools = ["read", "bash", "edit", "write", "custom_extra"];
const allTools = [
  { name: "read", description: "Read files", sourceInfo: { source: "builtin" } },
  { name: "bash", description: "Run shell commands", sourceInfo: { source: "builtin" } },
  { name: "edit", description: "Edit files", sourceInfo: { source: "builtin" } },
  { name: "write", description: "Write files", sourceInfo: { source: "builtin" } },
  { name: "custom_extra", description: "Other extension tool", sourceInfo: { source: "other-extension" } },
];
const pi = {
  registerTool(tool) {
    tools.set(tool.name, tool);
    // Pi normally enables extension tools unless a strict CLI tool policy says otherwise.
    if (!activeTools.includes(tool.name)) activeTools.push(tool.name);
  },
  registerCommand(name, command) {
    commands.set(name, command);
  },
  on(event, handler) {
    const list = handlers.get(event) ?? [];
    list.push(handler);
    handlers.set(event, list);
  },
  getActiveTools() {
    return [...activeTools];
  },
  setActiveTools(names) {
    setActiveToolsCalls += 1;
    activeTools = [...names];
  },
  appendEntry(customType, data) {
    sessionEntries.push({ type: "custom", customType, data });
  },
  getAllTools() {
    return [
      ...allTools,
      ...[...tools.values()].map((tool) => ({
        name: tool.name,
        description: tool.description,
        sourceInfo: { source: "pi-only-tools" },
      })),
    ];
  },
};

plugin(pi);
assert.deepEqual([...tools.keys()], ["shell_command", "apply_patch"]);
assert.deepEqual(activeTools, ["read", "bash", "edit", "write", "custom_extra", "shell_command", "apply_patch"]);
assert.equal(setActiveToolsCalls, 0, "loading the plugin must not force an active-tool allowlist");
assert.deepEqual(__test.ONLY_TOOLS, ["shell_command", "apply_patch"]);
assert.ok(commands.has("only-tools"));
assert.ok(commands.has("pi-only-tools"));
assert.deepEqual([...handlers.keys()], ["tool_result", "session_start", "session_tree", "before_agent_start"]);
assert.deepEqual(__test.getBuiltinTools(pi).map((tool) => tool.name), ["bash", "edit", "read", "write"]);
assert.equal(__test.getGlobalSettingsPath(), path.join(agentDir, "settings.json"));
assert.equal(__test.getProjectSettingsPath(temp), path.join(temp, ".pi", "settings.json"));
assert.deepEqual(__test.normalizeToolNameList([" read ", "bash", "read", "", null]), ["read", "bash"]);
assert.deepEqual(__test.standardDefaultBuiltinNames(__test.getBuiltinTools(pi)), ["read", "bash", "edit", "write"]);
assert.deepEqual(__test.prepareShellArguments({ cmd: "pwd", cwd: ".", timeout: 2 }), {
  command: "pwd",
  workdir: ".",
  timeout_ms: 2_000,
});
assert.deepEqual(__test.preparePatchArguments({ patchText: "patch", cwd: ".", timeout: 3 }), {
  patch: "patch",
  workdir: ".",
  timeout_ms: 3_000,
});

// Official settings.json persistence: preserve unrelated fields and use defaultTools.
const globalSettingsPath = __test.getGlobalSettingsPath();
await mkdir(path.dirname(globalSettingsPath), { recursive: true });
await writeFile(
  globalSettingsPath,
  `${JSON.stringify({ theme: "dark", retry: { enabled: true }, defaultModel: "example" }, null, 2)}\n`,
);
assert.deepEqual(await __test.writeDefaultToolsSetting(["bash", "read", "bash"]), ["bash", "read"]);
let settings = JSON.parse(await readFile(globalSettingsPath, "utf8"));
assert.deepEqual(settings.defaultTools, ["bash", "read"]);
assert.equal(settings.theme, "dark");
assert.deepEqual(settings.retry, { enabled: true });
assert.deepEqual((await __test.readDefaultToolsSetting()).defaultTools, ["bash", "read"]);

const toolsConfigPath = __test.getToolsConfigPath();
assert.deepEqual(await __test.writePermanentlyDisabledTools(["custom_extra", "custom_extra"]), ["custom_extra"]);
assert.deepEqual(await __test.readPermanentlyDisabledTools(), ["custom_extra"]);
let toolsConfig = JSON.parse(await readFile(toolsConfigPath, "utf8"));
assert.deepEqual(toolsConfig, { version: 1, permanentlyDisabledTools: ["custom_extra"] });

await __test.writeDefaultToolsSetting(undefined);
settings = JSON.parse(await readFile(globalSettingsPath, "utf8"));
assert.equal(Object.hasOwn(settings, "defaultTools"), false);
assert.equal(settings.defaultModel, "example");

const malformedSettingsPath = path.join(temp, "bad-settings.json");
await writeFile(malformedSettingsPath, JSON.stringify({ defaultTools: "bash" }));
await assert.rejects(__test.readDefaultToolsSetting(malformedSettingsPath), /defaultTools must be an array/);

// Seed official global and project settings for the TUI tests.
await writeFile(
  globalSettingsPath,
  `${JSON.stringify({ theme: "dark", defaultTools: ["read", "bash"] }, null, 2)}\n`,
);
const projectSettingsPath = __test.getProjectSettingsPath(temp);
await mkdir(path.dirname(projectSettingsPath), { recursive: true });
await writeFile(projectSettingsPath, `${JSON.stringify({ defaultTools: ["read"] }, null, 2)}\n`);

const notifications = [];
const sessionManager = {
  getBranch() {
    return [...sessionEntries];
  },
};
const eventContext = {
  sessionManager,
  ui: {
    notify(message, type) {
      notifications.push({ message, type });
    },
  },
};

// Migrate the old /tools state formats without changing their paths or custom type.
sessionEntries.push({
  type: "custom",
  customType: "tools-config",
  data: { enabledTools: [...activeTools] },
});
await handlers.get("session_start")[0]({}, eventContext);
assert.equal(activeTools.includes("custom_extra"), false);
assert.equal(activeTools.includes("shell_command"), true);

// Reset to an unrestricted state for the TUI interaction tests.
await __test.writePermanentlyDisabledTools([]);
sessionEntries.length = 0;
activeTools = ["read", "bash", "edit", "write", "custom_extra", "shell_command", "apply_patch"];
await handlers.get("session_start")[0]({}, eventContext);

await commands.get("only-tools").handler("", {
  mode: "print",
  ui: {
    notify(message, type) {
      notifications.push({ message, type });
    },
  },
});
assert.ok(notifications.some((entry) => entry.type === "warning" && /TUI/.test(entry.message)));

const theme = {
  fg(_color, text) {
    return String(text);
  },
  bold(text) {
    return String(text);
  },
};

async function openToolSettings(interact) {
  let rendered = [];
  await commands.get("only-tools").handler("", {
    mode: "tui",
    cwd: temp,
    sessionManager,
    ui: {
      notify(message, type) {
        notifications.push({ message, type });
      },
      async custom(factory) {
        return new Promise((resolve) => {
          const tui = { requestRender() {} };
          const component = factory(tui, theme, {}, resolve);
          rendered = component.render(120);
          interact(component);
        });
      },
    },
  });
  return rendered;
}

function moveDown(component, count) {
  for (let index = 0; index < count; index += 1) component.handleInput("\u001b[B");
}

// Disable all detected built-ins (third action row) and keep every non-builtin active tool.
let renderedSettings = await openToolSettings((component) => {
  moveDown(component, 2);
  component.handleInput("\r");
  component.handleInput("\u001b");
});
assert.ok(renderedSettings.some((line) => line.includes("bash")));
assert.ok(renderedSettings.some((line) => line.includes("read")));
assert.ok(renderedSettings.some((line) => line.includes("project's .pi/settings.json")));
assert.deepEqual(activeTools, ["custom_extra", "shell_command", "apply_patch"]);
settings = JSON.parse(await readFile(globalSettingsPath, "utf8"));
assert.deepEqual(settings.defaultTools, []);
assert.equal(settings.theme, "dark");
assert.ok(sessionEntries.some((entry) => entry.customType === "tools-config"));

// Restore official Pi defaults by removing defaultTools (second action row).
renderedSettings = await openToolSettings((component) => {
  moveDown(component, 1);
  component.handleInput("\r");
  component.handleInput("\u001b");
});
settings = JSON.parse(await readFile(globalSettingsPath, "utf8"));
assert.equal(Object.hasOwn(settings, "defaultTools"), false);
for (const name of ["read", "bash", "edit", "write", "custom_extra", "shell_command", "apply_patch"]) {
  assert.ok(activeTools.includes(name), `expected ${name} to remain or become active`);
}

// Session-disable one detected built-in (first tool row, after the four actions).
await openToolSettings((component) => {
  moveDown(component, 4);
  component.handleInput("\r");
  component.handleInput("\u001b");
});
settings = JSON.parse(await readFile(globalSettingsPath, "utf8"));
assert.equal(Object.hasOwn(settings, "defaultTools"), false, "session changes must not alter startup defaults");
assert.equal(activeTools.includes("bash"), false);
assert.equal(activeTools.includes("custom_extra"), true);
assert.equal(activeTools.includes("shell_command"), true);
assert.equal(activeTools.includes("apply_patch"), true);

// Persist the current built-in subset with the first action row.
await openToolSettings((component) => {
  component.handleInput("\r");
  component.handleInput("\u001b");
});
settings = JSON.parse(await readFile(globalSettingsPath, "utf8"));
assert.deepEqual(settings.defaultTools, ["edit", "read", "write"]);

// Permanently disable custom_extra (four actions, four built-ins, then apply_patch and custom_extra).
await openToolSettings((component) => {
  moveDown(component, 9);
  component.handleInput("\r");
  component.handleInput("\r");
  component.handleInput("\u001b");
});
toolsConfig = JSON.parse(await readFile(toolsConfigPath, "utf8"));
assert.deepEqual(toolsConfig.permanentlyDisabledTools, ["custom_extra"]);
assert.equal(activeTools.includes("custom_extra"), false);

// Permanent disables are re-read and enforced before every agent run.
activeTools.push("custom_extra");
await handlers.get("before_agent_start")[0]({}, eventContext);
assert.equal(activeTools.includes("custom_extra"), false);

// Tool execution and Claude-style rendering remain intact.
const ctx = { cwd: temp };
const shell = tools.get("shell_command");
const shellUpdates = [];
const shellResult = await shell.execute(
  "shell-1",
  { command: "printf 'one\\ntwo\\nthree\\nfour\\nfive\\n'", timeout_ms: 5_000 },
  undefined,
  (update) => shellUpdates.push(update),
  ctx,
);
assert.equal(shellResult.details.exitCode, 0);
assert.match(shellResult.content[0].text, /one/);
assert.ok(shellUpdates.length >= 1);
const shellSuccessHookResult = await handlers.get("tool_result")[0]({
  toolName: "shell_command",
  details: shellResult.details,
  isError: false,
});
assert.equal(shellSuccessHookResult, undefined);
const shellCallLines = shell.renderCall({ command: "printf test" }, theme, { cwd: temp }).render(100);
assert.match(shellCallLines[0], /^Bash\(/);
assert.ok(shellCallLines.every((line) => !line.includes("⏺")));
const shellRenderLines = shell.renderResult(shellResult, { expanded: false, isPartial: false }, theme, {}).render(100);
assert.match(shellRenderLines[0], /^  ⎿  one/);
assert.ok(shellRenderLines.some((line) => line.includes("… +2 lines (ctrl+o to expand)")));

const mixedResult = await shell.execute(
  "shell-2",
  { command: "printf 'stdout-line\n'; printf 'stderr-line\n' >&2", timeout_ms: 5_000 },
  undefined,
  undefined,
  ctx,
);
const mixedRenderLines = shell.renderResult(mixedResult, { expanded: false, isPartial: false }, theme, {}).render(100);
assert.equal(mixedRenderLines.filter((line) => line.startsWith("  ⎿  ")).length, 2);
assert.ok(mixedRenderLines.some((line) => line.includes("stdout-line")));
assert.ok(mixedRenderLines.some((line) => line.includes("stderr-line")));

const failedShellResult = await shell.execute(
  "shell-3",
  { command: "printf 'failed-output\\n'; exit 7", timeout_ms: 5_000 },
  undefined,
  undefined,
  ctx,
);
assert.equal(failedShellResult.details.exitCode, 7);
assert.match(failedShellResult.content[0].text, /failed-output/);
assert.match(failedShellResult.content[0].text, /Command exited with code 7/);
assert.deepEqual(
  await handlers.get("tool_result")[0]({
    toolName: "shell_command",
    details: failedShellResult.details,
    isError: false,
  }),
  { isError: true },
);
for (const details of [
  { exitCode: null, timedOut: true },
  { exitCode: null, aborted: true },
  { exitCode: null, signal: "SIGTERM" },
  { exitCode: null, spawnError: "spawn failed" },
]) {
  assert.deepEqual(
    await handlers.get("tool_result")[0]({
      toolName: "shell_command",
      details,
      isError: false,
    }),
    { isError: true },
  );
}
assert.equal(
  await handlers.get("tool_result")[0]({
    toolName: "apply_patch",
    details: { exitCode: 7 },
    isError: false,
  }),
  undefined,
);

const patchScript = path.join(temp, "mock-apply-patch.mjs");
await writeFile(
  patchScript,
  `#!/usr/bin/env node\nimport { writeFile } from 'node:fs/promises';\nimport path from 'node:path';\nlet input='';\nfor await (const chunk of process.stdin) input += chunk;\nif (!input.includes('*** Begin Patch')) process.exit(2);\nawait writeFile(path.join(process.cwd(), 'foo.txt'), 'new\\n');\nprocess.stdout.write('Done!\\n');\n`,
);
await chmod(patchScript, 0o755);
process.env.PI_ONLY_TOOLS_APPLY_PATCH_COMMAND = patchScript;
await writeFile(path.join(temp, "foo.txt"), "old\n");
const patchTool = tools.get("apply_patch");
const patchText = `*** Begin Patch\n*** Update File: foo.txt\n@@\n-old\n+new\n*** End Patch\n`;
const patchResult = await patchTool.execute(
  "patch-1",
  { patch: patchText, timeout_ms: 5_000 },
  undefined,
  undefined,
  ctx,
);
assert.equal(patchResult.details.exitCode, 0);
assert.equal(await readFile(path.join(temp, "foo.txt"), "utf8"), "new\n");
assert.equal(patchResult.details.patchSummary.additions, 1);
assert.equal(patchResult.details.patchSummary.removals, 1);
const patchCallLines = patchTool.renderCall({ patch: patchText }, theme, { cwd: temp }).render(100);
assert.equal(patchCallLines[0], "Update(foo.txt)");
assert.ok(patchCallLines.every((line) => !line.includes("⏺")));
const patchRenderLines = patchTool.renderResult(patchResult, { expanded: false, isPartial: false }, theme, {}).render(100);
assert.match(patchRenderLines[0], /^  ⎿  Added 1 line, removed 1 line/);
assert.ok(patchRenderLines.some((line) => line.includes("1 -old")));
assert.ok(patchRenderLines.some((line) => line.includes("1 +new")));
assert.ok(!patchRenderLines.some((line) => line.includes("@@")));

assert.ok(notifications.some((entry) => entry.type === "info" && /Tool settings updated|工具设置已更新/.test(entry.message)));
console.log("pi-only-tools tests passed");

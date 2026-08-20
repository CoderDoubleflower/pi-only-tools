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
assert.deepEqual(__test.normalizeToolNameList([" read ", "bash", "read", "", null]), ["read", "bash"]);
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

const toolsConfigPath = __test.getToolsConfigPath();
await mkdir(path.dirname(toolsConfigPath), { recursive: true });
await writeFile(
  toolsConfigPath,
  `{
  "version": 1,
  "permanentlyDisabledTools": [
    "custom_extra"
  ]
}\n`,
);

await __test.writeDefaultToolsSetting(undefined);
settings = JSON.parse(await readFile(globalSettingsPath, "utf8"));
assert.equal(Object.hasOwn(settings, "defaultTools"), false);
assert.equal(settings.defaultModel, "example");

// Unified profile matrix: legacy permanent/session state migrates once, then
// all tool choices are persistent per-profile allowlists.
await writeFile(
  globalSettingsPath,
  `{
  "theme": "dark",
  "defaultTools": [
    "read",
    "bash"
  ]
}\n`,
);
const notifications = [];
const sessionManager = {
  getBranch() {
    return [...sessionEntries];
  },
};
const eventContext = {
  cwd: temp,
  sessionManager,
  ui: {
    notify(message, type) {
      notifications.push({ message, type });
    },
  },
};
await handlers.get("session_start")[0]({}, eventContext);
let migratedProfileConfig = JSON.parse(await readFile(toolsConfigPath, "utf8"));
assert.equal(migratedProfileConfig.version, 2);
assert.ok(Array.isArray(migratedProfileConfig.profiles.normal));
assert.ok(Array.isArray(migratedProfileConfig.profiles.plan));
assert.equal(migratedProfileConfig.profiles.normal.includes("custom_extra"), false);

const theme = {
  fg(_color, text) { return String(text); },
  bold(text) { return String(text); },
};
let matrixLines = [];
await commands.get("only-tools").handler("", {
  mode: "tui",
  hasUI: true,
  cwd: temp,
  sessionManager,
  ui: {
    notify(message, type) { notifications.push({ message, type }); },
    async custom(factory) {
      return new Promise((resolve) => {
        const tui = { requestRender() {} };
        const component = factory(tui, theme, {}, resolve);
        matrixLines = component.render(120);
        component.handleInput("\u001b");
      });
    },
  },
});
assert.ok(matrixLines.some((line) => line.includes("Only Tools")));
assert.ok(matrixLines.some((line) => line.includes("NORMAL")));
assert.ok(matrixLines.some((line) => line.includes("PLAN")));
assert.equal(matrixLines.some((line) => line.includes("Execution")), false);
assert.ok(matrixLines.some((line) => line.includes("Model")));
assert.ok(matrixLines.some((line) => line.includes("Effort")));
assert.ok(matrixLines.some((line) => line.includes("NORMAL") && line.includes("PLAN")));

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
const truncatedRenderLines = shell.renderResult(
  {
    details: {
      stdout: "retained output\n",
      stderr: "",
      droppedChars: 10_748,
      exitCode: 0,
      signal: null,
      spawnError: null,
      timedOut: false,
      aborted: false,
    },
  },
  { expanded: true, isPartial: false },
  theme,
  {},
).render(100);
assert.ok(truncatedRenderLines.some((line) => line.includes("retained output")));
assert.ok(truncatedRenderLines.every((line) => !line.includes("Earlier output omitted")));

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

console.log("pi-only-tools tests passed");

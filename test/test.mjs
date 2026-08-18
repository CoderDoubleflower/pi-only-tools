import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const temp = await mkdtemp(path.join(os.tmpdir(), "pi-only-tools-test-"));
const agentDir = path.join(temp, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.LANG = "en_US.UTF-8";

const { default: plugin, __test } = await import("../src/index.js");

const tools = new Map();
const handlers = new Map();
const commands = new Map();
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
assert.equal(handlers.size, 0, "the plugin must not register a tool_call blocker or turn-time enforcer");
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
await commands.get("only-tools").handler("", {
  mode: "print",
  ui: {
    notify(message, type) {
      notifications.push({ message, type });
    },
  },
});
assert.ok(notifications.some((entry) => entry.type === "warning" && /TUI mode/.test(entry.message)));

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

// Disable all detected built-ins (second action row) and keep every non-builtin active tool.
let renderedSettings = await openToolSettings((component) => {
  component.handleInput("\u001b[B");
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
await assert.rejects(access(path.join(agentDir, "pi-only-tools.json")), /ENOENT/);

// Restore official Pi defaults by removing defaultTools (first action row).
renderedSettings = await openToolSettings((component) => {
  component.handleInput("\r");
  component.handleInput("\u001b");
});
settings = JSON.parse(await readFile(globalSettingsPath, "utf8"));
assert.equal(Object.hasOwn(settings, "defaultTools"), false);
for (const name of ["read", "bash", "edit", "write", "custom_extra", "shell_command", "apply_patch"]) {
  assert.ok(activeTools.includes(name), `expected ${name} to remain or become active`);
}

// Toggle one detected built-in (first built-in row, after the three actions).
await openToolSettings((component) => {
  component.handleInput("\u001b[B");
  component.handleInput("\u001b[B");
  component.handleInput("\u001b[B");
  component.handleInput("\r");
  component.handleInput("\u001b");
});
settings = JSON.parse(await readFile(globalSettingsPath, "utf8"));
assert.deepEqual(settings.defaultTools, ["edit", "read", "write"]);
assert.equal(activeTools.includes("bash"), false);
assert.equal(activeTools.includes("custom_extra"), true);
assert.equal(activeTools.includes("shell_command"), true);
assert.equal(activeTools.includes("apply_patch"), true);

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
const shellCallLines = shell.renderCall({ command: "printf test" }, theme, { cwd: temp }).render(100);
assert.match(shellCallLines[0], /^⏺ Bash\(/);
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
assert.equal(patchCallLines[0], "⏺ Update(foo.txt)");
const patchRenderLines = patchTool.renderResult(patchResult, { expanded: false, isPartial: false }, theme, {}).render(100);
assert.match(patchRenderLines[0], /^  ⎿  Added 1 line, removed 1 line/);
assert.ok(patchRenderLines.some((line) => line.includes("1 -old")));
assert.ok(patchRenderLines.some((line) => line.includes("1 +new")));
assert.ok(!patchRenderLines.some((line) => line.includes("@@")));

assert.ok(notifications.some((entry) => entry.type === "info" && /Updated Pi global settings\.json/.test(entry.message)));
console.log("pi-only-tools tests passed");

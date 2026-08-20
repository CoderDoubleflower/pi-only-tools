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
index = index
  .replace(
    'import { CONFIG_DIR_NAME, getAgentDir, getSettingsListTheme } from "@earendil-works/pi-coding-agent";\n',
    'import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";\n',
  )
  .replace('import { SettingsList, truncateToWidth } from "@earendil-works/pi-tui";\n', "")
  .replace('const PI_STANDARD_DEFAULT_TOOLS = Object.freeze(["read", "bash", "edit", "write"]);\n', "")
  .replace('const TOOLS_STATE_ENTRY = "tools-config";\n', "")
  .replace('const TOOL_ITEM_PREFIX = "tool:";\n', "")
  .replace('const ACTION_SAVE_CURRENT = "__save_current_builtins__";\n', "")
  .replace('const ACTION_USE_PI_DEFAULTS = "__use_pi_defaults__";\n', "")
  .replace('const ACTION_DISABLE_ALL = "__disable_all_builtins__";\n', "")
  .replace('const ACTION_ENABLE_ALL = "__enable_all_builtins__";\n', "")
  .replaceAll('    toolProfiles.setPermanentDisabled([], { apply: false });\n', "")
  .replace(
    '    description: "Manage session tools and normal/Plan/execution tool profiles",\n',
    '    description: "Manage the persistent Normal/Plan/Execution tool matrix",\n',
  );

index = replaceOnce(
  index,
  `function getProjectSettingsPath(cwd) {\n  return path.join(cwd, CONFIG_DIR_NAME, "settings.json");\n}\n\n`,
  "",
  "project settings legacy helper",
);
index = replaceBetween(
  index,
  "async function readDefaultToolsSetting(",
  "function delay(ms) {\n",
  "",
  "read default tools legacy helper",
);
index = replaceBetween(
  index,
  "async function readPermanentlyDisabledTools(",
  "function getBuiltinTools(pi) {\n",
  "",
  "legacy permanent helpers",
);
index = replaceBetween(
  index,
  "function equalToolLists(left, right) {\n",
  "export default function piOnlyTools(pi) {\n",
  "",
  "legacy session settings UI helpers",
);

for (const line of [
  "  PI_STANDARD_DEFAULT_TOOLS,\n",
  "  applyBuiltinSelection,\n",
  "  getAllManagedTools,\n",
  "  getProjectSettingsPath,\n",
  "  readDefaultToolsSetting,\n",
  "  readPermanentlyDisabledTools,\n",
  "  standardDefaultBuiltinNames,\n",
  "  writePermanentlyDisabledTools,\n",
]) {
  index = index.replace(line, "");
}
await write("src/index.js", index);

let matrix = await read("src/profile-matrix-ui.js");
matrix = matrix.replace('    options.toolProfiles.setPermanentDisabled([], { apply: false });\n', "");
await write("src/profile-matrix-ui.js", matrix);

let planTest = await read("test/plan-integration.test.mjs");
planTest = planTest
  .replace(
    'const profiles = createToolProfileController(pi, { protectedTools: ["plan_write", "ExitPlanMode"] });\n',
    'const profiles = createToolProfileController(pi);\n',
  )
  .replace('profiles.setPermanentDisabled([], { apply: false });\n', "");
await write("test/plan-integration.test.mjs", planTest);

const controllerTest = `import assert from "node:assert/strict";\nimport { createToolProfileController } from "../src/tool-profile-controller.js";\n\nconst registered = new Set(["shell_command", "apply_patch", "read", "grep", "plan_write", "ExitPlanMode"]);\nlet active = ["shell_command", "apply_patch"];\nconst pi = {\n  getAllTools: () => [...registered].map((name) => ({ name })),\n  getActiveTools: () => [...active],\n  setActiveTools: (names) => { active = [...names]; },\n};\n\nconst profiles = createToolProfileController(pi);\nprofiles.setProfile("normal", ["shell_command", "apply_patch"]);\nprofiles.activate("plan", ["read", "grep", "plan_write", "ExitPlanMode"]);\nassert.deepEqual(active, ["read", "grep", "plan_write", "ExitPlanMode"]);\n\nprofiles.setProfile("normal", ["shell_command"]);\nassert.deepEqual(active, ["read", "grep", "plan_write", "ExitPlanMode"], "editing normal tools must not override Plan Mode");\n\nprofiles.setProfile("plan", ["read", "plan_write", "ExitPlanMode"]);\nassert.deepEqual(active, ["read", "plan_write", "ExitPlanMode"], "editing the active profile applies immediately");\nassert.deepEqual(profiles.getUnavailableTools(["grep", "missing", "plan_write"]), [\n  { name: "missing", reason: "not registered" },\n]);\n\nprofiles.activate("execution", ["shell_command", "apply_patch"]);\nassert.deepEqual(active, ["shell_command", "apply_patch"]);\nprofiles.activate("normal");\nassert.deepEqual(active, ["shell_command"]);\nconst snapshot = profiles.snapshot();\nassert.equal(snapshot.mode, "normal");\nassert.equal(Object.hasOwn(snapshot, "permanentlyDisabledTools"), false);\nconsole.log("tool profile controller tests passed");\n`;
await write("test/tool-profile-controller.test.mjs", controllerTest);

let test = await read("test/test.mjs");
test = test
  .replace('assert.equal(__test.getProjectSettingsPath(temp), path.join(temp, ".pi", "settings.json"));\n', "")
  .replace('assert.deepEqual(__test.standardDefaultBuiltinNames(__test.getBuiltinTools(pi)), ["read", "bash", "edit", "write"]);\n', "")
  .replace('assert.deepEqual((await __test.readDefaultToolsSetting()).defaultTools, ["bash", "read"]);\n', "");

const legacyStart = `const toolsConfigPath = __test.getToolsConfigPath();\nassert.deepEqual(await __test.writePermanentlyDisabledTools(["custom_extra", "custom_extra"]), ["custom_extra"]);\nassert.deepEqual(await __test.readPermanentlyDisabledTools(), ["custom_extra"]);\nlet toolsConfig = JSON.parse(await readFile(toolsConfigPath, "utf8"));\nassert.deepEqual(toolsConfig, { version: 1, permanentlyDisabledTools: ["custom_extra"] });\n`;
const legacyReplacement = `const toolsConfigPath = __test.getToolsConfigPath();\nawait mkdir(path.dirname(toolsConfigPath), { recursive: true });\nawait writeFile(\n  toolsConfigPath,\n  \`${JSON.stringify({ version: 1, permanentlyDisabledTools: ["custom_extra"] }, null, 2)}\\n\`,\n);\n`;
test = replaceOnce(test, legacyStart, legacyReplacement, "legacy tools config fixture");

test = replaceOnce(
  test,
  `const malformedSettingsPath = path.join(temp, "bad-settings.json");\nawait writeFile(malformedSettingsPath, JSON.stringify({ defaultTools: "bash" }));\nawait assert.rejects(__test.readDefaultToolsSetting(malformedSettingsPath), /defaultTools must be an array/);\n\n`,
  "",
  "legacy readDefaultTools test",
);
await write("test/test.mjs", test);

console.log("Final profile matrix policy cleanup applied.");

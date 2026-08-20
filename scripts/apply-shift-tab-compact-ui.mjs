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

let planIndex = await read("src/plan/index.js");
planIndex = replaceOnce(
  planIndex,
  'import { Type } from "typebox";\n',
  'import { Key, matchesKey } from "@earendil-works/pi-tui";\nimport { Type } from "typebox";\n',
  "Pi TUI key helpers import",
);
planIndex = replaceOnce(
  planIndex,
  '    let pendingPlanningContinuation = false;\n',
  '    let pendingPlanningContinuation = false;\n    let removeShiftTabListener;\n',
  "Shift+Tab listener state",
);
planIndex = replaceOnce(
  planIndex,
  '    async function editCanonicalPlan(ctx, options = {}) {\n',
  `    async function togglePlanModeFromShortcut(ctx) {\n        if (typeof ctx.isIdle === "function" && !ctx.isIdle()) {\n            ctx.ui.notify("Shift+Tab can toggle Plan Mode after the current agent turn finishes.", "warning");\n            return;\n        }\n        if (state?.stage === "planning" || state?.stage === "ready") {\n            await leaveCurrentPlan(ctx);\n            ctx.ui.notify("Plan Mode off · Normal profile", "info");\n            return;\n        }\n        const result = await beginPlanning(ctx, { confirm: false });\n        ctx.ui.notify(result.entered ? "Plan Mode on · Shift+Tab to return to Normal" : result.message, result.entered ? "info" : "warning");\n    }\n    function installShiftTabToggle(ctx) {\n        removeShiftTabListener?.();\n        removeShiftTabListener = undefined;\n        if (ctx.mode !== "tui" || typeof ctx.ui.onTerminalInput !== "function")\n            return;\n        removeShiftTabListener = ctx.ui.onTerminalInput((data) => {\n            if (!matchesKey(data, Key.shift("tab")))\n                return;\n            void togglePlanModeFromShortcut(ctx).catch((error) => {\n                ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");\n            });\n            return { consume: true };\n        });\n    }\n    async function editCanonicalPlan(ctx, options = {}) {\n`,
  "Shift+Tab Plan toggle helpers",
);
planIndex = replaceOnce(
  planIndex,
  '    pi.on("session_start", async (event, ctx) => {\n        await restoreBranchRuntime(ctx, undefined, event.reason !== "new");\n',
  '    pi.on("session_start", async (event, ctx) => {\n        await restoreBranchRuntime(ctx, undefined, event.reason !== "new");\n        installShiftTabToggle(ctx);\n',
  "install Shift+Tab listener on session start",
);
planIndex = replaceOnce(
  planIndex,
  '    pi.on("session_shutdown", (_event, ctx) => {\n        pendingPlanningContinuation = false;\n',
  '    pi.on("session_shutdown", (_event, ctx) => {\n        removeShiftTabListener?.();\n        removeShiftTabListener = undefined;\n        pendingPlanningContinuation = false;\n',
  "remove Shift+Tab listener on shutdown",
);
await write("src/plan/index.js", planIndex);

let matrix = await read("src/profile-matrix-ui.js");
matrix = matrix
  .replace('        title: "工具 Profile 矩阵",', '        title: "Only Tools",')
  .replace('        subtitle: "Normal / Plan 是列；Model、Effort 和工具是行。所有修改都会持久保存。",', '        subtitle: "",')
  .replace('        help: "↑↓ 行  ←→ Profile  Enter 编辑/切换  Space 切换工具  M 模型  E/T Effort  A 全选  N 清空  R 重置  Esc 保存",', '        help: "↑↓ 行  ←→ Profile  Enter/Space 切换  M 模型  E/T Effort  A/N/R  Esc 保存",')
  .replace('        title: "Tool profile matrix",', '        title: "Only Tools",')
  .replace('        subtitle: "Normal / Plan are columns; Model, Effort, and tools are rows. Every change is persistent.",', '        subtitle: "",')
  .replace('        help: "↑↓ row  ←→ profile  Enter edit/toggle  Space toggle tool  M model  E/T effort  A all  N none  R reset  Esc save",', '        help: "↑↓ row  ←→ profile  Enter/Space toggle  M model  E/T effort  A/N/R  Esc save",');
matrix = replaceOnce(
  matrix,
  `  toolCell(profile, tool) {\n    const lock = lockedCell(profile, tool.name);\n    const enabled = this.cellValue(profile, tool.name);\n    let value = enabled ? "[✓]" : "[×]";\n    if (lock.locked) value += "*";\n    if (!tool.registered) value += "?";\n    return value;\n  }\n`,
  `  toolCell(profile, tool) {\n    const lock = lockedCell(profile, tool.name);\n    const enabled = this.cellValue(profile, tool.name);\n    let value = lock.locked ? (enabled ? "◆" : "◇") : enabled ? "●" : "○";\n    if (!tool.registered) value += "?";\n    return value;\n  }\n`,
  "larger tool-state glyphs",
);
matrix = replaceOnce(
  matrix,
  `    const labelWidth = Math.min(34, maxLabelForWidth, Math.max(12, longestTool + 4));\n    const gap = 2;\n    const profileWidth = Math.max(8, Math.floor((w - labelWidth - gap * 2) / PROFILE_NAMES.length));\n    const pad = (value, size) => truncateToWidth(String(value), Math.max(1, size - 1), "…").padEnd(size);\n    const selectedCell = (value, rowIndex, colIndex) => \`${'${rowIndex === this.row && colIndex === this.col ? "› " : "  "}'}${'${value}'}\`;\n    const rowLabel = (label, rowIndex) => \`${'${rowIndex === this.row ? ">" : " "}'} ${'${label}'}\`;\n\n    const header = [pad("", labelWidth)];\n    PROFILE_NAMES.forEach((profile, colIndex) => {\n      const name = PROFILE_LABELS[profile];\n      header.push(pad(colIndex === this.col ? \`[${'${name}'}]\` : name, profileWidth));\n    });\n\n    const lines = [\n      this.theme.bold(this.copy.title),\n      this.theme.fg("dim", this.copy.subtitle),\n      "",\n      this.theme.fg("muted", header.join(" ".repeat(gap))),\n    ];\n`,
  `    const labelWidth = Math.min(30, maxLabelForWidth, Math.max(12, longestTool + 4));\n    const gap = 2;\n    const availableProfileWidth = Math.max(8, Math.floor((w - labelWidth - gap * 2) / PROFILE_NAMES.length));\n    const profileWidth = Math.min(28, availableProfileWidth);\n    const pad = (value, size) => truncateToWidth(String(value), Math.max(1, size - 1), "…").padEnd(size);\n    const selectedCell = (value, rowIndex, colIndex) => rowIndex === this.row && colIndex === this.col ? this.theme.bold(value) : value;\n    const rowLabel = (label, rowIndex) => \`${'${rowIndex === this.row ? "›" : " "}'} ${'${label}'}\`;\n\n    const header = [pad("", labelWidth)];\n    PROFILE_NAMES.forEach((profile, colIndex) => {\n      const name = PROFILE_LABELS[profile].toUpperCase();\n      header.push(pad(colIndex === this.col ? \`› ${'${name}'}\` : \`  ${'${name}'}\`, profileWidth));\n    });\n\n    const lines = [\n      this.theme.bold(this.copy.title),\n      this.theme.fg("muted", header.join(" ".repeat(gap))),\n    ];\n`,
  "compact matrix header and selection",
);
matrix = replaceOnce(
  matrix,
  `    const profile = this.currentProfile();\n    const kind = this.currentKind();\n    let detail = \`${'${this.copy.selected}'}: ${'${PROFILE_LABELS[profile]}'}\`;\n    if (kind === "model") detail += \` × ${'${this.copy.model}'} · ${'${this.copy.editModel}'}\`;\n    else if (kind === "effort") detail += \` × ${'${this.copy.effort}'} · ${'${this.copy.editEffort}'}\`;\n    else {\n      const tool = this.currentTool();\n      if (tool) {\n        const lock = lockedCell(profile, tool.name);\n        detail += \` × ${'${tool.name}'}\`;\n        if (!tool.registered) detail += \` · ${'${this.copy.unregistered}'}\`;\n        if (lock.locked) detail += \` · ${'${lock.reason === "required" ? this.copy.lockedRequired : this.copy.lockedControl}'}\`;\n      }\n    }\n    lines.push("", this.theme.fg("muted", detail));\n    lines.push(this.theme.fg("muted", this.copy.help));\n`,
  `    const profile = this.currentProfile();\n    const tool = this.currentTool();\n    if (tool) {\n      const lock = lockedCell(profile, tool.name);\n      const notes = [];\n      if (!tool.registered) notes.push(this.copy.unregistered);\n      if (lock.locked) notes.push(lock.reason === "required" ? this.copy.lockedRequired : this.copy.lockedControl);\n      if (notes.length > 0) lines.push("", this.theme.fg("muted", \`${'${tool.name}'} · ${'${notes.join(" · ")}'}\`));\n    }\n    lines.push("", this.theme.fg("muted", this.copy.help));\n`,
  "compact matrix footer",
);
await write("src/profile-matrix-ui.js", matrix);

let planTest = await read("test/plan-integration.test.mjs");
planTest = planTest
  .replace('const sentMessages = [];\n', 'const sentMessages = [];\nconst terminalInputHandlers = new Set();\n')
  .replace('  isIdle: () => true,\n', '  isIdle: () => true,\n')
  .replace('    setEditorText() {},\n', '    setEditorText() {},\n    onTerminalInput(handler) {\n      terminalInputHandlers.add(handler);\n      return () => terminalInputHandlers.delete(handler);\n    },\n');
planTest = replaceOnce(
  planTest,
  `await emit("session_start", { reason: "startup" });\nawait commands.get("plan").handler("on Inspect the repository", ctx);\n`,
  `await emit("session_start", { reason: "startup" });\nassert.equal(terminalInputHandlers.size, 1, "Plan Mode must install one Shift+Tab terminal listener");\nconst terminalInputHandler = [...terminalInputHandlers][0];\nassert.equal(terminalInputHandler("x"), undefined);\nassert.deepEqual(terminalInputHandler("\\u001b[Z"), { consume: true });\nfor (let i = 0; i < 50 && profiles.mode !== "plan"; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));\nassert.equal(profiles.mode, "plan", "Shift+Tab must enter Plan Mode");\nassert.deepEqual(terminalInputHandler("\\u001b[Z"), { consume: true });\nfor (let i = 0; i < 50 && profiles.mode !== "normal"; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));\nassert.equal(profiles.mode, "normal", "Shift+Tab must exit Plan Mode back to Normal");\n\nawait commands.get("plan").handler("on Inspect the repository", ctx);\n`,
  "Shift+Tab integration regression",
);
planTest = replaceOnce(
  planTest,
  `await rm(root, { recursive: true, force: true });\nconsole.log("integrated Plan profile tests passed");\n`,
  `await emit("session_shutdown");\nassert.equal(terminalInputHandlers.size, 0, "Shift+Tab listener must be removed on session shutdown");\nawait rm(root, { recursive: true, force: true });\nconsole.log("integrated Plan profile tests passed");\n`,
  "Shift+Tab listener cleanup regression",
);
await write("test/plan-integration.test.mjs", planTest);

let matrixTest = await read("test/profile-matrix.test.mjs");
matrixTest = matrixTest
  .replace('    title: "Tool profile matrix",', '    title: "Only Tools",')
  .replace('    title: "Tool profile matrix",', '    title: "Only Tools",')
  .replace('assert.ok(readRow?.includes("[✓]"));\nassert.ok(readRow?.includes("[×]"));', 'assert.ok(readRow?.includes("●"));\nassert.ok(readRow?.includes("○"));\nassert.equal(readRow?.includes("["), false, "tool toggles should not use small bracket markers");');
await write("test/profile-matrix.test.mjs", matrixTest);

let mainTest = await read("test/test.mjs");
mainTest = mainTest.replace('assert.ok(matrixLines.some((line) => line.includes("Tool profile matrix")));', 'assert.ok(matrixLines.some((line) => line.includes("Only Tools")));');
await write("test/test.mjs", mainTest);

let pkg = await read("package.json");
pkg = pkg.replace('"version": "0.5.1"', '"version": "0.5.2"');
await write("package.json", pkg);

let changelog = await read("CHANGELOG.md");
changelog = changelog.replace(
  '# Changelog\n\n',
  '# Changelog\n\n## 0.5.2\n\n- Use Shift+Tab as the global Normal/Plan toggle in TUI mode.\n- Consume Shift+Tab before Pi\'s built-in thinking-cycle binding; Effort remains configurable from `/only-tools`.\n- Simplify `/only-tools` spacing and footer text, and replace `[✓]` / `[×]` with larger `●` / `○` state glyphs.\n- Use `◆` / `◇` for locked Plan-control cells and keep `?` for currently unavailable tools.\n\n',
);
await write("CHANGELOG.md", changelog);

let readme = await read("README.md");
readme = readme
  .replace('read                [✓]                     [✓]\nbash                [✓]                     [×]\ngrep                [×]                     [✓]', 'read                ●                       ●\nbash                ●                       ○\ngrep                ○                       ●')
  .replace('工具单元格使用 `[✓]` / `[×]` 表示允许/不允许，`*` 表示该控制工具在当前 Profile 中被锁定，`?` 表示工具当前未注册。', '工具单元格使用更醒目的 `●` / `○` 表示允许/不允许；锁定的控制工具使用 `◆` / `◇`，`?` 表示工具当前未注册。');
readme = readme.replace(
  '### Profile 语义\n',
  '### Plan Mode 快捷键\n\n在 Pi TUI 主界面按 `Shift+Tab`：\n\n- Normal → Plan：直接进入 Plan Mode；\n- Plan / Ready → Normal：退出 Plan Mode 并恢复 Normal；\n- Agent 正在运行时不会中途切换，会提示等待当前 turn 结束。\n\nPi 默认把 `Shift+Tab` 用于循环 thinking level。`pi-only-tools` 启用后会优先消费这个按键作为 Plan toggle；thinking/effort 可以直接在 `/only-tools` 的 Effort 行配置，或者把 Pi 的 `app.thinking.cycle` 重新绑定到其他按键。\n\n### Profile 语义\n',
);
await write("README.md", readme);

console.log("Applied Shift+Tab Plan toggle and compact Only Tools UX.");

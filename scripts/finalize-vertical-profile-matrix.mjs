import { readFile, writeFile } from "node:fs/promises";

async function rewrite(path, transform) {
  const before = await readFile(path, "utf8");
  const after = transform(before);
  if (after === before) throw new Error(`Expected update was not applied: ${path}`);
  await writeFile(path, after, "utf8");
}

await rewrite("src/profile-matrix-ui.js", (text) => text
  .replace(
    '    const labelWidth = Math.min(34, Math.max(12, longestTool + 4));\n    const gap = 2;\n    const profileWidth = Math.max(8, Math.floor((w - labelWidth - gap * 2) / PROFILE_NAMES.length));',
    '    const maxLabelForWidth = Math.max(10, Math.floor(w * 0.4));\n    const labelWidth = Math.min(34, maxLabelForWidth, Math.max(12, longestTool + 4));\n    const gap = 2;\n    const profileWidth = Math.max(8, Math.floor((w - labelWidth - gap * 2) / PROFILE_NAMES.length));',
  )
  .replace(
    '      phaseProfiles[key] = result.action === "model"\n        ? await selectModel(ctx, result.profile, phaseProfiles[key])\n        : await selectThinking(ctx, result.profile, phaseProfiles[key]);\n      dirty = true;\n      continue;',
    '      const before = JSON.stringify(phaseProfiles[key]);\n      const next = result.action === "model"\n        ? await selectModel(ctx, result.profile, phaseProfiles[key])\n        : await selectThinking(ctx, result.profile, phaseProfiles[key]);\n      phaseProfiles[key] = next;\n      if (JSON.stringify(next) !== before) dirty = true;\n      continue;',
  ));

await rewrite("test/test.mjs", (text) => text.replace(
  'assert.ok(matrixLines.some((line) => line.includes("Think")));',
  'assert.ok(matrixLines.some((line) => line.includes("Effort")));\nassert.ok(matrixLines.some((line) => line.includes("Normal") && line.includes("Plan")));',
));

await rewrite("README.md", (text) => text
  .replace(
    '界面把 **Profile 作为行、Tool 作为列**：',
    '界面转置为 **Normal / Plan 作为列，Model / Effort / Tool 作为行**：',
  )
  .replace(
    'Profile     Model                 Think     read      bash      grep      ...\nNormal      provider/model        high       [x]       [x]       [ ]\nPlan        provider/model        xhigh      [x]       [ ]       [x]',
    '                    Normal                  Plan\nModel               provider/model          provider/model\nEffort              high                    xhigh\nread                [✓]                     [✓]\nbash                [✓]                     [×]\ngrep                [×]                     [✓]\n...                 ...                     ...',
  )
  .replace(
    '- `↑ / ↓`：选择 Normal / Plan；\n- `← / →`：选择工具列；\n- `Space / Enter`：切换当前 Profile 对该工具的允许状态；\n- `M`：配置当前 Normal/Plan Profile 的模型；\n- `T`：配置当前 Normal/Plan Profile 的思考强度；',
    '- `↑ / ↓`：选择 Model / Effort / 某个工具行；\n- `← / →`：选择 Normal / Plan 列；\n- `Enter`：Model 行选择模型、Effort 行选择 effort、工具行切换允许状态；\n- `Space`：在工具行切换允许状态；\n- `M`：直接配置当前列的模型；\n- `E / T`：直接配置当前列的 effort（底层仍映射到 Pi thinking level）；',
  )
  .replace(
    'Normal 与 Plan 的模型/思考强度都在同一界面编辑；选择 inherit 时继承 Pi 当前/default。',
    'Normal 与 Plan 的模型/effort 都在同一界面编辑；选择 inherit 时继承 Pi 当前/default。工具单元格使用 `[✓]` / `[×]` 表示允许/不允许，`*` 表示该控制工具在当前 Profile 中被锁定，`?` 表示工具当前未注册。工具较多时列表会纵向滚动。',
  ));

await rewrite("package.json", (text) => text.replace('"version": "0.5.0"', '"version": "0.5.1"'));

await rewrite("CHANGELOG.md", (text) => {
  const marker = "# Changelog\n\n";
  const entry = "## 0.5.1\n\n- Transpose `/only-tools` so Normal/Plan are columns and Model/Effort/tools are rows.\n- Make Enter edit Model/Effort or toggle a tool cell, with arrows matching the visible row/column axes.\n- Use clear `[✓]` / `[×]` tool states, keep locked/unregistered markers, and vertically scroll long tool lists.\n- Preserve the selected matrix cell across model/effort pickers and avoid dirty saves when a picker is cancelled.\n\n";
  if (!text.startsWith(marker)) throw new Error("CHANGELOG header not found");
  return marker + entry + text.slice(marker.length);
});

console.log("Vertical profile matrix UX follow-up applied.");

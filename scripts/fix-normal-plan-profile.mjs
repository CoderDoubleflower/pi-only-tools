import { readFile, writeFile } from "node:fs/promises";

async function rewrite(path, transform) {
  const before = await readFile(path, "utf8");
  const after = transform(before);
  if (after === before) throw new Error(`Expected cleanup was not needed: ${path}`);
  await writeFile(path, after, "utf8");
}

await rewrite("src/plan/index.js", (text) => text.replace(
  `            else {\n                if (toolProfiles)\n                    toolProfiles.activate("normal");\n                else\n                    if (toolProfiles)\n                toolProfiles.activate("normal");\n            else\n                applyActiveTools(buildIdleTools(pi.getActiveTools(), allToolNames()));\n                const loaded = loadPlanModeConfig(ctx.cwd, {`,
  `            else {\n                if (toolProfiles)\n                    toolProfiles.activate("normal");\n                else\n                    applyActiveTools(buildIdleTools(pi.getActiveTools(), allToolNames()));\n                const loaded = loadPlanModeConfig(ctx.cwd, {`,
));

await rewrite("src/index.js", (text) => text.replace(
  "  const toolProfiles = createToolProfileController(pi, { protectedTools: PLAN_REQUIRED_TOOLS });",
  "  const toolProfiles = createToolProfileController(pi);",
));

await rewrite("package.json", (text) => text.replace(
  '"description": "Codex-style shell and patch tools with unified normal, Plan, and execution tool profiles."',
  '"description": "Codex-style shell and patch tools with unified Normal and Plan tool profiles."',
));

await rewrite("README.md", (text) => text.replace(
  "一个面向 Pi coding agent 的统一工具策略 package：既提供 Codex 风格基础工具，也统一管理 normal、Plan 和 execution 三个工具 Profile。",
  "一个面向 Pi coding agent 的统一工具策略 package：既提供 Codex 风格基础工具，也统一管理 Normal 与 Plan 两个工具 Profile。Plan 批准后直接回到 Normal 执行。",
));

console.log("Final Normal/Plan cleanup applied.");

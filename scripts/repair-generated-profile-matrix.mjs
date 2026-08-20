import { readFile, writeFile } from "node:fs/promises";

async function rewrite(path, transform) {
  const before = await readFile(path, "utf8");
  const after = transform(before);
  if (after === before) throw new Error(`Expected generated repair was not needed for ${path}`);
  await writeFile(path, after, "utf8");
}

await rewrite("src/index.js", (text) => text
  .replace(
    "  const supportsPlanModeRuntime = [\n  const supportsPlanModeRuntime = [\n",
    "  const supportsPlanModeRuntime = [\n",
  )
  .replace(
    '  pi.registerCommand("only-tools", {\n  pi.registerCommand("only-tools", {\n',
    '  pi.registerCommand("only-tools", {\n',
  ));

await rewrite("test/test.mjs", (text) => text
  .replace(
    "// Tool execution and Claude-style rendering remain intact.\n// Tool execution and Claude-style rendering remain intact.\n",
    "// Tool execution and Claude-style rendering remain intact.\n",
  )
  .replace(
    'assert.ok(notifications.some((entry) => entry.type === "info" && /Tool settings updated|工具设置已更新/.test(entry.message)));\n',
    "",
  ));

await rewrite("test/plan-integration.test.mjs", (text) => text
  .replace(
    `const profiles = createToolProfileController(pi, { protectedTools: ["plan_write", "ExitPlanMode"] });\nprofiles.setPermanentDisabled(["web_search"], { apply: false });\nconst plan = registerClaudePlanMode(pi, { toolProfiles: profiles });\nassert.equal(plan.enabled, true);`,
    `const profiles = createToolProfileController(pi, { protectedTools: ["plan_write", "ExitPlanMode"] });\nconst plan = registerClaudePlanMode(pi, { toolProfiles: profiles });\n// The integrated extension loads the persistent profile matrix before the Plan\n// session_start hook runs. Mirror that lifecycle here instead of the removed\n// session/permanent denylist model.\nprofiles.setPermanentDisabled([], { apply: false });\nprofiles.setProfile("normal", ["shell_command", "apply_patch", "EnterPlanMode"], { apply: false });\nprofiles.setProfile(\n  "plan",\n  ["read", "ask_user_question", "plan_write", "ExitPlanMode"],\n  { apply: false },\n);\nprofiles.setProfile("execution", ["shell_command", "apply_patch"], { apply: false });\nprofiles.activate("normal");\nassert.equal(plan.enabled, true);`,
  )
  .replace(
    'assert.ok(notifications.some((entry) => entry.message.includes("web_search (permanently disabled)")));\n',
    "",
  )
  .replace(
    'profiles.setPermanentDisabled(["web_search", "read"]);\n',
    'profiles.setProfile("plan", ["ask_user_question", "plan_write", "ExitPlanMode"]);\n',
  ));

await rewrite("README.md", (text) => text.replace(
  "## `shell_command`\n## `shell_command`\n",
  "## `shell_command`\n",
));

await rewrite("CHANGELOG.md", (text) => {
  if (text.startsWith("# Changelog\n\n")) return text;
  const marker = "# Changelog\n\n";
  const index = text.indexOf(marker);
  if (index < 0) throw new Error("Generated changelog lost its title");
  return marker + text.slice(0, index) + text.slice(index + marker.length);
});

console.log("Generated profile matrix sources repaired.");

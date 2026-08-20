import { readFile, writeFile } from "node:fs/promises";

async function rewrite(path, transform) {
  const before = await readFile(path, "utf8");
  const after = transform(before);
  if (after === before) throw new Error(`Expected Normal/Plan follow-up change was not needed: ${path}`);
  await writeFile(path, after, "utf8");
}

await rewrite("src/plan/config-ui.js", (text) => text
  .replace("        execution: { ...config.normal },", "        normal: { ...config.normal },")
  .replace("            execution: config.normal,", "            normal: config.normal,"));

await rewrite("src/plan/index.js", (text) => text.replace(
  `    function applyActiveTools(toolNames) {\n        if (!toolProfiles) {\n            pi.setActiveTools(toolNames);\n            return toolNames;\n        }\n        return toolProfiles.activate(profileForStage(), toolNames);\n    }`,
  `    function applyActiveTools(toolNames) {\n        if (!toolProfiles) {\n            pi.setActiveTools(toolNames);\n            return toolNames;\n        }\n        const profile = profileForStage();\n        // Normal is the persistent source of truth. The internal executing state\n        // tracks an approved plan, but it must never overwrite the Normal allowlist.\n        return profile === "normal"\n            ? toolProfiles.activate("normal")\n            : toolProfiles.activate("plan", toolNames);\n    }`,
));

await rewrite("test/plan-integration.test.mjs", (text) => text.replace(
  'assert.ok(activeTools.includes("shell_command"));\nassert.equal(ctx.model.provider, "normal");',
  'assert.deepEqual(activeTools, ["shell_command"]);\nassert.equal(ctx.model.provider, "normal");',
));

await rewrite("test/profile-matrix.test.mjs", (text) => {
  let next = text.replace(
    'import { runtimeToolsForProfile, __test } from "../src/profile-matrix-ui.js";\n',
    'import { PROFILE_NAMES } from "../src/profile-config.js";\nimport { runtimeToolsForProfile, __test } from "../src/profile-matrix-ui.js";\n\nassert.deepEqual(PROFILE_NAMES, ["normal", "plan"]);\n',
  );
  return next;
});

console.log("Normal/Plan follow-up corrections applied.");

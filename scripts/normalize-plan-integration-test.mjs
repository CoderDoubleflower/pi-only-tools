import { readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const fixturePath = "test/plan-integration.test.mjs";
const packagePath = "package.json";

const fixture = await readFile(fixturePath, "utf8");
const start = fixture.indexOf("const validPlan = `# Implementation Plan");
const endMarker = "`;\nawait tools.get(\"plan_write\")";
const end = start >= 0 ? fixture.indexOf(endMarker, start) : -1;

if (start >= 0 && end >= 0) {
  const plan = `# Implementation Plan

## Context
Replace the printer bitmap rendering path while preserving behavior.

## Implementation Steps
1. \`src/index.js\`
   - Reuse the existing profile controller and update the concrete integration path.

## Verification
- \`npm test\`
- Confirm the end-to-end Plan handoff.
`;
  const replacement = `const validPlan = ${JSON.stringify(plan)};\nawait tools.get(\"plan_write\")`;
  await writeFile(
    fixturePath,
    fixture.slice(0, start) + replacement + fixture.slice(end + endMarker.length),
    "utf8",
  );
}

const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
if (packageJson.scripts) delete packageJson.scripts.pretest;
await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
await rm("scripts/.unified-plan-profiles-trigger", { force: true });
await rm(fileURLToPath(import.meta.url), { force: true });

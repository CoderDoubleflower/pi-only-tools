import { readFile, writeFile } from "node:fs/promises";

async function patch(path, replacements) {
  let content = await readFile(path, "utf8");
  for (const [before, after] of replacements) {
    if (!content.includes(before)) throw new Error(`Patch target not found in ${path}: ${before}`);
    content = content.replace(before, after);
  }
  await writeFile(path, content, "utf8");
}

await patch("test/test.mjs", [
  ['assert.ok(matrixLines.some((line) => line.includes("Normal")));', 'assert.ok(matrixLines.some((line) => line.includes("NORMAL")));'],
  ['assert.ok(matrixLines.some((line) => line.includes("Plan")));', 'assert.ok(matrixLines.some((line) => line.includes("PLAN")));'],
  ['assert.ok(matrixLines.some((line) => line.includes("Normal") && line.includes("Plan")));', 'assert.ok(matrixLines.some((line) => line.includes("NORMAL") && line.includes("PLAN")));'],
]);

await patch("test/profile-matrix.test.mjs", [
  ['const header = rendered.find((line) => line.includes("Normal") && line.includes("Plan"));', 'const header = rendered.find((line) => line.includes("NORMAL") && line.includes("PLAN"));'],
  ['assert.ok(rendered.some((line) => line.trimStart().startsWith("> Model")));', 'assert.ok(rendered.some((line) => line.trimStart().startsWith("› Model")));'],
]);

console.log("Aligned compact matrix header and cursor assertions.");

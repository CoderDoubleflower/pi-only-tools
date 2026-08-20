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

await rewrite("test/test.mjs", (text) => text.replace(
  "// Tool execution and Claude-style rendering remain intact.\n// Tool execution and Claude-style rendering remain intact.\n",
  "// Tool execution and Claude-style rendering remain intact.\n",
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

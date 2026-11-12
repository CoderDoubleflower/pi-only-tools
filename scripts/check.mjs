import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return /\.(?:js|mjs)$/.test(entry.name) ? [file] : [];
  });
}

const root = fileURLToPath(new URL("../", import.meta.url));
const files = ["src", "scripts", "test", "dist"]
  .flatMap((directory) => sourceFiles(path.join(root, directory)))
  .sort();
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.status !== 0) {
    if (result.error) console.error(result.error.message);
    process.exitCode = result.status ?? 1;
    break;
  }
}

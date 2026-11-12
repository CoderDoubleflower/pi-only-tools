import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const directory = new URL("../test/", import.meta.url);
const files = readdirSync(directory)
  .filter((name) => name === "test.mjs" || name.endsWith(".test.mjs"))
  .sort()
  .map((name) => fileURLToPath(new URL(name, directory)));
const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...files], {
  stdio: "inherit",
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;

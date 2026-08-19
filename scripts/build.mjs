import { mkdir, writeFile } from "node:fs/promises";

await mkdir(new URL("../dist/", import.meta.url), { recursive: true });
await writeFile(
  new URL("../dist/index.js", import.meta.url),
  'export { default, __test, __codexTest } from "../src/entry.js";\n',
  "utf8",
);
console.log("Built dist/index.js");

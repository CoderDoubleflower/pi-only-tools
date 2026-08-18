import { copyFile, mkdir } from "node:fs/promises";

await mkdir(new URL("../dist/", import.meta.url), { recursive: true });
await copyFile(new URL("../src/index.js", import.meta.url), new URL("../dist/index.js", import.meta.url));
console.log("Built dist/index.js");

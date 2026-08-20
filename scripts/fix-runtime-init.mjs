import { readFile, writeFile } from "node:fs/promises";

async function replaceOnce(path, search, replacement, label) {
  const content = await readFile(path, "utf8");
  const first = content.indexOf(search);
  if (first < 0) throw new Error(`Patch target not found: ${label}`);
  if (content.indexOf(search, first + search.length) >= 0) throw new Error(`Patch target not unique: ${label}`);
  await writeFile(path, content.slice(0, first) + replacement + content.slice(first + search.length), "utf8");
}

await replaceOnce(
  "src/tool-profile-controller.js",
  "    const initial = uniqueToolNames(pi.getActiveTools?.() ?? []);",
  "    // Extension action methods are unavailable while extensions are being loaded.\n    // The normal profile is initialized from runtime state during session_start instead.\n    const initial = uniqueToolNames(options.initialTools ?? []);",
  "ToolProfileController eager getActiveTools",
);

await replaceOnce(
  "src/index.js",
  `\n  if (supportsPlanModeRuntime) {\n    toolProfiles.setProfile("normal", pi.getActiveTools?.() ?? [], { apply: false });\n  }\n`,
  "\n",
  "eager normal profile snapshot",
);

const entryPath = "test/entry-registration.test.mjs";
let entryTest = await readFile(entryPath, "utf8");
const marker = '\nconsole.log("runtime entry registration test passed");\n';
if (!entryTest.includes(marker)) throw new Error("entry-registration marker not found");
const regression = `\n// A complete ExtensionAPI exposes runtime action methods while loading, but Pi rejects\n// calling them until the runtime is initialized. Registration must therefore be pure.\nconst loadingActions = [\n  "getActiveTools",\n  "setActiveTools",\n  "getAllTools",\n  "getFlag",\n  "sendMessage",\n  "sendUserMessage",\n  "appendEntry",\n  "setSessionName",\n  "getSessionName",\n  "setModel",\n  "getThinkingLevel",\n  "setThinkingLevel",\n];\nconst loadOnlyApi = {\n  registerTool() {},\n  registerCommand() {},\n  registerFlag() {},\n  on() {},\n};\nfor (const name of loadingActions) {\n  loadOnlyApi[name] = () => {\n    throw new Error(\`runtime action called during extension loading: \${name}\`);\n  };\n}\nassert.doesNotThrow(() => plugin(loadOnlyApi));\n`;
entryTest = entryTest.replace(marker, `${regression}${marker}`);
await writeFile(entryPath, entryTest, "utf8");

const packagePath = "package.json";
const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
packageJson.version = "0.4.1";
await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");

const lockPath = "package-lock.json";
const lock = JSON.parse(await readFile(lockPath, "utf8"));
lock.version = "0.4.1";
if (lock.packages?.[""]) lock.packages[""].version = "0.4.1";
await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");

const changelogPath = "CHANGELOG.md";
let changelog = await readFile(changelogPath, "utf8");
if (!changelog.includes("## 0.4.0")) throw new Error("0.4.0 changelog heading not found");
changelog = changelog.replace(
  "## 0.4.0",
  "## 0.4.1\n\n- Defer all ExtensionAPI runtime action calls until Pi has initialized the session runtime.\n- Initialize the normal tool profile during session_start instead of extension registration.\n- Add a regression test that makes runtime actions throw during extension loading.\n\n## 0.4.0",
);
await writeFile(changelogPath, changelog, "utf8");

console.log("Runtime initialization lifecycle fix applied.");

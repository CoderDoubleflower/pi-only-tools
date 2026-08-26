import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  loadProfileConfig,
  PROFILE_CONFIG_VERSION,
  PROFILE_NAMES,
  saveProfileConfig,
} from "../src/profile-config.js";

const root = await mkdtemp(path.join(os.tmpdir(), "pi-only-tools-profile-config-v4-"));
const file = path.join(root, "tools.json");
const defaults = {
  normal: ["read", "bash", "custom", "ExitPlanMode"],
  ask: ["read", "web_fetch", "shell_command", "apply_patch"],
  plan: ["read", "grep", "custom", "ExitPlanMode"],
};

assert.equal(PROFILE_CONFIG_VERSION, 4);
assert.deepEqual(PROFILE_NAMES, ["normal", "ask", "plan"]);

await writeFile(file, JSON.stringify({ version: 1, permanentlyDisabledTools: ["custom"] }));
const migratedV1 = await loadProfileConfig(file, defaults);
assert.equal(migratedV1.migrated, true);
assert.deepEqual(migratedV1.config.profiles.normal, ["read", "bash"]);
assert.deepEqual(migratedV1.config.profiles.ask, ["read", "web_fetch"]);
assert.deepEqual(migratedV1.config.profiles.plan, ["read", "grep"]);
await saveProfileConfig(file, migratedV1.config);
let saved = JSON.parse(await readFile(file, "utf8"));
assert.equal(saved.version, PROFILE_CONFIG_VERSION);
assert.equal(JSON.stringify(saved).includes("ExitPlanMode"), false);
assert.equal(JSON.stringify(saved.profiles.ask).includes("shell_command"), false);

await writeFile(
  file,
  JSON.stringify({
    version: 3,
    profiles: {
      normal: ["read", "ExitPlanMode"],
      plan: ["grep", "ExitPlanMode"],
      execution: ["bash"],
    },
  }),
);
const migratedV3 = await loadProfileConfig(file, defaults);
assert.equal(migratedV3.migrated, true);
assert.deepEqual(migratedV3.config.profiles.normal, ["read"]);
assert.deepEqual(migratedV3.config.profiles.ask, ["read", "web_fetch"]);
assert.deepEqual(migratedV3.config.profiles.plan, ["grep"]);
assert.ok(migratedV3.warnings.some((warning) => warning.includes("persistent Ask profile")));
assert.ok(migratedV3.warnings.some((warning) => warning.includes("version 3 to 4")));
await saveProfileConfig(file, migratedV3.config);
saved = JSON.parse(await readFile(file, "utf8"));
assert.equal(saved.version, 4);
assert.deepEqual(saved.profiles.ask, ["read", "web_fetch"]);

await writeFile(
  file,
  JSON.stringify({
    version: 4,
    profiles: {
      normal: ["read"],
      ask: ["read", "web_fetch", "shell_command", "apply_patch", "write"],
      plan: ["grep"],
    },
  }),
);
const sanitizedV4 = await loadProfileConfig(file, defaults);
assert.equal(sanitizedV4.migrated, true);
assert.deepEqual(sanitizedV4.config.profiles.ask, ["read", "web_fetch"]);
assert.ok(sanitizedV4.warnings.some((warning) => warning.includes("Ask Mode always blocks")));
await saveProfileConfig(file, sanitizedV4.config);

const reloaded = await loadProfileConfig(file, defaults);
assert.equal(reloaded.migrated, false);
assert.deepEqual(reloaded.config, sanitizedV4.config);

await rm(root, { recursive: true, force: true });
console.log("profile config v4 Ask migration tests passed");

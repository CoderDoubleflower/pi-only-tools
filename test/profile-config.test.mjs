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

const root = await mkdtemp(path.join(os.tmpdir(), "pi-only-tools-profile-config-v5-"));
const file = path.join(root, "tools.json");
const defaults = {
  normal: ["read", "bash", "custom", "web_search", "ExitPlanMode"],
  ask: ["read", "web_fetch", "web_search", "shell_command", "apply_patch"],
  plan: ["read", "grep", "custom", "web_search", "ExitPlanMode"],
};

assert.equal(PROFILE_CONFIG_VERSION, 5);
assert.deepEqual(PROFILE_NAMES, ["normal", "ask", "plan"]);

await writeFile(file, JSON.stringify({ version: 1, permanentlyDisabledTools: ["custom"] }));
const migratedV1 = await loadProfileConfig(file, defaults);
assert.equal(migratedV1.migrated, true);
assert.deepEqual(migratedV1.config.profiles.normal, ["read", "bash", "web_search"]);
assert.deepEqual(migratedV1.config.profiles.ask, ["read", "web_fetch", "web_search"]);
assert.deepEqual(migratedV1.config.profiles.plan, ["read", "grep", "web_search"]);
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
assert.deepEqual(migratedV3.config.profiles.normal, ["read", "web_search"]);
assert.deepEqual(migratedV3.config.profiles.ask, ["read", "web_fetch", "web_search"]);
assert.deepEqual(migratedV3.config.profiles.plan, ["grep", "web_search"]);
assert.ok(migratedV3.warnings.some((warning) => warning.includes("persistent Ask profile")));
assert.ok(migratedV3.warnings.some((warning) => warning.includes("integrated web_search")));
assert.ok(migratedV3.warnings.some((warning) => warning.includes("version 3 to 5")));
await saveProfileConfig(file, migratedV3.config);
saved = JSON.parse(await readFile(file, "utf8"));
assert.equal(saved.version, 5);
assert.deepEqual(saved.profiles.ask, ["read", "web_fetch", "web_search"]);

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
assert.deepEqual(sanitizedV4.config.profiles.normal, ["read", "web_search"]);
assert.deepEqual(sanitizedV4.config.profiles.ask, ["read", "web_fetch", "web_search"]);
assert.deepEqual(sanitizedV4.config.profiles.plan, ["grep", "web_search"]);
assert.ok(sanitizedV4.warnings.some((warning) => warning.includes("Ask Mode always blocks")));
assert.ok(sanitizedV4.warnings.some((warning) => warning.includes("integrated web_search")));
await saveProfileConfig(file, sanitizedV4.config);

const reloaded = await loadProfileConfig(file, defaults);
assert.equal(reloaded.migrated, false);
assert.deepEqual(reloaded.config, sanitizedV4.config);

const userRemovedWebSearch = structuredClone(reloaded.config);
for (const profile of PROFILE_NAMES) {
  userRemovedWebSearch.profiles[profile] = userRemovedWebSearch.profiles[profile].filter(
    (name) => name !== "web_search",
  );
}
await saveProfileConfig(file, userRemovedWebSearch);
const removedReloaded = await loadProfileConfig(file, defaults);
assert.equal(removedReloaded.migrated, false);
assert.ok(
  PROFILE_NAMES.every(
    (profile) => !removedReloaded.config.profiles[profile].includes("web_search"),
  ),
  "version 5 must respect a user's later decision to disable web_search",
);

await rm(root, { recursive: true, force: true });
console.log("profile config v5 Web Search migration tests passed");

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  loadProfileConfig,
  PROFILE_CONFIG_VERSION,
  saveProfileConfig,
} from "../src/profile-config.js";

const root = await mkdtemp(path.join(os.tmpdir(), "pi-only-tools-profile-config-v3-"));
const file = path.join(root, "tools.json");
const defaults = {
  normal: ["read", "bash", "custom", "ExitPlanMode"],
  plan: ["read", "grep", "custom", "ExitPlanMode"],
};

await writeFile(file, JSON.stringify({ version: 1, permanentlyDisabledTools: ["custom"] }));
const migratedV1 = await loadProfileConfig(file, defaults);
assert.equal(migratedV1.migrated, true);
assert.deepEqual(migratedV1.config.profiles.normal, ["read", "bash"]);
assert.deepEqual(migratedV1.config.profiles.plan, ["read", "grep"]);
await saveProfileConfig(file, migratedV1.config);
let saved = JSON.parse(await readFile(file, "utf8"));
assert.equal(saved.version, PROFILE_CONFIG_VERSION);
assert.equal(saved.version, 3);
assert.equal(JSON.stringify(saved).includes("ExitPlanMode"), false);

await writeFile(
  file,
  JSON.stringify({
    version: 2,
    profiles: {
      normal: ["read", "ExitPlanMode"],
      plan: ["grep", "ExitPlanMode"],
      execution: ["bash"],
    },
  }),
);
const migratedV2 = await loadProfileConfig(file, defaults);
assert.equal(migratedV2.migrated, true);
assert.deepEqual(migratedV2.config.profiles.normal, ["read"]);
assert.deepEqual(migratedV2.config.profiles.plan, ["grep"]);
assert.ok(migratedV2.warnings.some((warning) => warning.includes("user-controlled")));
await saveProfileConfig(file, migratedV2.config);
saved = JSON.parse(await readFile(file, "utf8"));
assert.equal(saved.version, 3);
assert.equal(JSON.stringify(saved).includes("ExitPlanMode"), false);

const reloaded = await loadProfileConfig(file, defaults);
assert.equal(reloaded.migrated, false);
assert.deepEqual(reloaded.config, migratedV2.config);

await rm(root, { recursive: true, force: true });
console.log("profile config v3 migration tests passed");

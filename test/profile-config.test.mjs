import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadProfileConfig, saveProfileConfig } from "../src/profile-config.js";

const root = await mkdtemp(path.join(os.tmpdir(), "pi-only-tools-profile-config-"));
const file = path.join(root, "tools.json");
const defaults = {
  normal: ["read", "bash", "custom"],
  plan: ["read", "grep", "custom"],
};
await writeFile(file, JSON.stringify({ version: 1, permanentlyDisabledTools: ["custom"] }));
const migrated = await loadProfileConfig(file, defaults);
assert.equal(migrated.migrated, true);
assert.deepEqual(migrated.config.profiles.normal, ["read", "bash"]);
assert.deepEqual(migrated.config.profiles.plan, ["read", "grep"]);
await saveProfileConfig(file, migrated.config);
const saved = JSON.parse(await readFile(file, "utf8"));
assert.equal(saved.version, 2);
assert.equal(Object.hasOwn(saved, "permanentlyDisabledTools"), false);
assert.equal(Object.hasOwn(saved.profiles, "execution"), false);
const reloaded = await loadProfileConfig(file, defaults);
assert.equal(reloaded.migrated, false);
assert.deepEqual(reloaded.config, migrated.config);
await writeFile(file, JSON.stringify({ version: 2, profiles: { normal: ["read"], plan: ["grep"], execution: ["bash"] } }));
const droppedExecution = await loadProfileConfig(file, defaults);
assert.equal(droppedExecution.migrated, true);
assert.equal(Object.hasOwn(droppedExecution.config.profiles, "execution"), false);
await rm(root, { recursive: true, force: true });
console.log("profile config migration tests passed");

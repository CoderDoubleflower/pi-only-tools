import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const PROFILE_CONFIG_VERSION = 2;
export const PROFILE_NAMES = Object.freeze(["normal", "plan"]);

export function normalizeToolNames(values) {
  const result = [];
  const seen = new Set();
  for (const value of values ?? []) {
    if (typeof value !== "string") continue;
    const name = value.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    result.push(name);
  }
  return result;
}

function cloneProfiles(profiles) {
  return Object.fromEntries(PROFILE_NAMES.map((name) => [name, [...(profiles?.[name] ?? [])]]));
}

export function createProfileConfig(defaults = {}) {
  return {
    version: PROFILE_CONFIG_VERSION,
    profiles: cloneProfiles(defaults),
  };
}

function normalizeProfileObject(value, defaults, warnings, source) {
  const profiles = {};
  for (const profile of PROFILE_NAMES) {
    const raw = value?.[profile];
    if (raw === undefined) {
      profiles[profile] = normalizeToolNames(defaults?.[profile]);
      continue;
    }
    if (!Array.isArray(raw)) {
      warnings.push(`${source}: profiles.${profile} must be an array of tool names.`);
      profiles[profile] = normalizeToolNames(defaults?.[profile]);
      continue;
    }
    profiles[profile] = normalizeToolNames(raw);
  }
  return profiles;
}

export async function loadProfileConfig(configPath, defaults = {}) {
  const warnings = [];
  try {
    const parsed = JSON.parse(await readFile(configPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("config root must be an object");
    }

    if (parsed.version === PROFILE_CONFIG_VERSION && parsed.profiles && typeof parsed.profiles === "object") {
      const hadExecutionProfile = Object.prototype.hasOwnProperty.call(parsed.profiles, "execution");
      if (hadExecutionProfile) {
        warnings.push(`${configPath}: removed legacy profiles.execution; approved plans now execute with the Normal profile.`);
      }
      return {
        config: {
          version: PROFILE_CONFIG_VERSION,
          profiles: normalizeProfileObject(parsed.profiles, defaults, warnings, configPath),
        },
        warnings,
        migrated: hadExecutionProfile,
      };
    }

    // Legacy v1 stored one global denylist. Convert it once into omissions from
    // every profile; after migration there is no separate permanent/session state.
    const legacyDisabled = new Set(normalizeToolNames(parsed.permanentlyDisabledTools));
    const migratedProfiles = {};
    for (const profile of PROFILE_NAMES) {
      migratedProfiles[profile] = normalizeToolNames(defaults?.[profile]).filter((name) => !legacyDisabled.has(name));
    }
    if (legacyDisabled.size > 0 || parsed.version === 1) {
      warnings.push(`${configPath}: migrated legacy permanentlyDisabledTools into profile allowlists.`);
    }
    return {
      config: createProfileConfig(migratedProfiles),
      warnings,
      migrated: true,
    };
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return { config: createProfileConfig(defaults), warnings, migrated: true };
    }
    warnings.push(`${configPath}: unable to read profile config: ${error instanceof Error ? error.message : String(error)}`);
    return { config: createProfileConfig(defaults), warnings, migrated: true };
  }
}

export async function saveProfileConfig(configPath, config) {
  const normalized = createProfileConfig(config?.profiles);
  const directory = path.dirname(configPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const tempPath = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(tempPath, configPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return normalized;
}

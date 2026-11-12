import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_ASK_TOOLS, normalizeAskTools } from "./ask-mode-policy.js";
import { LEGACY_EXIT_PLAN_MODE_TOOL } from "./plan/constants.js";

export const PROFILE_CONFIG_VERSION = 6;
export const PROFILE_NAMES = Object.freeze(["normal", "ask", "plan"]);
const V5_INTEGRATED_TOOLS = Object.freeze(["web_search"]);
const V6_BASH_PROFILES = Object.freeze(["ask", "plan"]);

export function normalizeToolNames(values) {
  const result = [];
  const seen = new Set();
  for (const value of values ?? []) {
    if (typeof value !== "string") continue;
    const name = value.trim();
    if (!name || name === LEGACY_EXIT_PLAN_MODE_TOOL || seen.has(name)) continue;
    seen.add(name);
    result.push(name);
  }
  return result;
}

function defaultProfileTools(profile, defaults) {
  if (profile === "ask") return defaults?.ask ?? DEFAULT_ASK_TOOLS;
  return defaults?.[profile];
}

function normalizeProfileTools(profile, values) {
  return profile === "ask"
    ? normalizeAskTools(values)
    : normalizeToolNames(values);
}

function cloneProfiles(profiles) {
  return Object.fromEntries(
    PROFILE_NAMES.map((name) => [
      name,
      normalizeProfileTools(name, defaultProfileTools(name, profiles)),
    ]),
  );
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
      profiles[profile] = normalizeProfileTools(
        profile,
        defaultProfileTools(profile, defaults),
      );
      continue;
    }
    const normalized = normalizeProfileTools(profile, raw);
    if (raw.includes(LEGACY_EXIT_PLAN_MODE_TOOL)) {
      warnings.push(
        `${source}: removed legacy ${LEGACY_EXIT_PLAN_MODE_TOOL}; plan approval is now user-controlled.`,
      );
    }
    if (profile === "ask") {
      const removed = normalizeToolNames(raw).filter(
        (name) => !normalized.includes(name),
      );
      if (removed.length > 0) {
        warnings.push(
          `${source}: removed tools that Ask Mode always blocks: ${removed.join(", ")}.`,
        );
      }
    }
    profiles[profile] = normalized;
  }
  return profiles;
}

function assertToolList(value, name) {
  if (!Array.isArray(value) || value.some((tool) => typeof tool !== "string" || !tool.trim())) {
    throw new Error(`${name} must be an array of non-empty tool names`);
  }
}

function validateProfileConfig(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("config root must be an object");
  }
  const version = parsed.version;
  if (version === 1 || (version === undefined && Array.isArray(parsed.permanentlyDisabledTools))) {
    assertToolList(parsed.permanentlyDisabledTools, "permanentlyDisabledTools");
    return;
  }
  if (![2, 3, 4, 5, PROFILE_CONFIG_VERSION].includes(version)) {
    throw new Error(`unsupported profile config version ${String(version)}; expected 1–${PROFILE_CONFIG_VERSION}`);
  }
  if (!parsed.profiles || typeof parsed.profiles !== "object" || Array.isArray(parsed.profiles)) {
    throw new Error("profiles must be an object");
  }
  for (const profile of PROFILE_NAMES) {
    const value = parsed.profiles[profile];
    // Ask was added in schema 4. The existing profiles are always required;
    // missing allowlists must not turn damaged files into broader defaults.
    if (profile === "ask" && value === undefined && version < 4) continue;
    assertToolList(value, `profiles.${profile}`);
  }
  if (parsed.profiles.execution !== undefined) {
    assertToolList(parsed.profiles.execution, "profiles.execution");
  }
}

function addToolsToProfiles(profiles, profileNames, toolNames) {
  let changed = false;
  for (const profile of profileNames) {
    const selected = profiles[profile];
    if (!Array.isArray(selected)) continue;
    for (const toolName of toolNames) {
      if (selected.includes(toolName)) continue;
      selected.push(toolName);
      changed = true;
    }
  }
  return changed;
}

function addV5IntegratedTools(profiles) {
  return addToolsToProfiles(profiles, PROFILE_NAMES, V5_INTEGRATED_TOOLS);
}

function addV6BashAccess(profiles) {
  return addToolsToProfiles(profiles, V6_BASH_PROFILES, ["bash"]);
}

export async function loadProfileConfig(configPath, defaults = {}) {
  const warnings = [];
  try {
    const parsed = JSON.parse(await readFile(configPath, "utf8"));
    validateProfileConfig(parsed);

    if (
      [2, 3, 4, 5, PROFILE_CONFIG_VERSION].includes(parsed.version) &&
      parsed.profiles &&
      typeof parsed.profiles === "object"
    ) {
      const hadExecutionProfile = Object.prototype.hasOwnProperty.call(
        parsed.profiles,
        "execution",
      );
      const hadAskProfile = Object.prototype.hasOwnProperty.call(
        parsed.profiles,
        "ask",
      );
      const hadLegacyExit = ["normal", "ask", "plan"].some((profile) =>
        Array.isArray(parsed.profiles[profile])
          ? parsed.profiles[profile].includes(LEGACY_EXIT_PLAN_MODE_TOOL)
          : false,
      );
      const normalizedProfiles = normalizeProfileObject(
        parsed.profiles,
        defaults,
        warnings,
        configPath,
      );
      const askRaw = Array.isArray(parsed.profiles.ask)
        ? normalizeToolNames(parsed.profiles.ask)
        : [];
      const hadBlockedAskTools = askRaw.some(
        (name) => !normalizedProfiles.ask.includes(name),
      );
      const addedIntegratedTools =
        parsed.version < 5 && addV5IntegratedTools(normalizedProfiles);
      const addedBashAccess =
        parsed.version < PROFILE_CONFIG_VERSION &&
        addV6BashAccess(normalizedProfiles);

      if (hadExecutionProfile) {
        warnings.push(
          `${configPath}: removed legacy profiles.execution; approved plans execute with the Normal profile.`,
        );
      }
      if (!hadAskProfile) {
        warnings.push(
          `${configPath}: added the persistent Ask profile with safe read-only defaults.`,
        );
      }
      if (addedIntegratedTools) {
        warnings.push(
          `${configPath}: added the integrated web_search tool to Normal, Ask, and Plan profiles.`,
        );
      }
      if (addedBashAccess) {
        warnings.push(
          `${configPath}: added bash to Ask and Plan profiles for skill-compatible read-only inspection.`,
        );
      }
      if (parsed.version !== PROFILE_CONFIG_VERSION) {
        warnings.push(
          `${configPath}: migrated profile config from version ${parsed.version} to ${PROFILE_CONFIG_VERSION}.`,
        );
      }
      return {
        config: {
          version: PROFILE_CONFIG_VERSION,
          profiles: normalizedProfiles,
        },
        warnings,
        migrated:
          parsed.version !== PROFILE_CONFIG_VERSION ||
          hadExecutionProfile ||
          !hadAskProfile ||
          hadLegacyExit ||
          hadBlockedAskTools ||
          addedIntegratedTools ||
          addedBashAccess,
      };
    }

    const legacyDisabled = new Set(
      normalizeToolNames(parsed.permanentlyDisabledTools),
    );
    const migratedProfiles = {};
    for (const profile of PROFILE_NAMES) {
      migratedProfiles[profile] = normalizeProfileTools(
        profile,
        defaultProfileTools(profile, defaults),
      ).filter((name) => !legacyDisabled.has(name));
    }
    const addedIntegratedTools =
      !legacyDisabled.has("web_search") && addV5IntegratedTools(migratedProfiles);
    const addedBashAccess =
      !legacyDisabled.has("bash") && addV6BashAccess(migratedProfiles);
    if (legacyDisabled.size > 0 || parsed.version === 1) {
      warnings.push(
        `${configPath}: migrated legacy permanentlyDisabledTools into profile allowlists.`,
      );
    }
    warnings.push(
      `${configPath}: added the persistent Ask profile with safe read-only defaults.`,
    );
    if (addedIntegratedTools) {
      warnings.push(
        `${configPath}: added the integrated web_search tool to Normal, Ask, and Plan profiles.`,
      );
    }
    if (addedBashAccess) {
      warnings.push(
        `${configPath}: added bash to Ask and Plan profiles for skill-compatible read-only inspection.`,
      );
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
    const message = `${configPath}: unable to read profile config: ${
      error instanceof Error ? error.message : String(error)
    }. The file was preserved; repair it or explicitly restore defaults in /only-tools.`;
    warnings.push(message);
    return {
      config: createProfileConfig({ normal: [], ask: [], plan: [] }),
      warnings,
      migrated: false,
      error: message,
    };
  }
}

/** Preserve the original bytes before an explicit UI recovery replaces invalid configuration. */
export async function backupProfileConfig(configPath) {
  const content = await readFile(configPath);
  const backupPath = `${configPath}.backup-${randomUUID()}`;
  await writeFile(backupPath, content, { flag: "wx", mode: 0o600 });
  return backupPath;
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

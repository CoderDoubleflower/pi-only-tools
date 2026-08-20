import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { THINKING_LEVELS, } from "./types.js";
export function createEmptyPlanModeConfig() {
    return {
        planning: {},
        normal: {},
    };
}
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function parseProfile(value, source, key, warnings) {
    if (value === undefined)
        return {};
    if (!isRecord(value)) {
        warnings.push(`${source}: "${key}" must be an object.`);
        return {};
    }
    const profile = {};
    if (value.provider !== undefined) {
        if (typeof value.provider === "string" && value.provider.trim())
            profile.provider = value.provider.trim();
        else
            warnings.push(`${source}: "${key}.provider" must be a non-empty string.`);
    }
    if (value.model !== undefined) {
        if (typeof value.model === "string" && value.model.trim())
            profile.model = value.model.trim();
        else
            warnings.push(`${source}: "${key}.model" must be a non-empty string.`);
    }
    if (value.thinkingLevel !== undefined) {
        if (typeof value.thinkingLevel === "string" && THINKING_LEVELS.includes(value.thinkingLevel)) {
            profile.thinkingLevel = value.thinkingLevel;
        }
        else {
            warnings.push(`${source}: "${key}.thinkingLevel" must be one of ${THINKING_LEVELS.join(", ")}.`);
        }
    }
    if ((profile.provider && !profile.model) || (!profile.provider && profile.model)) {
        warnings.push(`${source}: "${key}.provider" and "${key}.model" must be configured together; both were ignored.`);
        delete profile.provider;
        delete profile.model;
    }
    return profile;
}
function parseTools(value, source, warnings) {
    if (value === undefined)
        return undefined;
    if (!Array.isArray(value)) {
        warnings.push(`${source}: "tools" must be an array of tool names.`);
        return undefined;
    }
    const tools = [];
    const seen = new Set();
    value.forEach((item, index) => {
        if (typeof item !== "string" || !item.trim()) {
            warnings.push(`${source}: "tools[${index}]" must be a non-empty string.`);
            return;
        }
        const name = item.trim();
        if (seen.has(name))
            return;
        seen.add(name);
        tools.push(name);
    });
    return tools;
}
function readConfigFile(filePath, warnings) {
    if (!existsSync(filePath))
        return createEmptyPlanModeConfig();
    try {
        const parsed = JSON.parse(readFileSync(filePath, "utf8"));
        if (!isRecord(parsed)) {
            warnings.push(`${filePath}: root value must be an object.`);
            return createEmptyPlanModeConfig();
        }
        const tools = parseTools(parsed.tools, filePath, warnings);
        const normalKey = parsed.normal !== undefined ? "normal" : parsed.execution !== undefined ? "execution" : "normal";
        if (parsed.normal === undefined && parsed.execution !== undefined)
            warnings.push(`${filePath}: migrated legacy "execution" model/thinking profile to "normal".`);
        return {
            ...(tools !== undefined ? { tools } : {}),
            planning: parseProfile(parsed.planning, filePath, "planning", warnings),
            normal: parseProfile(parsed[normalKey], filePath, normalKey, warnings),
        };
    }
    catch (error) {
        warnings.push(`${filePath}: unable to read configuration: ${error instanceof Error ? error.message : String(error)}`);
        return createEmptyPlanModeConfig();
    }
}
function mergeProfile(base, override) {
    return {
        ...base,
        ...override,
    };
}
function serializableConfig(config) {
    return {
        ...(config.tools !== undefined ? { tools: [...new Set(config.tools.map((name) => name.trim()).filter(Boolean))] } : {}),
        planning: { ...config.planning },
        normal: { ...config.normal },
    };
}
export async function savePlanModeConfig(filePath, config) {
    const directory = dirname(filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    const content = `${JSON.stringify(serializableConfig(config), null, 2)}\n`;
    try {
        await writeFile(tempPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
        await rename(tempPath, filePath);
    }
    catch (error) {
        await rm(tempPath, { force: true }).catch(() => undefined);
        throw error;
    }
}
export function loadPlanModeConfig(cwd, options) {
    const agentDir = options.agentDir;
    const configDirName = options.configDirName;
    const globalPath = join(agentDir, "claude-plan-mode.json");
    const projectPath = join(cwd, configDirName, "claude-plan-mode.json");
    const warnings = [];
    const globalConfig = readConfigFile(globalPath, warnings);
    const projectConfig = options.loadProjectConfig === false
        ? createEmptyPlanModeConfig()
        : readConfigFile(projectPath, warnings);
    return {
        globalPath,
        projectPath,
        warnings,
        globalConfig,
        projectConfig,
        config: {
            ...(projectConfig.tools !== undefined
                ? { tools: [...projectConfig.tools] }
                : globalConfig.tools !== undefined
                    ? { tools: [...globalConfig.tools] }
                    : {}),
            planning: mergeProfile(globalConfig.planning, projectConfig.planning),
            normal: mergeProfile(globalConfig.normal, projectConfig.normal),
        },
    };
}

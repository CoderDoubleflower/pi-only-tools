import { PLAN_STATE_ENTRY, STATE_SCHEMA_VERSION } from "./constants.js";
import { THINKING_LEVELS } from "./types.js";
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isStringArray(value) {
    return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function isProfile(value) {
    if (!isRecord(value))
        return false;
    if (value.provider !== undefined && typeof value.provider !== "string")
        return false;
    if (value.model !== undefined && typeof value.model !== "string")
        return false;
    return typeof value.thinkingLevel === "string" && THINKING_LEVELS.includes(value.thinkingLevel);
}
function isPlanDocument(value) {
    return (isRecord(value) &&
        typeof value.id === "string" &&
        typeof value.path === "string" &&
        typeof value.revision === "number" &&
        Number.isInteger(value.revision) &&
        value.revision >= 1 &&
        typeof value.hash === "string");
}
function isReadySnapshot(value) {
    return (isRecord(value) &&
        typeof value.revision === "number" &&
        typeof value.hash === "string" &&
        typeof value.preparedAt === "string");
}
function isApprovedSnapshot(value) {
    return (isRecord(value) &&
        typeof value.revision === "number" &&
        typeof value.hash === "string" &&
        typeof value.content === "string" &&
        typeof value.approvedAt === "string");
}
function isSource(value) {
    return (isRecord(value) &&
        typeof value.sourceSessionId === "string" &&
        (value.sourceSessionFile === undefined || typeof value.sourceSessionFile === "string") &&
        (value.sourceSessionName === undefined || typeof value.sourceSessionName === "string") &&
        typeof value.clearContext === "boolean");
}
export function isPlanModeState(value) {
    if (!isRecord(value))
        return false;
    if (value.schemaVersion !== STATE_SCHEMA_VERSION)
        return false;
    if (!["idle", "planning", "ready", "executing", "handed_off"].includes(String(value.stage)))
        return false;
    if (typeof value.updatedAt !== "string")
        return false;
    if (value.plan !== undefined && !isPlanDocument(value.plan))
        return false;
    if (value.baseline !== undefined) {
        if (!isRecord(value.baseline) || !isProfile(value.baseline.profile) || !isStringArray(value.baseline.tools)) {
            return false;
        }
    }
    if (value.planningTools !== undefined && !isStringArray(value.planningTools))
        return false;
    if (value.planningProfile !== undefined && !isProfile(value.planningProfile))
        return false;
    if (value.executionProfile !== undefined && !isProfile(value.executionProfile))
        return false;
    if (value.executionTools !== undefined && !isStringArray(value.executionTools))
        return false;
    if (value.ready !== undefined && !isReadySnapshot(value.ready))
        return false;
    if (value.approved !== undefined && !isApprovedSnapshot(value.approved))
        return false;
    if (value.source !== undefined && !isSource(value.source))
        return false;
    if (value.lastFeedback !== undefined && typeof value.lastFeedback !== "string")
        return false;
    const stage = value.stage;
    if (["planning", "ready", "executing", "handed_off"].includes(stage)) {
        if (value.plan === undefined ||
            value.baseline === undefined ||
            value.planningProfile === undefined ||
            value.executionProfile === undefined) {
            return false;
        }
    }
    if (stage === "ready" && value.ready === undefined)
        return false;
    if (["executing", "handed_off"].includes(stage)) {
        if (value.approved === undefined || value.source === undefined)
            return false;
    }
    return true;
}
export function restorePlanModeState(entries) {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (entry?.type !== "custom" || entry.customType !== PLAN_STATE_ENTRY)
            continue;
        if (isPlanModeState(entry.data))
            return structuredClone(entry.data);
    }
    return undefined;
}
export function touchState(state) {
    return {
        ...state,
        schemaVersion: STATE_SCHEMA_VERSION,
        updatedAt: new Date().toISOString(),
    };
}

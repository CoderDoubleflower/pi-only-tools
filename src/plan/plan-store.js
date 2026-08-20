import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { PLAN_TEMPLATE_MARKER } from "./constants.js";
export function hashPlan(content) {
    return createHash("sha256").update(content, "utf8").digest("hex");
}
function isValidPlanId(id) {
    return /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(id);
}
export function isManagedPlanDocument(document, agentDir) {
    if (!isValidPlanId(document.id))
        return false;
    return resolve(document.path) === resolve(agentDir, "plans", `${document.id}.md`);
}
export function buildInitialPlan(reason) {
    const context = reason?.trim()
        ? reason.trim()
        : "Explain why this change is needed, the problem it addresses, and the intended outcome.";
    return `# Implementation Plan

${PLAN_TEMPLATE_MARKER}

## Context
${context}

## Implementation Steps
1. \`path/to/file.ts\`
   - Describe the concrete change and the behavior it introduces or preserves.
   - Reuse \`existingSymbol\` from \`path/to/existing-file.ts\` where applicable.
   - Note ordering or dependencies on other steps when relevant.

## Verification
- \`exact repository command\`
- Describe the end-to-end behavior or regression scenario that must be confirmed.
`;
}
function errorCode(error) {
    return error && typeof error === "object" && "code" in error
        ? String(error.code)
        : undefined;
}
async function assertSafeDirectory(directory) {
    const info = await lstat(directory);
    if (info.isSymbolicLink())
        throw new Error(`Plan directory must not be a symbolic link: ${directory}`);
    if (!info.isDirectory())
        throw new Error(`Plan directory is not a directory: ${directory}`);
}
async function assertRegularPlanFile(filePath) {
    const info = await lstat(filePath);
    if (info.isSymbolicLink())
        throw new Error(`Plan file must not be a symbolic link: ${filePath}`);
    if (!info.isFile())
        throw new Error(`Plan path is not a regular file: ${filePath}`);
}
async function atomicWrite(filePath, content) {
    const directory = dirname(filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await assertSafeDirectory(directory);
    const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
        await writeFile(tempPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
        await rename(tempPath, filePath);
    }
    catch (error) {
        await rm(tempPath, { force: true }).catch(() => undefined);
        throw error;
    }
}
export async function createPlanDocument(agentDir, reason, options) {
    const id = options?.id ?? randomUUID();
    if (!isValidPlanId(id))
        throw new Error(`Invalid Plan document id: ${id}`);
    const path = join(agentDir, "plans", `${id}.md`);
    const content = buildInitialPlan(reason);
    await atomicWrite(path, content);
    return {
        id,
        path,
        revision: 1,
        hash: hashPlan(content),
    };
}
export async function ensurePlanDocument(document) {
    try {
        await assertRegularPlanFile(document.path);
        return document;
    }
    catch (error) {
        if (errorCode(error) !== "ENOENT")
            throw error;
        const content = buildInitialPlan();
        await atomicWrite(document.path, content);
        return {
            ...document,
            revision: document.revision + 1,
            hash: hashPlan(content),
        };
    }
}
export async function readPlanContent(document) {
    await assertRegularPlanFile(document.path);
    return readFile(document.path, "utf8");
}
export async function updatePlanDocument(document, content, expectedRevision) {
    if (expectedRevision !== undefined && expectedRevision !== document.revision) {
        throw new Error(`Plan revision mismatch: expected ${expectedRevision}, current revision is ${document.revision}.`);
    }
    const normalized = content.endsWith("\n") ? content : `${content}\n`;
    await atomicWrite(document.path, normalized);
    return {
        ...document,
        revision: document.revision + 1,
        hash: hashPlan(normalized),
    };
}
export async function refreshPlanDocument(document) {
    const content = await readPlanContent(document);
    const hash = hashPlan(content);
    if (hash === document.hash) {
        return { document, content, changed: false };
    }
    return {
        content,
        changed: true,
        document: {
            ...document,
            revision: document.revision + 1,
            hash,
        },
    };
}
function readSection(content, title) {
    const lines = content.split(/\r?\n/);
    const heading = new RegExp(`^##\\s+${title}\\s*$`, "i");
    const start = lines.findIndex((line) => heading.test(line));
    if (start < 0)
        return undefined;
    let end = lines.length;
    for (let index = start + 1; index < lines.length; index += 1) {
        if (/^##\s+\S/.test(lines[index] ?? "")) {
            end = index;
            break;
        }
    }
    const body = lines.slice(start + 1, end).join("\n").trim();
    return body || undefined;
}
export function isPlanReady(content) {
    const trimmed = content.trim();
    if (!trimmed)
        return { ready: false, reason: "The plan is empty." };
    if (content.includes(PLAN_TEMPLATE_MARKER)) {
        return { ready: false, reason: "The plan still contains the initial template marker." };
    }
    // Accept the pre-0.2 headings when resuming an older canonical plan, while
    // all newly generated prompts and templates require the Claude-style names.
    const context = readSection(content, "Context") ?? readSection(content, "Objective");
    if (!context)
        return { ready: false, reason: 'The plan must contain a non-empty "## Context" section.' };
    const implementation = readSection(content, "Implementation Steps");
    if (!implementation) {
        return { ready: false, reason: 'The plan must contain a non-empty "## Implementation Steps" section.' };
    }
    if (!/^\s*\d+[.)]\s+\S+/m.test(implementation)) {
        return { ready: false, reason: "The implementation steps section must contain at least one numbered step." };
    }
    const verification = readSection(content, "Verification") ?? readSection(content, "Validation");
    if (!verification) {
        return { ready: false, reason: 'The plan must contain a non-empty "## Verification" section.' };
    }
    if (trimmed.length < 120) {
        return { ready: false, reason: "The plan is too short to review reliably." };
    }
    return { ready: true };
}

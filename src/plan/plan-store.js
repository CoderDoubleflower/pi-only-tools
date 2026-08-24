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
  if (!isValidPlanId(document.id)) return false;
  return resolve(document.path) === resolve(agentDir, "plans", `${document.id}.md`);
}

export function buildInitialPlan(reason) {
  const context = reason?.trim()
    ? reason.trim()
    : "Explain the current problem, relevant constraints, and intended outcome.";
  return `# Implementation Plan

${PLAN_TEMPLATE_MARKER}

## Context
${context}

## Current State
- \`path/to/entrypoint.ts\`: identify the existing entrypoint and its responsibility.
- Trace the current control flow, data flow, and state transitions that the change must preserve or replace.

## Implementation Steps
1. **Describe the first concrete change**
   - Files: \`path/to/file.ts\`
   - Change: describe the exact behavior and code path to update.
   - Reuse: identify existing symbols or components to reuse.
   - Dependencies: note ordering or dependencies when relevant.

## Risks and Compatibility
- Include this section only when a real compatibility, migration, concurrency, recovery, or behavioral risk exists.

## Verification
- Automated: \`exact repository command\`
- Integration: describe the end-to-end state transition or observable behavior to verify.
`;
}

function errorCode(error) {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}

async function assertSafeDirectory(directory) {
  const info = await lstat(directory);
  if (info.isSymbolicLink()) {
    throw new Error(`Plan directory must not be a symbolic link: ${directory}`);
  }
  if (!info.isDirectory()) {
    throw new Error(`Plan directory is not a directory: ${directory}`);
  }
}

async function assertRegularPlanFile(filePath) {
  const info = await lstat(filePath);
  if (info.isSymbolicLink()) {
    throw new Error(`Plan file must not be a symbolic link: ${filePath}`);
  }
  if (!info.isFile()) {
    throw new Error(`Plan path is not a regular file: ${filePath}`);
  }
}

async function atomicWrite(filePath, content) {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertSafeDirectory(directory);
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, content, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function createPlanDocument(agentDir, reason, options) {
  const id = options?.id ?? randomUUID();
  if (!isValidPlanId(id)) throw new Error(`Invalid Plan document id: ${id}`);
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
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
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
    throw new Error(
      `Plan revision mismatch: expected ${expectedRevision}, current revision is ${document.revision}.`,
    );
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
  if (hash === document.hash) return { document, content, changed: false };
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

export function readPlanSection(content, title) {
  const lines = content.split(/\r?\n/);
  const heading = new RegExp(`^##\\s+${title}\\s*$`, "i");
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0) return undefined;
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

export function countPlanSteps(content) {
  const implementation = readPlanSection(content, "Implementation Steps") ?? "";
  return implementation.match(/^\s*\d+[.)]\s+\S+/gm)?.length ?? 0;
}

const PLACEHOLDER_PATTERNS = [
  /\bpath\/to\//i,
  /\bexistingSymbol\b/,
  /\bexact repository command\b/i,
  /\bdescribe the (?:first )?concrete change\b/i,
  /\bidentify the existing\b/i,
  /\bexplain the current problem\b/i,
  /\bTODO\b/,
  /\bTBD\b/,
];

function validationFailure(errors) {
  return {
    ready: false,
    reason: errors[0],
    errors,
  };
}

export function isPlanReady(content) {
  const trimmed = content.trim();
  const errors = [];

  if (!trimmed) return validationFailure(["The plan is empty."]);
  if (content.includes(PLAN_TEMPLATE_MARKER)) {
    errors.push("The plan still contains the initial template marker.");
  }
  if (!/^#\s+\S+/.test(trimmed)) {
    errors.push("The plan must start with a non-empty H1 title.");
  }

  const context =
    readPlanSection(content, "Context") ?? readPlanSection(content, "Objective");
  if (!context) {
    errors.push('The plan must contain a non-empty "## Context" section.');
  }

  const currentState = readPlanSection(content, "Current State");
  if (!currentState) {
    errors.push('The plan must contain a non-empty "## Current State" section.');
  }

  const implementation = readPlanSection(content, "Implementation Steps");
  if (!implementation) {
    errors.push('The plan must contain a non-empty "## Implementation Steps" section.');
  } else if (countPlanSteps(content) < 1) {
    errors.push("The implementation steps section must contain at least one numbered step.");
  }

  const verification =
    readPlanSection(content, "Verification") ?? readPlanSection(content, "Validation");
  if (!verification) {
    errors.push('The plan must contain a non-empty "## Verification" section.');
  }

  const placeholder = PLACEHOLDER_PATTERNS.find((pattern) => pattern.test(content));
  if (placeholder) {
    errors.push("The plan still contains template placeholder text.");
  }
  if (trimmed.length < 180) {
    errors.push("The plan is too short to review reliably.");
  }

  return errors.length > 0 ? validationFailure(errors) : { ready: true, errors: [] };
}

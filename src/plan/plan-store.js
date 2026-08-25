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
  return `# [Localized outcome-oriented title]

${PLAN_TEMPLATE_MARKER}

## [Localized context heading]
${context}

## [Localized current-state heading]
- \`path/to/entrypoint.ts\`: identify the existing entrypoint and its responsibility.
- Trace the current control flow, data flow, and state transitions that the change must preserve or replace.

## [Localized implementation-steps heading]
1. **Describe the first concrete change**
   - Files: \`path/to/file.ts\`
   - Change: describe the exact behavior and code path to update.
   - Reuse: identify existing symbols or components to reuse.
   - Dependencies: note ordering or dependencies when relevant.

## [Localized risks/compatibility heading; remove this H2 when unnecessary]
- Include this section only when a real compatibility, migration, concurrency, recovery, or behavioral risk exists.

## [Localized verification heading]
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

function sectionBody(lines, headingIndex, endIndex) {
  const body = lines.slice(headingIndex + 1, endIndex).join("\n").trim();
  return body || undefined;
}

export function readPlanSections(content) {
  const lines = String(content ?? "").split(/\r?\n/);
  const headings = [];

  let fence;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence.marker && fenceMatch[1].length >= fence.length) {
        fence = undefined;
      }
      continue;
    }
    if (fenceMatch) {
      fence = { marker: fenceMatch[1][0], length: fenceMatch[1].length };
      continue;
    }

    const match = /^##(?!#)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    headings.push({ index, title: match[1].trim() });
  }

  return headings.map((heading, index) => {
    const endIndex = headings[index + 1]?.index ?? lines.length;
    return {
      title: heading.title,
      line: heading.index + 1,
      body: sectionBody(lines, heading.index, endIndex),
    };
  });
}

function normalizedSectionTitle(value) {
  return String(value ?? "").trim().toLowerCase();
}

function sectionByTitles(sections, titles) {
  const accepted = new Set(titles.map(normalizedSectionTitle));
  return sections.find((section) => accepted.has(normalizedSectionTitle(section.title)));
}

export function readPlanSection(content, title) {
  return sectionByTitles(readPlanSections(content), [title])?.body;
}

const LEGACY_SECTION_TITLES = Object.freeze({
  context: ["Context", "Objective"],
  currentState: ["Current State"],
  implementationSteps: ["Implementation Steps"],
  risksAndCompatibility: ["Risks and Compatibility"],
  verification: ["Verification", "Validation"],
});

function resolvePlanStructure(content) {
  const sections = readPlanSections(content);
  const legacy = {
    context: sectionByTitles(sections, LEGACY_SECTION_TITLES.context),
    currentState: sectionByTitles(sections, LEGACY_SECTION_TITLES.currentState),
    implementationSteps: sectionByTitles(
      sections,
      LEGACY_SECTION_TITLES.implementationSteps,
    ),
    risksAndCompatibility: sectionByTitles(
      sections,
      LEGACY_SECTION_TITLES.risksAndCompatibility,
    ),
    verification: sectionByTitles(sections, LEGACY_SECTION_TITLES.verification),
  };
  const requiredLegacyMatches = [
    legacy.context,
    legacy.currentState,
    legacy.implementationSteps,
    legacy.verification,
  ].filter(Boolean).length;

  // Preserve the established English contract, including useful per-section
  // validation errors for incomplete legacy plans.
  if (requiredLegacyMatches >= 2) {
    return { mode: "legacy", sections, ...legacy };
  }

  // Localized plans are recognized by stable section order instead of literal
  // English labels. Four H2 sections are required; a fifth may be inserted for
  // risks/compatibility between implementation and verification.
  if (sections.length === 4 || sections.length === 5) {
    return {
      mode: "localized",
      sections,
      context: sections[0],
      currentState: sections[1],
      implementationSteps: sections[2],
      risksAndCompatibility: sections.length === 5 ? sections[3] : undefined,
      verification: sections[sections.length - 1],
    };
  }

  return { mode: "unresolved", sections, ...legacy };
}

function countNumberedSteps(body) {
  return String(body ?? "").match(/^\s*\d+[.)]\s+\S+/gm)?.length ?? 0;
}

export function countPlanSteps(content) {
  return countNumberedSteps(resolvePlanStructure(content).implementationSteps?.body);
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
  /\[Localized\b[^\]]*\]/i,
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

  const structure = resolvePlanStructure(content);
  if (structure.mode === "unresolved") {
    errors.push(
      "The plan must contain four required H2 sections in order, plus at most one optional risks/compatibility H2 section.",
    );
  }

  if (!structure.context?.body) {
    errors.push("The plan must contain a non-empty context section.");
  }
  if (!structure.currentState?.body) {
    errors.push("The plan must contain a non-empty current-state section.");
  }
  if (!structure.implementationSteps?.body) {
    errors.push("The plan must contain a non-empty implementation-steps section.");
  } else if (countNumberedSteps(structure.implementationSteps.body) < 1) {
    errors.push("The implementation steps section must contain at least one numbered step.");
  }
  if (!structure.verification?.body) {
    errors.push("The plan must contain a non-empty verification section.");
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

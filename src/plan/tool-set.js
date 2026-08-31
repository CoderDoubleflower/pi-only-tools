import {
  ASK_USER_QUESTION_TOOL,
  ENTER_PLAN_MODE_TOOL,
  LEGACY_EXIT_PLAN_MODE_TOOL,
  PLAN_WRITE_TOOL,
  READ_ONLY_PLAN_TOOLS,
} from "./constants.js";

const PLAN_CONTROL_TOOLS = new Set([
  ENTER_PLAN_MODE_TOOL,
  LEGACY_EXIT_PLAN_MODE_TOOL,
  PLAN_WRITE_TOOL,
]);

function unique(values) {
  return [...new Set(values)];
}

function resolveSelectionArgs(selectedOrAll, maybeAll) {
  if (maybeAll) {
    return {
      selected: unique(selectedOrAll),
      allToolNames: maybeAll,
    };
  }
  const allToolNames = selectedOrAll;
  return {
    selected: getDefaultPlanningTools(allToolNames),
    allToolNames,
  };
}

export function getDefaultPlanningTools(allToolNames) {
  return [
    ...READ_ONLY_PLAN_TOOLS.filter((name) => allToolNames.has(name)),
    ...(allToolNames.has(ASK_USER_QUESTION_TOOL) ? [ASK_USER_QUESTION_TOOL] : []),
  ];
}

export function getEffectivePlanningToolSelection(configuredTools, allToolNames) {
  const selected = configuredTools ?? getDefaultPlanningTools(allToolNames);
  return unique(selected.filter((name) => !PLAN_CONTROL_TOOLS.has(name)));
}

export function getConfigurablePlanningTools(allToolNames) {
  return [...allToolNames]
    .filter((name) => !PLAN_CONTROL_TOOLS.has(name))
    .sort((left, right) => left.localeCompare(right));
}

export function buildIdleTools(current, allToolNames) {
  const tools = current.filter(
    (name) => name !== PLAN_WRITE_TOOL && name !== LEGACY_EXIT_PLAN_MODE_TOOL,
  );
  if (allToolNames.has(ENTER_PLAN_MODE_TOOL)) tools.push(ENTER_PLAN_MODE_TOOL);
  return unique(tools.filter((name) => allToolNames.has(name)));
}

export function getMissingPlanningTools(selectedOrAll, maybeAll) {
  const { selected, allToolNames } = resolveSelectionArgs(selectedOrAll, maybeAll);
  const required = [...selected, PLAN_WRITE_TOOL];
  return unique(required).filter((name) => !allToolNames.has(name));
}

export function buildPlanningTools(selectedOrAll, maybeAll) {
  const { selected, allToolNames } = resolveSelectionArgs(selectedOrAll, maybeAll);
  if (!allToolNames.has(PLAN_WRITE_TOOL)) {
    throw new Error(`Plan mode requires a registered ${PLAN_WRITE_TOOL} tool.`);
  }

  const allowed = selected.filter(
    (name) => allToolNames.has(name) && !PLAN_CONTROL_TOOLS.has(name),
  );
  const questionToolEnabled = allowed.includes(ASK_USER_QUESTION_TOOL);
  const orderedAllowed = allowed.filter((name) => name !== ASK_USER_QUESTION_TOOL);
  return unique([
    ...orderedAllowed,
    PLAN_WRITE_TOOL,
    ...(questionToolEnabled ? [ASK_USER_QUESTION_TOOL] : []),
  ]);
}

export function buildExecutionTools(baseline, allToolNames) {
  return unique(
    baseline.filter(
      (name) => allToolNames.has(name) && !PLAN_CONTROL_TOOLS.has(name),
    ),
  );
}

export function isPlanningToolAllowed(toolName, selectedOrAll, maybeAll) {
  const { selected, allToolNames } = resolveSelectionArgs(selectedOrAll, maybeAll);
  return buildPlanningTools(selected, allToolNames).includes(toolName);
}

export const __test = { PLAN_CONTROL_TOOLS };

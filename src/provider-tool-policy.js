const OPENAI_ALLOWED_TOOLS_PROVIDERS = new Set(["openai", "openai-codex"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function uniqueToolNames(values) {
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

function responseFunctionName(tool) {
  if (!isRecord(tool) || tool.type !== "function") return undefined;
  return typeof tool.name === "string" && tool.name.length > 0
    ? tool.name
    : undefined;
}

export function supportsOpenAIAllowedTools(model) {
  return (
    model?.api === "openai-responses" &&
    OPENAI_ALLOWED_TOOLS_PROVIDERS.has(model?.provider)
  );
}

/**
 * Keep the complete Responses tool catalogue byte-for-byte stable and restrict
 * only tool_choice. Returns undefined for payloads that are not recognizable
 * OpenAI Responses requests so compatibility providers remain untouched.
 */
export function applyOpenAIAllowedTools(payload, allowedTools) {
  if (!isRecord(payload)) return undefined;
  if (!Array.isArray(payload.input) || !Array.isArray(payload.tools)) return undefined;
  if (payload.messages !== undefined) return undefined;

  const available = new Set(
    payload.tools.map(responseFunctionName).filter((name) => name !== undefined),
  );
  if (available.size === 0) return undefined;

  const allowed = uniqueToolNames(allowedTools).filter((name) => available.has(name));
  const toolChoice =
    allowed.length === 0
      ? "none"
      : {
          type: "allowed_tools",
          mode: "auto",
          tools: allowed.map((name) => ({ type: "function", name })),
        };

  return {
    ...payload,
    tool_choice: toolChoice,
  };
}

export const __test = {
  OPENAI_ALLOWED_TOOLS_PROVIDERS,
  responseFunctionName,
  uniqueToolNames,
};

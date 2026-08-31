const COMMAND_ARRAY_KEYS = Object.freeze([
  "search_query",
  "image_query",
  "open",
  "click",
  "find",
  "screenshot",
  "finance",
  "weather",
  "sports",
  "time",
]);

const RESPONSE_LENGTHS = new Set(["short", "medium", "long"]);
const MODES = new Set(["disabled", "cached", "indexed", "live"]);
const CONTEXT_SIZES = new Set(["low", "medium", "high"]);

export const DEFAULT_WEB_SEARCH_CONFIG = Object.freeze({
  mode: "live",
  contextSize: "medium",
  allowedDomains: Object.freeze([]),
  maxOutputTokens: 8_000,
  timeoutMs: 60_000,
  includeRecentContext: true,
});

export const MAX_COMMAND_SUMMARY_LENGTH = 60;

function objectValue(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function optionalString(object, key) {
  const value = object[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`web search config ${key} must be a non-empty string`);
  }
  return value.trim();
}

function positiveInteger(value, fallback, label) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`web search config ${label} must be a positive integer`);
  }
  return value;
}

export function normalizeConfig(value) {
  const object = objectValue(value, "web search config");
  const mode = object.mode ?? DEFAULT_WEB_SEARCH_CONFIG.mode;
  if (typeof mode !== "string" || !MODES.has(mode)) {
    throw new Error(
      "web search config mode must be disabled, cached, indexed, or live",
    );
  }

  const contextSize =
    object.contextSize ?? DEFAULT_WEB_SEARCH_CONFIG.contextSize;
  if (typeof contextSize !== "string" || !CONTEXT_SIZES.has(contextSize)) {
    throw new Error(
      "web search config contextSize must be low, medium, or high",
    );
  }

  const allowedDomains = object.allowedDomains ?? [];
  if (
    !Array.isArray(allowedDomains) ||
    allowedDomains.some(
      (domain) => typeof domain !== "string" || domain.trim() === "",
    )
  ) {
    throw new Error(
      "web search config allowedDomains must be an array of non-empty strings",
    );
  }

  if (
    object.includeRecentContext !== undefined &&
    typeof object.includeRecentContext !== "boolean"
  ) {
    throw new Error("web search config includeRecentContext must be boolean");
  }

  let location;
  if (object.location !== undefined) {
    const locationObject = objectValue(
      object.location,
      "web search config location",
    );
    const country = optionalString(locationObject, "country");
    const region = optionalString(locationObject, "region");
    const city = optionalString(locationObject, "city");
    const timezone = optionalString(locationObject, "timezone");
    location = {
      ...(country ? { country } : {}),
      ...(region ? { region } : {}),
      ...(city ? { city } : {}),
      ...(timezone ? { timezone } : {}),
    };
    if (Object.keys(location).length === 0) location = undefined;
  }

  return {
    mode,
    contextSize,
    allowedDomains: allowedDomains.map((domain) => domain.trim()),
    ...(location ? { location } : {}),
    maxOutputTokens: positiveInteger(
      object.maxOutputTokens,
      DEFAULT_WEB_SEARCH_CONFIG.maxOutputTokens,
      "maxOutputTokens",
    ),
    timeoutMs: positiveInteger(
      object.timeoutMs,
      DEFAULT_WEB_SEARCH_CONFIG.timeoutMs,
      "timeoutMs",
    ),
    includeRecentContext:
      object.includeRecentContext ??
      DEFAULT_WEB_SEARCH_CONFIG.includeRecentContext,
  };
}

export function externalWebAccess(mode) {
  if (mode === "cached") return false;
  if (mode === "indexed") return "indexed";
  if (mode === "live") return true;
  throw new Error(`unsupported web search mode: ${mode}`);
}

export function normalizeSearchCommands(value) {
  const source =
    value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const commands = {};
  for (const key of COMMAND_ARRAY_KEYS) {
    const items = source[key];
    if (Array.isArray(items) && items.length > 0) commands[key] = items;
  }
  if (RESPONSE_LENGTHS.has(source.response_length)) {
    commands.response_length = source.response_length;
  }
  return commands;
}

export function buildSearchRequest(options) {
  if (options.config.mode === "disabled") {
    throw new Error("web search is disabled");
  }
  const commands = normalizeSearchCommands(options.commands);
  return {
    id: options.sessionId,
    model: options.model,
    ...(options.input?.length ? { input: options.input } : {}),
    commands,
    settings: {
      ...(options.config.location
        ? {
            user_location: {
              type: "approximate",
              ...options.config.location,
            },
          }
        : {}),
      search_context_size: options.config.contextSize,
      ...(options.config.allowedDomains.length
        ? { filters: { allowed_domains: options.config.allowedDomains } }
        : {}),
      allowed_callers: ["direct"],
      external_web_access: externalWebAccess(options.config.mode),
    },
    max_output_tokens: options.config.maxOutputTokens,
  };
}

function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((item) => {
      if (item === null || typeof item !== "object") return [];
      return item.type === "text" && typeof item.text === "string"
        ? [item.text]
        : [];
    })
    .join("\n");
}

function isContextOnlyUserMessage(text) {
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith("<environment_context>") ||
    trimmed.startsWith("<system-reminder>")
  );
}

export function buildRecentInput(entries, assistantCharacterBudget = 4_000) {
  const messages = (entries ?? []).flatMap((entry) => {
    if (entry?.type !== "message" || !entry.message) return [];
    const role = entry.message.role;
    if (role !== "user" && role !== "assistant") return [];
    const text = textContent(entry.message.content).trim();
    if (!text || (role === "user" && isContextOnlyUserMessage(text))) return [];
    return [{ role, text }];
  });
  const userIndices = messages.flatMap((message, index) =>
    message.role === "user" ? [index] : [],
  );
  if (userIndices.length === 0) return undefined;
  const start = userIndices[Math.max(0, userIndices.length - 2)];
  const selected = messages.slice(start);

  let remainingAssistantCharacters = assistantCharacterBudget;
  const bounded = [...selected]
    .reverse()
    .flatMap((message) => {
      if (message.role === "user") return [message];
      if (remainingAssistantCharacters <= 0) return [];
      const text = message.text.slice(-remainingAssistantCharacters);
      remainingAssistantCharacters -= text.length;
      return [{ ...message, text }];
    })
    .reverse();

  return bounded.map((message) => ({
    type: "message",
    role: message.role,
    content: [
      message.role === "user"
        ? { type: "input_text", text: message.text }
        : { type: "output_text", text: message.text },
    ],
  }));
}

function compactSummary(text) {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_COMMAND_SUMMARY_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_COMMAND_SUMMARY_LENGTH - 3).trimEnd()}...`;
}

function operationSummary(label, values) {
  const [first = "", ...rest] = values;
  return compactSummary(
    `${label} ${first}${rest.length ? ` (+${rest.length})` : ""}`,
  );
}

export function summarizeCommands(value) {
  const commands = normalizeSearchCommands(value);
  if (commands.search_query?.length) {
    return operationSummary(
      "Search",
      commands.search_query.map((query) => query?.q ?? ""),
    );
  }
  if (commands.image_query?.length) {
    return operationSummary(
      "Search images",
      commands.image_query.map((query) => query?.q ?? ""),
    );
  }
  if (commands.open?.length) {
    return operationSummary(
      "Open",
      commands.open.map((operation) => operation?.ref_id ?? ""),
    );
  }
  if (commands.click?.length) {
    return operationSummary(
      "Open link",
      commands.click.map(
        (operation) => `${operation?.ref_id ?? ""}#${operation?.id ?? ""}`,
      ),
    );
  }
  if (commands.find?.length) {
    return operationSummary(
      "Find",
      commands.find.map(
        (operation) =>
          `'${operation?.pattern ?? ""}' in ${operation?.ref_id ?? ""}`,
      ),
    );
  }
  if (commands.screenshot?.length) {
    return operationSummary(
      "Screenshot",
      commands.screenshot.map(
        (operation) =>
          `${operation?.ref_id ?? ""} page ${operation?.pageno ?? ""}`,
      ),
    );
  }
  if (commands.finance?.length) {
    return operationSummary(
      "Finance",
      commands.finance.map((operation) => operation?.ticker ?? ""),
    );
  }
  if (commands.weather?.length) {
    return operationSummary(
      "Weather",
      commands.weather.map((operation) => operation?.location ?? ""),
    );
  }
  if (commands.sports?.length) {
    return operationSummary(
      "Sports",
      commands.sports.map(
        (operation) => `${operation?.league ?? ""} ${operation?.fn ?? ""}`,
      ),
    );
  }
  if (commands.time?.length) {
    return operationSummary(
      "Time",
      commands.time.map((operation) => operation?.utc_offset ?? ""),
    );
  }
  return "Web search";
}

export function parseSearchResponse(value) {
  const object = objectValue(value, "web search response");
  if (typeof object.output !== "string") {
    throw new Error("web search response is missing string output");
  }
  if (
    object.results !== undefined &&
    object.results !== null &&
    !Array.isArray(object.results)
  ) {
    throw new Error("web search response results must be an array");
  }
  return {
    ...(typeof object.encrypted_output === "string" ||
    object.encrypted_output === null
      ? { encrypted_output: object.encrypted_output }
      : {}),
    output: object.output,
    ...(object.results !== undefined ? { results: object.results } : {}),
  };
}

import { readFileSync } from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  buildRecentInput,
  buildSearchRequest,
  normalizeConfig,
  normalizeSearchCommands,
  parseSearchResponse,
  summarizeCommands,
} from "./web-search/model.js";

export const WEB_SEARCH_TOOL = "web_search";
export const WEB_SEARCH_CONFIG_FILE = "web-search.json";

const querySchema = Type.Object(
  {
    q: Type.String({ description: "Search query." }),
    recency: Type.Optional(
      Type.Integer({
        minimum: 0,
        description: "Limit to this many recent days.",
      }),
    ),
    domains: Type.Optional(
      Type.Array(Type.String(), {
        description: "Only return results from these domains.",
      }),
    ),
  },
  { additionalProperties: false },
);

export const webSearchParameters = Type.Object(
  {
    search_query: Type.Optional(
      Type.Array(querySchema, {
        maxItems: 4,
        description: "Run up to four text searches in parallel.",
      }),
    ),
    image_query: Type.Optional(
      Type.Array(querySchema, { description: "Search for images." }),
    ),
    open: Type.Optional(
      Type.Array(
        Type.Object(
          {
            ref_id: Type.String({ description: "Search reference ID or URL." }),
            lineno: Type.Optional(Type.Integer({ minimum: 0 })),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    click: Type.Optional(
      Type.Array(
        Type.Object(
          {
            ref_id: Type.String({ description: "Opened-page reference ID." }),
            id: Type.Integer({ minimum: 0, description: "Numbered link ID." }),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    find: Type.Optional(
      Type.Array(
        Type.Object(
          {
            ref_id: Type.String({ description: "Page reference ID or URL." }),
            pattern: Type.String({ description: "Text to find in the page." }),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    screenshot: Type.Optional(
      Type.Array(
        Type.Object(
          {
            ref_id: Type.String({ description: "PDF reference ID or URL." }),
            pageno: Type.Integer({
              minimum: 0,
              description: "Zero-indexed PDF page number.",
            }),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    finance: Type.Optional(
      Type.Array(
        Type.Object(
          {
            ticker: Type.String(),
            type: Type.Union([
              Type.Literal("equity"),
              Type.Literal("fund"),
              Type.Literal("crypto"),
              Type.Literal("index"),
            ]),
            market: Type.Optional(Type.String()),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    weather: Type.Optional(
      Type.Array(
        Type.Object(
          {
            location: Type.String({ description: "Country, area, or city." }),
            start: Type.Optional(
              Type.String({ description: "Start date in YYYY-MM-DD format." }),
            ),
            duration: Type.Optional(Type.Integer({ minimum: 1 })),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    sports: Type.Optional(
      Type.Array(
        Type.Object(
          {
            tool: Type.Optional(Type.Literal("sports")),
            fn: Type.Union([
              Type.Literal("schedule"),
              Type.Literal("standings"),
            ]),
            league: Type.Union(
              [
                "nba",
                "wnba",
                "nfl",
                "nhl",
                "mlb",
                "epl",
                "ncaamb",
                "ncaawb",
                "ipl",
              ].map((league) => Type.Literal(league)),
            ),
            team: Type.Optional(Type.String()),
            opponent: Type.Optional(Type.String()),
            date_from: Type.Optional(Type.String()),
            date_to: Type.Optional(Type.String()),
            num_games: Type.Optional(Type.Integer({ minimum: 1 })),
            locale: Type.Optional(Type.String()),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    time: Type.Optional(
      Type.Array(
        Type.Object(
          {
            utc_offset: Type.String({
              pattern: "^[+-][0-9]{2}:[0-9]{2}$",
              description: "UTC offset such as +03:00.",
            }),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    response_length: Type.Optional(
      Type.Union([
        Type.Literal("short"),
        Type.Literal("medium"),
        Type.Literal("long"),
      ]),
    ),
  },
  { additionalProperties: false },
);

class DynamicLinesComponent {
  constructor(renderLines) {
    this.renderLines = renderLines;
  }

  render(width) {
    const safeWidth = Math.max(1, Math.floor(width));
    return this.renderLines().map((line) => truncateToWidth(line, safeWidth));
  }

  invalidate() {}
}

function readJsonFile(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

export function getWebSearchConfigPath(env = process.env) {
  const explicit = String(env.PI_ONLY_TOOLS_WEB_SEARCH_CONFIG ?? "").trim();
  return explicit || path.join(getAgentDir(), WEB_SEARCH_CONFIG_FILE);
}

export function loadWebSearchConfig(env = process.env) {
  const packaged = readJsonFile(
    new URL("./web-search/config.json", import.meta.url),
  );
  const overridePath = getWebSearchConfigPath(env);
  try {
    const override = readJsonFile(overridePath);
    if (!override || typeof override !== "object" || Array.isArray(override)) {
      throw new Error("configuration root must be an object");
    }
    return normalizeConfig({ ...packaged, ...override });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return normalizeConfig(packaged);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not load web search configuration from ${overridePath}: ${message}`);
  }
}

function addHeaders(target, source) {
  if (!source) return;
  for (const [name, value] of Object.entries(source)) {
    if (value !== null && value !== undefined) target.set(name, String(value));
  }
}

function responseError(status, body) {
  if (body && typeof body === "object") {
    const nested =
      body.error && typeof body.error === "object"
        ? body.error.message
        : undefined;
    const message = nested ?? body.message ?? body.error;
    if (typeof message === "string") {
      return new Error(`web search request failed (${status}): ${message}`);
    }
  }
  return new Error(`web search request failed with HTTP ${status}`);
}

function resultText(result) {
  return (result?.content ?? [])
    .flatMap((item) =>
      item?.type === "text" && typeof item.text === "string" ? [item.text] : [],
    )
    .join("\n")
    .trim();
}

function renderStatus(context) {
  if (context?.isError) return "Error";
  return context?.isPartial === false ? "OK" : "Running";
}

function themed(theme, color, text) {
  return typeof theme?.fg === "function" ? theme.fg(color, text) : text;
}

function webSearchCallComponent(args, theme, context) {
  const summary = summarizeCommands(args);
  const status = renderStatus(context);
  const statusColor = status === "Error" ? "error" : status === "OK" ? "success" : "warning";
  const title = typeof theme?.bold === "function" ? theme.bold("Web Search") : "Web Search";
  return new DynamicLinesComponent(() => [
    `${title} - ${summary} ${themed(theme, statusColor, `[${status}]`)}`,
  ]);
}

function webSearchResultComponent(result, options, theme, context) {
  const isError = context?.isError === true || result?.isError === true;
  if (!isError || options?.isPartial) return new DynamicLinesComponent(() => []);
  const text = resultText(result) || "Web search failed";
  const firstLine = text.split(/\r?\n/, 1)[0];
  return new DynamicLinesComponent(() => [themed(theme, "error", firstLine)]);
}

export function createCodexWebSearchTool(config = loadWebSearchConfig()) {
  if (config.mode === "disabled") return undefined;

  return {
    name: WEB_SEARCH_TOOL,
    label: "Web Search",
    description:
      "Access the internet using Codex standalone web search. Supports batched text/image search, opening and navigating results, page find, PDF screenshots, finance, weather, sports, and time. Use reference IDs only in later web_search calls; cite final sources with direct Markdown links.",
    promptSnippet:
      "Search and navigate current web sources through the Codex search service",
    promptGuidelines: [
      "Use web_search when the user explicitly asks to search, browse, verify, or find current information.",
      "Browse for unstable, high-stakes, niche, source-sensitive, recommendation, price, law, schedule, product, or current-event claims.",
      "For technical questions, prefer primary sources such as official documentation, specifications, repositories, and papers.",
      "After browsing, cite claims with direct Markdown links near the supported text; never expose internal search reference IDs in the final response.",
    ],
    parameters: webSearchParameters,
    executionMode: "parallel",
    renderShell: "self",

    async execute(_toolCallId, rawCommands, signal, _onUpdate, ctx) {
      const model = ctx.model;
      if (!model) throw new Error("web search requires an active model");
      if (!ctx.modelRegistry?.getApiKeyAndHeaders) {
        throw new Error("web search requires Pi model authentication");
      }
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) {
        throw new Error(`web search authentication failed: ${auth.error}`);
      }

      const baseUrl = auth.baseUrl ?? model.baseUrl;
      if (!baseUrl) throw new Error("web search provider has no base URL");
      const headers = new Headers({
        accept: "application/json",
        "content-type": "application/json",
      });
      addHeaders(headers, model.headers);
      addHeaders(headers, auth.headers);
      if (auth.apiKey && !headers.has("authorization")) {
        headers.set("authorization", `Bearer ${auth.apiKey}`);
      }

      const commands = normalizeSearchCommands(rawCommands);
      const contextEntries =
        ctx.sessionManager?.buildContextEntries?.() ?? [];
      const input = config.includeRecentContext
        ? buildRecentInput(contextEntries)
        : undefined;
      const sessionId = ctx.sessionManager?.getSessionId?.();
      if (!sessionId) throw new Error("web search requires an active session");
      const request = buildSearchRequest({
        sessionId,
        model: model.id,
        commands,
        config,
        input,
      });
      const timeoutSignal = AbortSignal.timeout(config.timeoutMs);
      const requestSignal = signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal;
      const startedAt = Date.now();
      const response = await fetch(
        `${String(baseUrl).replace(/\/+$/, "")}/alpha/search`,
        {
          method: "POST",
          headers,
          body: JSON.stringify(request),
          signal: requestSignal,
        },
      );
      const text = await response.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        if (!response.ok) throw responseError(response.status, undefined);
        throw new Error("web search response was not valid JSON");
      }
      if (!response.ok) throw responseError(response.status, body);

      const searchResponse = parseSearchResponse(body);
      return {
        content: [{ type: "text", text: searchResponse.output }],
        details: {
          summary: summarizeCommands(commands),
          provider: model.provider,
          model: model.id,
          elapsedMs: Date.now() - startedAt,
          resultCount: searchResponse.results?.length ?? 0,
          results: searchResponse.results,
        },
      };
    },

    renderCall(args, theme, context) {
      return webSearchCallComponent(args, theme, context);
    },

    renderResult(result, options, theme, context) {
      return webSearchResultComponent(result, options, theme, context);
    },
  };
}

export function registerCodexWebSearch(pi, config = loadWebSearchConfig()) {
  const tool = createCodexWebSearchTool(config);
  if (!tool) return undefined;
  pi.registerTool(tool);
  return tool;
}

export const __test = {
  addHeaders,
  renderStatus,
  responseError,
  resultText,
  webSearchCallComponent,
  webSearchResultComponent,
};

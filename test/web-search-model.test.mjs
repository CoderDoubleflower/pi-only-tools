import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_COMMAND_SUMMARY_LENGTH,
  buildRecentInput,
  buildSearchRequest,
  externalWebAccess,
  normalizeConfig,
  normalizeSearchCommands,
  parseSearchResponse,
  summarizeCommands,
} from "../src/web-search/model.js";

const config = normalizeConfig({
  mode: "live",
  contextSize: "medium",
  allowedDomains: [" openai.com "],
  location: { country: "US", city: "San Francisco" },
  maxOutputTokens: 2_500,
  timeoutMs: 3_000,
  includeRecentContext: true,
});

test("normalizes configuration and external access modes", () => {
  assert.deepEqual(config.allowedDomains, ["openai.com"]);
  assert.equal(externalWebAccess("cached"), false);
  assert.equal(externalWebAccess("indexed"), "indexed");
  assert.equal(externalWebAccess("live"), true);
});

test("builds the Codex standalone search request and strips display-only fields", () => {
  const request = buildSearchRequest({
    sessionId: "session-1",
    model: "gpt-test",
    commands: {
      purpose: "display only",
      search_query: [{ q: "OpenAI" }],
      image_query: [],
      open: [],
      response_length: "short",
    },
    config,
  });

  assert.deepEqual(request.commands, {
    search_query: [{ q: "OpenAI" }],
    response_length: "short",
  });
  assert.deepEqual(request.settings, {
    user_location: {
      type: "approximate",
      country: "US",
      city: "San Francisco",
    },
    search_context_size: "medium",
    filters: { allowed_domains: ["openai.com"] },
    allowed_callers: ["direct"],
    external_web_access: true,
  });
  assert.equal(request.max_output_tokens, 2_500);
});

test("normalizes command objects before request and rendering", () => {
  assert.deepEqual(
    normalizeSearchCommands({
      purpose: "not an API field",
      search_query: [],
      time: [{ utc_offset: "+00:00" }],
      response_length: "medium",
    }),
    {
      time: [{ utc_offset: "+00:00" }],
      response_length: "medium",
    },
  );
  assert.equal(
    summarizeCommands({
      search_query: [],
      image_query: [],
      open: [],
      time: [{ utc_offset: "+00:00" }],
    }),
    "Time +00:00",
  );
});

test("bounds recent context to the last two user turns and assistant budget", () => {
  const entry = (role, text) => ({
    type: "message",
    message: { role, content: [{ type: "text", text }] },
  });
  const input = buildRecentInput(
    [
      entry("user", "old user"),
      entry("assistant", "old assistant"),
      entry("user", "previous user"),
      entry("assistant", "123456"),
      entry("user", "<environment_context>ignored</environment_context>"),
      entry("user", "current user"),
      entry("assistant", "abcdef"),
    ],
    8,
  );

  assert.deepEqual(input, [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "previous user" }],
    },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "56" }],
    },
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "current user" }],
    },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "abcdef" }],
    },
  ]);
});

test("summarizes commands and validates response shape", () => {
  assert.equal(
    summarizeCommands({ search_query: [{ q: "OpenAI" }, { q: "Codex" }] }),
    "Search OpenAI (+1)",
  );
  assert.deepEqual(
    parseSearchResponse({
      output: "result",
      results: [{ type: "text_result" }],
    }),
    { output: "result", results: [{ type: "text_result" }] },
  );
  assert.throws(() => parseSearchResponse({ results: [] }), /missing string output/);
});

test("bounds and normalizes terminal summaries", () => {
  const summary = summarizeCommands({
    search_query: [
      {
        q: `scroll speed\n${Array.from({ length: 500 }, (_, index) => index + 2025).join(" ")}`,
      },
    ],
  });

  assert.equal(summary.length, MAX_COMMAND_SUMMARY_LENGTH);
  assert.match(summary, /^Search scroll speed 2025 2026/);
  assert.ok(summary.endsWith("..."));
  assert.doesNotMatch(summary, /\s{2,}|\n/);
});

test("rejects invalid configuration", () => {
  assert.throws(() => normalizeConfig({ mode: "unlimited" }), /config mode/);
  assert.throws(
    () => normalizeConfig({ allowedDomains: "openai.com" }),
    /allowedDomains/,
  );
});

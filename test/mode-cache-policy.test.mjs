import assert from "node:assert/strict";
import {
  appendModeProtocol,
  buildModeStateSnapshot,
  createModeStateMessage,
  fingerprintModeState,
  MODE_PROTOCOL_MARKER,
  MODE_PROTOCOL_PROMPT,
  MODE_STATE_MARKER,
  rewriteOpenAIResponsesToolChoice,
} from "../src/mode-cache-policy.js";
import { buildAskSystemPrompt } from "../src/ask-mode-policy.js";
import {
  buildExecutionSystemPrompt,
  buildPlanningSystemPrompt,
  buildReadySystemPrompt,
} from "../src/plan/prompts.js";

assert.equal(buildAskSystemPrompt(["read"]), MODE_PROTOCOL_PROMPT);
assert.equal(
  buildPlanningSystemPrompt({ plan: { path: "/tmp/a.md", revision: 1, hash: "a" } }, ["read"], false),
  MODE_PROTOCOL_PROMPT,
);
assert.equal(
  buildReadySystemPrompt({ plan: { path: "/tmp/b.md", revision: 9, hash: "b" } }),
  MODE_PROTOCOL_PROMPT,
);
assert.equal(buildExecutionSystemPrompt({ approved: { revision: 9, hash: "b" } }), "");
assert.doesNotMatch(MODE_PROTOCOL_PROMPT, /\/tmp\/a\.md|plan_revision: 1|allowed_tools: \["read"\]/);
assert.equal(appendModeProtocol("base"), `base\n\n${MODE_PROTOCOL_PROMPT}`);
assert.equal(appendModeProtocol(appendModeProtocol("base")), appendModeProtocol("base"));
assert.match(MODE_PROTOCOL_PROMPT, new RegExp(MODE_PROTOCOL_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

const snapshot = buildModeStateSnapshot({
  mode: "plan",
  allowedTools: ["read", "plan_write", "read"],
  planState: {
    stage: "planning",
    plan: { path: "/tmp/plan.md", revision: 3, hash: "abc123" },
  },
});
assert.deepEqual(snapshot, {
  version: 1,
  mode: "plan",
  stage: "planning",
  allowedTools: ["read", "plan_write"],
  plan: { path: "/tmp/plan.md", revision: 3, hash: "abc123" },
});
const message = createModeStateMessage(snapshot);
assert.equal(message.display, false);
assert.match(message.content, new RegExp(MODE_STATE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
assert.match(message.content, /plan_revision: 3/);
assert.match(message.content, /allowed_tools: \["read","plan_write"\]/);
assert.equal(message.details.fingerprint, fingerprintModeState(snapshot));

const officialModel = {
  api: "openai-responses",
  provider: "openai-codex",
  baseUrl: "https://api.openai.com/v1",
};
const payload = {
  model: "gpt-5.6-codex",
  tools: [
    { type: "function", name: "read", description: "read" },
    { type: "function", name: "apply_patch", description: "patch" },
    { type: "function", function: { name: "legacy_shape" } },
    { type: "web_search_preview" },
  ],
  tool_choice: "auto",
};
const originalToolsJson = JSON.stringify(payload.tools);
const limited = rewriteOpenAIResponsesToolChoice(payload, officialModel, ["read", "legacy_shape"]);
assert.notEqual(limited, payload);
assert.equal(limited.tools, payload.tools, "the stable tool catalogue must not be cloned or rewritten");
assert.equal(JSON.stringify(limited.tools), originalToolsJson);
assert.deepEqual(limited.tool_choice, {
  type: "allowed_tools",
  mode: "auto",
  tools: [
    { type: "function", name: "read" },
    { type: "function", name: "legacy_shape" },
  ],
});

const required = rewriteOpenAIResponsesToolChoice(
  { ...payload, tool_choice: "required" },
  officialModel,
  ["read"],
);
assert.equal(required.tool_choice.mode, "required");
assert.equal(
  rewriteOpenAIResponsesToolChoice(payload, officialModel, []).tool_choice,
  "none",
);

const forcedAllowed = {
  ...payload,
  tool_choice: { type: "function", name: "read" },
};
assert.equal(
  rewriteOpenAIResponsesToolChoice(forcedAllowed, officialModel, ["read"]).tool_choice,
  forcedAllowed.tool_choice,
  "an explicitly forced allowed tool must remain forced",
);
assert.equal(
  rewriteOpenAIResponsesToolChoice(forcedAllowed, officialModel, ["apply_patch"]).tool_choice,
  "none",
  "an explicitly forced disallowed tool must fail closed",
);
const explicitNone = { ...payload, tool_choice: "none" };
assert.equal(
  rewriteOpenAIResponsesToolChoice(explicitNone, officialModel, ["read"]).tool_choice,
  "none",
);

const openRouterModel = {
  api: "openai-responses",
  provider: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
};
assert.equal(
  rewriteOpenAIResponsesToolChoice(payload, openRouterModel, ["read"]),
  payload,
  "unknown compatibility layers must keep their payload untouched",
);
assert.equal(
  rewriteOpenAIResponsesToolChoice(payload, { api: "anthropic-messages", provider: "anthropic" }, ["read"]),
  payload,
);

console.log("mode cache policy tests passed");

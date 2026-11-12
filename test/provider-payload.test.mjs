import assert from "node:assert/strict";
import test from "node:test";
import { stream } from "@earendil-works/pi-ai/api/openai-responses";
import { rewriteOpenAIResponsesToolChoice } from "../src/cache-stable-mode.js";

const model = {
  id: "serialization-test", name: "Serialization test", api: "openai-responses",
  provider: "openai", baseUrl: "https://example.invalid/v1", reasoning: false,
  input: ["text"], contextWindow: 128000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  compat: { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true },
};
const tool = (name) => ({ name, description: `${name} a test file`, parameters: { type: "object", properties: {} } });
const initialMessages = [
  { role: "system", content: "Test prompt", toolsAdded: [tool("read"), tool("write")], timestamp: 0 },
  { role: "user", content: "Inspect the project", timestamp: 1 },
];

async function serialize(messages, compat = model.compat) {
  let payload;
  const result = await stream({ ...model, compat }, { messages }, {
    apiKey: "sk-test-only",
    onPayload(value) {
      payload = value;
      // Capture after the real provider serialized the request, before any I/O.
      throw new Error("serialization captured");
    },
    fetch: () => assert.fail("payload tests must never use the network"),
  }).result();
  assert.equal(result.errorMessage, "serialization captured");
  assert.ok(payload);
  return payload;
}

test("restricts Pi's actual additional_tools payload without changing its cached prefix", async () => {
  const payload = await serialize(initialMessages);
  assert.equal(payload.tools, undefined);
  assert.equal(payload.input[0].type, "additional_tools");
  const original = JSON.stringify(payload.input);
  const restricted = rewriteOpenAIResponsesToolChoice(payload, ["read"], model, {});
  assert.deepEqual(restricted.tool_choice, { type: "allowed_tools", mode: "auto", tools: [{ type: "function", name: "read" }] });
  assert.equal(restricted.input, payload.input);
  assert.equal(JSON.stringify(restricted.input), original);

  const extended = await serialize([
    ...initialMessages,
    { role: "system", content: "Plan mode", toolsRemoved: [{ name: "write" }], toolsAdded: [tool("lookup")], timestamp: 2 },
    { role: "user", content: "Continue investigating", timestamp: 3 },
  ]);
  assert.deepEqual(extended.input.slice(0, payload.input.length), payload.input);
  const later = rewriteOpenAIResponsesToolChoice(extended, ["read", "lookup"], model, {});
  assert.deepEqual(later.tool_choice.tools.map((item) => item.name), ["read", "lookup"]);
  assert.equal(later.input, extended.input);
});

test("also handles real top-level tools and intersects existing caller restrictions", async () => {
  const payload = await serialize(initialMessages, { supportsMidConvoSystemMessages: false, supportsAdditionalTools: false });
  assert.ok(Array.isArray(payload.tools));
  const choice = { type: "allowed_tools", mode: "required", tools: [{ type: "function", name: "read" }] };
  const restricted = rewriteOpenAIResponsesToolChoice({ ...payload, tool_choice: choice }, ["read", "write"], model, {});
  assert.equal(restricted.tool_choice, choice);
  assert.equal(restricted.tools, payload.tools);
  const none = rewriteOpenAIResponsesToolChoice({ ...payload, tool_choice: choice }, ["write"], model, {});
  assert.equal(none.tool_choice, "none");
});

import assert from "node:assert/strict";
import {
  __test,
  registerCacheStableModeRuntime,
  rewriteOpenAIResponsesPromptCacheBreakpoint,
} from "../src/cache-stable-mode.js";

const openAIModel = {
  api: "openai-responses",
  provider: "sub2api",
  id: "gpt-5.6-sol",
};

function runtimeState(mode = "normal") {
  return {
    role: "user",
    content: [
      {
        type: "input_text",
        text: `<pi-only-tools-runtime-state>\n{"mode":"${mode}"}\n</pi-only-tools-runtime-state>`,
      },
    ],
  };
}

function breakpointItemIndex(payload) {
  return payload.input.findIndex((item) =>
    [item?.content, item?.output].some(
      (blocks) =>
        Array.isArray(blocks) &&
        blocks.some((block) => block?.prompt_cache_breakpoint?.mode === "explicit"),
    ),
  );
}

function stripBreakpoints(value) {
  if (Array.isArray(value)) return value.map(stripBreakpoints);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "prompt_cache_breakpoint")
      .map(([key, child]) => [key, stripBreakpoints(child)]),
  );
}

const firstTurnBase = {
  model: "gpt-5.6-sol",
  input: [
    { role: "developer", content: [{ type: "input_text", text: "stable policy" }] },
    { role: "user", content: [{ type: "input_text", text: "inspect repository" }] },
    runtimeState("normal"),
  ],
};
const firstTurn = rewriteOpenAIResponsesPromptCacheBreakpoint(
  firstTurnBase,
  openAIModel,
  {},
);
assert.notEqual(firstTurn, firstTurnBase);
assert.equal(breakpointItemIndex(firstTurn), 1);
assert.equal(firstTurn.input[1].content[0].prompt_cache_breakpoint.mode, "explicit");
assert.equal(firstTurn.input[2], firstTurnBase.input[2], "runtime-state suffix must stay untouched");
assert.equal(firstTurnBase.input[1].content[0].prompt_cache_breakpoint, undefined);
assert.equal(
  rewriteOpenAIResponsesPromptCacheBreakpoint(firstTurn, openAIModel, {}),
  firstTurn,
  "the payload rewrite must be idempotent",
);

const toolTurnBase = {
  model: "gpt-5.6-sol",
  input: [
    { role: "developer", content: [{ type: "input_text", text: "stable policy" }] },
    { role: "user", content: [{ type: "input_text", text: "inspect repository" }] },
    { type: "function_call", call_id: "call_1", name: "read", arguments: "{}" },
    { type: "function_call_output", call_id: "call_1", output: "file contents" },
    runtimeState("ask"),
  ],
};
const toolTurn = rewriteOpenAIResponsesPromptCacheBreakpoint(
  toolTurnBase,
  openAIModel,
  {},
);
assert.equal(breakpointItemIndex(toolTurn), 3);
assert.deepEqual(toolTurn.input[3].output, [
  {
    type: "input_text",
    text: "file contents",
    prompt_cache_breakpoint: { mode: "explicit" },
  },
]);
assert.equal(toolTurnBase.input[3].output, "file contents");
assert.deepEqual(
  stripBreakpoints(toolTurn.input.slice(0, 2)),
  stripBreakpoints(firstTurn.input.slice(0, 2)),
  "the first turn's cacheable prefix must remain the next turn's prefix",
);
assert.ok(
  breakpointItemIndex(toolTurn) > breakpointItemIndex(firstTurn),
  "the stable cache boundary must grow through the new tool result",
);

const customToolTurn = rewriteOpenAIResponsesPromptCacheBreakpoint(
  {
    model: "gpt-5.6",
    input: [
      { role: "user", content: [{ type: "input_text", text: "run grammar tool" }] },
      {
        type: "custom_tool_call_output",
        call_id: "custom_1",
        output: [{ type: "input_text", text: "custom result" }],
      },
      runtimeState(),
    ],
  },
  openAIModel,
  {},
);
assert.equal(customToolTurn.input[1].output[0].prompt_cache_breakpoint.mode, "explicit");

const stringUserTurnBase = {
  model: "gpt-5.6",
  input: [{ role: "user", content: "plain text" }, runtimeState()],
};
const stringUserTurn = rewriteOpenAIResponsesPromptCacheBreakpoint(
  stringUserTurnBase,
  openAIModel,
  {},
);
assert.deepEqual(stringUserTurn.input[0].content, [
  {
    type: "input_text",
    text: "plain text",
    prompt_cache_breakpoint: { mode: "explicit" },
  },
]);
assert.equal(stringUserTurnBase.input[0].content, "plain text");

const imageOnlyToolTurn = rewriteOpenAIResponsesPromptCacheBreakpoint(
  {
    model: "gpt-5.6",
    input: [
      { role: "user", content: [{ type: "input_text", text: "inspect image" }] },
      {
        type: "function_call_output",
        call_id: "call_2",
        output: [{ type: "input_image", image_url: "data:image/png;base64,AA==" }],
      },
      runtimeState(),
    ],
  },
  openAIModel,
  {},
);
assert.equal(
  imageOnlyToolTurn.input[0].content[0].prompt_cache_breakpoint.mode,
  "explicit",
  "an unsupported image-only tool result must fall back to the preceding user boundary",
);
assert.equal(imageOnlyToolTurn.input[1].output[0].prompt_cache_breakpoint, undefined);

const oldModelPayload = { ...firstTurnBase, model: "gpt-5.5" };
assert.equal(
  rewriteOpenAIResponsesPromptCacheBreakpoint(
    oldModelPayload,
    { ...openAIModel, id: "gpt-5.5" },
    {},
  ),
  oldModelPayload,
);
assert.equal(
  rewriteOpenAIResponsesPromptCacheBreakpoint(
    firstTurnBase,
    { api: "anthropic-messages", provider: "anthropic", id: "claude" },
    {},
  ),
  firstTurnBase,
);
assert.equal(
  rewriteOpenAIResponsesPromptCacheBreakpoint(firstTurnBase, openAIModel, {
    PI_ONLY_TOOLS_PROMPT_CACHE_BREAKPOINTS: "off",
  }),
  firstTurnBase,
);
const explicitOnlyPayload = {
  ...firstTurnBase,
  prompt_cache_options: { mode: "explicit" },
};
assert.equal(
  rewriteOpenAIResponsesPromptCacheBreakpoint(explicitOnlyPayload, openAIModel, {}),
  explicitOnlyPayload,
  "explicit-only mode may intentionally disable caching and must remain untouched",
);
const noRuntimeStatePayload = {
  model: "gpt-5.6",
  input: firstTurnBase.input.slice(0, 2),
};
assert.equal(
  rewriteOpenAIResponsesPromptCacheBreakpoint(noRuntimeStatePayload, openAIModel, {}),
  noRuntimeStatePayload,
);

const explicitLimitPayload = {
  model: "gpt-5.6",
  input: [
    {
      role: "developer",
      content: [
        {
          type: "input_text",
          text: "first",
          prompt_cache_breakpoint: { mode: "explicit" },
        },
      ],
    },
    {
      role: "developer",
      content: [
        {
          type: "input_text",
          text: "second",
          prompt_cache_breakpoint: { mode: "explicit" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text: "third",
          prompt_cache_breakpoint: { mode: "explicit" },
        },
      ],
    },
    { role: "user", content: "do not add a fourth explicit marker" },
    runtimeState(),
  ],
};
assert.equal(
  rewriteOpenAIResponsesPromptCacheBreakpoint(
    explicitLimitPayload,
    openAIModel,
    {},
  ),
  explicitLimitPayload,
);

assert.equal(__test.supportsExplicitPromptCache("sub2api/gpt-5.6-sol"), true);
assert.equal(__test.supportsExplicitPromptCache("gpt-6"), true);
assert.equal(__test.supportsExplicitPromptCache("gpt-5.5-pro"), false);

const handlers = new Map();
const pi = {
  on(event, handler) {
    const list = handlers.get(event) ?? [];
    list.push(handler);
    handlers.set(event, list);
  },
};
const toolProfiles = {
  mode: "ask",
  apply() {},
  getEffectiveTools() {
    return ["read"];
  },
};
registerCacheStableModeRuntime(pi, { toolProfiles });
const providerHandler = handlers.get("before_provider_request").at(-1);
const integratedBase = {
  ...toolTurnBase,
  tools: [
    { type: "function", name: "shell_command", description: "shell" },
    { type: "function", name: "read", description: "read" },
  ],
};
const integrated = await providerHandler(
  { type: "before_provider_request", payload: integratedBase },
  { model: openAIModel },
);
assert.deepEqual(integrated.tool_choice, {
  type: "allowed_tools",
  mode: "auto",
  tools: [{ type: "function", name: "read" }],
});
assert.equal(integrated.input[3].output[0].prompt_cache_breakpoint.mode, "explicit");
assert.equal(integrated.tools, integratedBase.tools, "tool definitions must remain stable");

console.log("prompt cache breakpoint tests passed");

import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createCodexWebSearchTool } from "../src/codex-web-search.js";
import { normalizeConfig } from "../src/web-search/model.js";

const config = normalizeConfig({
  mode: "live",
  contextSize: "medium",
  allowedDomains: [],
  maxOutputTokens: 8_000,
  timeoutMs: 5_000,
  includeRecentContext: true,
});

const theme = {
  fg: (_color, text) => String(text),
  bold: (text) => String(text),
};

test("posts the Codex request with active model auth and renders compactly", async (t) => {
  let captured;
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      captured = {
        url: request.url,
        authorization: request.headers.authorization,
        accept: request.headers.accept,
        providerHeader: request.headers["x-provider"],
        body: JSON.parse(body),
      };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          encrypted_output: "opaque",
          output: "citeturn0search0 OpenAI result",
          results: [{ type: "text_result", url: "https://openai.com/" }],
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const tool = createCodexWebSearchTool(config);
  assert.ok(tool);
  const args = {
    purpose: "display-only field",
    search_query: [{ q: "OpenAI", domains: ["openai.com"] }],
    image_query: [],
    open: [],
    response_length: "short",
  };
  const result = await tool.execute("call-1", args, undefined, undefined, {
    model: {
      id: "gpt-test",
      provider: "test-provider",
      baseUrl: `http://127.0.0.1:${address.port}/v1///`,
      headers: { "x-model": "model" },
    },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({
        ok: true,
        apiKey: "test-key",
        headers: { "x-provider": "test" },
      }),
    },
    sessionManager: {
      getSessionId: () => "session-1",
      buildContextEntries: () => [
        {
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "Find OpenAI" }],
          },
        },
      ],
    },
  });

  assert.equal(captured.url, "/v1/alpha/search");
  assert.equal(captured.authorization, "Bearer test-key");
  assert.equal(captured.accept, "application/json");
  assert.equal(captured.providerHeader, "test");
  assert.equal(captured.body.id, "session-1");
  assert.equal(captured.body.model, "gpt-test");
  assert.equal(captured.body.settings.external_web_access, true);
  assert.equal("purpose" in captured.body.commands, false);
  assert.equal("image_query" in captured.body.commands, false);
  assert.equal("open" in captured.body.commands, false);
  assert.equal(captured.body.input[0].content[0].text, "Find OpenAI");
  assert.equal(result.content[0].text, "citeturn0search0 OpenAI result");
  assert.equal(result.details.resultCount, 1);

  assert.deepEqual(
    tool
      .renderCall(args, theme, {
        argsComplete: true,
        isPartial: true,
        isError: false,
      })
      .render(100),
    ["Web Search - Search OpenAI [Running]"],
  );
  assert.deepEqual(
    tool
      .renderResult(result, { expanded: false, isPartial: false }, theme, {
        args,
        isError: false,
      })
      .render(100),
    [],
  );
  assert.deepEqual(
    tool
      .renderCall(args, theme, {
        argsComplete: true,
        isPartial: false,
        isError: false,
      })
      .render(100),
    ["Web Search - Search OpenAI [OK]"],
  );

  assert.deepEqual(
    tool
      .renderCall(
        {
          search_query: [],
          image_query: [],
          open: [],
          time: [{ utc_offset: "+00:00" }],
        },
        theme,
        { isPartial: true, isError: false },
      )
      .render(100),
    ["Web Search - Time +00:00 [Running]"],
  );
});

test("surfaces structured provider errors", async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "unsupported command" } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const tool = createCodexWebSearchTool(config);
  await assert.rejects(
    tool.execute("call-2", {}, undefined, undefined, {
      model: {
        id: "gpt-test",
        provider: "test-provider",
        baseUrl: `http://127.0.0.1:${address.port}`,
      },
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({ ok: true }),
      },
      sessionManager: {
        getSessionId: () => "session-1",
        buildContextEntries: () => [],
      },
    }),
    /web search request failed \(400\): unsupported command/,
  );

  const errorResult = {
    isError: true,
    content: [{ type: "text", text: "provider failed\nstack" }],
  };
  assert.deepEqual(
    tool
      .renderResult(
        errorResult,
        { expanded: false, isPartial: false },
        theme,
        { isError: true },
      )
      .render(100),
    ["provider failed"],
  );
});

test("keeps the configured search model and credentials when the chat model changes", async (t) => {
  const requests = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      requests.push({ body: JSON.parse(body), authorization: request.headers.authorization });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ output: "search result" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const selected = {
    id: "search-model",
    provider: "search-provider",
    baseUrl: `http://127.0.0.1:${server.address().port}`,
  };
  const tool = createCodexWebSearchTool(normalizeConfig({
    ...config, provider: selected.provider, model: selected.id,
  }));
  const ctx = {
    model: { id: "chat-a", provider: "chat-provider" },
    modelRegistry: {
      find(provider, model) {
        assert.equal(provider, selected.provider);
        assert.equal(model, selected.id);
        return selected;
      },
      async getApiKeyAndHeaders(model) {
        assert.equal(model, selected);
        return { ok: true, apiKey: "search-only-key" };
      },
    },
    sessionManager: { getSessionId: () => "independent-search", buildContextEntries: () => [] },
  };
  const commands = { search_query: [{ q: "test" }] };
  await tool.execute("search-a", commands, undefined, undefined, ctx);
  ctx.model = { id: "plan-b", provider: "different-provider" };
  await tool.execute("search-b", commands, undefined, undefined, ctx);
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.body.model, "search-model");
    assert.equal(request.authorization, "Bearer search-only-key");
  }
});

test("reports an unknown search model before requesting authentication or HTTP", async () => {
  const tool = createCodexWebSearchTool(normalizeConfig({
    provider: "missing", model: "missing-model",
  }));
  await assert.rejects(tool.execute("missing", {}, undefined, undefined, {
    modelRegistry: {
      find: () => undefined,
      getApiKeyAndHeaders: () => assert.fail("must not resolve unrelated credentials"),
    },
  }), /missing\/missing-model is not registered in Pi/);
});

test("explains an unsupported standalone search endpoint", async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(404, { "content-type": "text/html" });
    response.end("<h1>Not found</h1>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const tool = createCodexWebSearchTool(config);
  await assert.rejects(tool.execute("unsupported", { time: [{ utc_offset: "+00:00" }] }, undefined, undefined, {
    model: { provider: "responses-only", id: "chat", baseUrl: `http://127.0.0.1:${server.address().port}` },
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true }) },
    sessionManager: { getSessionId: () => "unsupported-search", buildContextEntries: () => [] },
  }), /POST \/alpha\/search is unavailable.*responses-only.*404.*web-search\.json/);
});

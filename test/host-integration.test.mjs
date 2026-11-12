import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  initTheme,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  wrapRegisteredTool,
} from "@earendil-works/pi-coding-agent";

initTheme("dark");

async function createHost(t, { profiles, configText, extensionFactories = [] } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-only-tools-host-"));
  const cwd = path.join(directory, "project");
  const agentDir = path.join(directory, "agent");
  await mkdir(cwd);
  await mkdir(agentDir);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let session;
  t.after(async () => {
    if (session) {
      await session.extensionRunner.emit({ type: "session_shutdown" });
      session.dispose();
    }
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(directory, { recursive: true, force: true });
  });
  const configPath = path.join(agentDir, "tools.json");
  if (profiles || configText !== undefined) {
    await writeFile(configPath, configText ?? JSON.stringify({ version: 6, profiles }));
  }
  const settingsManager = SettingsManager.inMemory({});
  const loader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager, extensionFactories,
    additionalExtensionPaths: [fileURLToPath(new URL("../dist/index.js", import.meta.url))],
    noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true,
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, [], "the published entry must load in the real host");
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"), modelsPath: null,
    refreshOnCreate: false, allowModelNetwork: false,
  });
  const model = modelRuntime.getModels().find((item) => item.provider === "openai") ?? modelRuntime.getModels()[0];
  ({ session } = await createAgentSession({
    cwd, agentDir, modelRuntime, model, settingsManager,
    sessionManager: SessionManager.inMemory(cwd), resourceLoader: loader,
  }));
  const runner = session.extensionRunner;
  const errors = [];
  const notifications = [];
  let selection = "Ask";
  await session.bindExtensions({
    mode: "rpc",
    uiContext: {
      ...runner.getUIContext(),
      select: async () => selection,
      confirm: async () => true,
      notify: (message, type) => notifications.push({ message, type }),
    },
    onError: (error) => errors.push(error),
  });
  return {
    session, runner, cwd, agentDir, configPath, errors, notifications,
    tool(name) {
      const registered = runner.getAllRegisteredTools().find((tool) => tool.definition.name === name);
      assert.ok(registered, `${name} must be registered`);
      return wrapRegisteredTool(registered, runner);
    },
    async mode(name) {
      selection = name;
      await runner.getCommand("mode").handler("", runner.createCommandContext());
    },
    beforePrompt: () => runner.emitBeforeAgentStart({ messageType: "user", prompt: "host regression" }, { cwd }),
    nestedContext(id) {
      // Nested execution requires an originating assistant message. Seed that
      // fixture through the public session API, then use the real call pipeline.
      session.sessionManager.appendMessage({
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: [{ type: "toolCall", id, name: "codemode", arguments: { code: "/* host regression */" } }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "toolUse", timestamp: Date.now(),
      });
      session.refreshContext();
      return runner.createToolContext(id);
    },
  };
}

const plan = "# Host compatibility\n\n## Context\nKeep tools working on the current Pi release.\n\n## Current State\nThe real host loads the extension.\n\n## Implementation Steps\n1. **Update src/entry.js**\n   - Reuse existing tool registration and preserve the command workflow.\n\n## Verification\n- Run npm test and verify shell output.\n";

test("real host loads the entry and executes shell, Ask, and Plan with structured prompt sections", async (t) => {
  const host = await createHost(t);
  const shell = await host.tool("shell_command").execute("host-shell", { command: "echo host-ok", timeout_ms: 2000 });
  assert.equal(shell.isError, false);
  assert.match(shell.content[0].text, /host-ok/);
  const before = await host.beforePrompt();
  assert.equal(before.systemPromptOptions.forceSystemPrompt, undefined);
  assert.ok(Object.values(before.systemPromptOptions.sections).some((text) => String(text).includes("Normal")));

  await host.mode("Ask");
  const context = host.nestedContext("host-parent");
  const denied = await context.executeTool("shell_command", { command: "echo must-not-run" });
  assert.equal(denied.isError, true);
  assert.match(denied.result.content[0].text, /blocks shell_command|Tool shell_command not found/);
  await writeFile(path.join(host.cwd, "read.txt"), "read-only-ok");
  const read = await context.executeTool("read", { path: "read.txt" });
  assert.equal(read.isError, false);
  assert.match(read.result.content[0].text, /read-only-ok/);

  await host.mode("Plan");
  const saved = await host.tool("plan_write").execute("host-plan", { content: plan });
  assert.equal(saved.details.readiness.ready, true);
  assert.equal(saved.terminate, true);
  assert.equal(await readFile(saved.details.plan.path, "utf8"), plan);
  await host.runner.getCommand("plan-approve").handler("stay", host.runner.createCommandContext());
  await host.runner.getCommand("plan").handler("off", host.runner.createCommandContext());
  assert.ok(host.session.getActiveToolNames().includes("shell_command"));
  assert.deepEqual(host.errors, []);
});

test("real host keeps discovery tools opt-in and allows authorized late deferred calls", async (t) => {
  let api;
  const host = await createHost(t, {
    profiles: { normal: ["read", "mcp__late__lookup", "mcp__hidden__lookup"], ask: ["read"], plan: ["read"] },
    extensionFactories: [createCodemodeExtension({ models: false }), createToolSearchExtension(), (pi) => { api = pi; }],
  });
  for (const name of ["codemode", "tool_search"]) {
    assert.equal(host.session.getToolDefinition(name).defaultActive, false);
    assert.equal(host.session.getActiveToolNames().includes(name), false);
  }
  let forbiddenCalls = 0;
  const definition = {
    label: "Late lookup", description: "Read a late resource",
    parameters: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    execute: async () => ({ content: [{ type: "text", text: "late-tool-ok" }], details: {} }),
  };
  api.registerTool({ ...definition, name: "mcp__late__lookup", exposure: "deferred" });
  api.registerTool({ ...definition, name: "mcp__hidden__lookup", exposure: "hidden", execute: async () => { forbiddenCalls++; } });
  api.registerTool({ ...definition, name: "mcp__unapproved__lookup", exposure: "deferred", execute: async () => { forbiddenCalls++; } });
  await host.beforePrompt();
  assert.equal(host.session.getActiveToolNames().includes("mcp__late__lookup"), false, "authorization must not eagerly declare deferred tools");
  const context = host.nestedContext("host-nested");
  const allowed = await context.executeTool("mcp__late__lookup", {});
  assert.equal(allowed.isError, false);
  assert.match(allowed.result.content[0].text, /late-tool-ok/);
  assert.equal((await context.executeTool("mcp__unapproved__lookup", {})).isError, true);
  assert.equal((await context.executeTool("mcp__hidden__lookup", {})).isError, true);
  assert.equal(forbiddenCalls, 0);
  api.setActiveTools([...api.getActiveTools(), "mcp__late__lookup"]);
  await host.beforePrompt();
  assert.equal(host.session.getActiveToolNames().includes("mcp__late__lookup"), true, "an authorized deferred tool promoted by discovery remains available");
  assert.deepEqual(host.errors, []);
});

test("a malformed config preserves last valid permissions and never overwrites its bytes", async (t) => {
  const host = await createHost(t, { profiles: { normal: ["read"], ask: ["read"], plan: ["read"] } });
  const broken = '{"version":6,"profiles":{"normal":[],}';
  await writeFile(host.configPath, broken);
  await host.runner.emit({ type: "session_tree" });
  assert.equal(await readFile(host.configPath, "utf8"), broken);
  const context = host.nestedContext("config-parent");
  await writeFile(path.join(host.cwd, "safe.txt"), "safe");
  assert.equal((await context.executeTool("read", { path: "safe.txt" })).isError, false);
  assert.equal((await context.executeTool("shell_command", { command: "echo no" })).isError, true);
  assert.deepEqual(host.errors, []);
});

test("a fresh session with a newer config fails closed even after a mode change", async (t) => {
  const configText = JSON.stringify({ version: 999, profiles: { normal: [], ask: [], plan: [] } });
  const host = await createHost(t, { configText });
  assert.deepEqual(host.session.getActiveToolNames(), []);
  await host.mode("Plan");
  assert.deepEqual(host.session.getActiveToolNames(), []);
  const denied = await host.runner.emitToolCall({ type: "tool_call", toolName: "plan_write", toolCallId: "blocked-config", input: { content: plan } });
  assert.equal(denied.block, true);
  assert.equal(await readFile(host.configPath, "utf8"), configText);
  assert.deepEqual(host.errors, []);
});

// A tiny in-memory server exercises Pi's real MCP client, initialization, discovery,
// registration, and call pipeline without a network service or credentials.
function mcpTransport(connected) {
  const listeners = { message: new Set(), error: new Set(), close: new Set() };
  const subscribe = (kind) => (listener) => {
    listeners[kind].add(listener);
    return () => listeners[kind].delete(listener);
  };
  return {
    onMessage: subscribe("message"), onError: subscribe("error"), onClose: subscribe("close"),
    start: async () => connected,
    async close() { for (const listener of listeners.close) listener(); },
    async send(message) {
      if (message.id === undefined) return;
      let result;
      if (message.method === "initialize") {
        result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "test-server", version: "1" } };
      } else if (message.method === "tools/list") {
        result = { tools: [{ name: "lookup", description: "Read test data", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }] };
      } else if (message.method === "tools/call") {
        result = { content: [{ type: "text", text: "native-mcp-ok" }] };
      } else if (message.method === "ping") {
        result = {};
      } else {
        throw new Error(`Unexpected MCP method: ${message.method}`);
      }
      queueMicrotask(() => {
        for (const listener of listeners.message) listener({ jsonrpc: "2.0", id: message.id, result });
      });
    },
  };
}

test("native MCP tools discovered after session_start can run when already authorized", async (t) => {
  let connect;
  const connected = new Promise((resolve) => { connect = resolve; });
  const host = await createHost(t, {
    profiles: { normal: ["read", "mcp__test__lookup"], ask: ["read"], plan: ["read"] },
    extensionFactories: [createMcpExtension({
      loadConfig: () => ({ servers: [{ name: "test", config: { command: "unused", exposure: "direct" }, source: "test", scope: "extension" }], errors: [], autoEnableCodemode: false }),
      createTransport: () => mcpTransport(connected),
      startupWaitMs: 5000,
    })],
  });
  assert.equal(host.session.getAllTools().some((tool) => tool.name === "mcp__test__lookup"), false);
  connect();
  await host.beforePrompt();
  assert.equal(host.session.getAllTools().some((tool) => tool.name === "mcp__test__lookup"), true);
  const result = await host.nestedContext("mcp-parent").executeTool("mcp__test__lookup", {});
  assert.equal(result.isError, false);
  assert.match(result.result.content[0].text, /native-mcp-ok/);
  assert.deepEqual(host.errors, []);
});

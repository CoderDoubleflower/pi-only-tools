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

function equalToolLists(left, right) {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

export class ToolProfileController {
  constructor(pi, options = {}) {
    this.pi = pi;
    this.mode = "normal";
    this.configurationBlocked = false;
    // Extension action methods are unavailable while extensions are being loaded.
    // Read the live registry only when a profile is applied or inspected.
    const initial = uniqueToolNames(options.initialTools ?? []);
    this.profiles = new Map([
      ["normal", initial],
      ["ask", []],
      ["plan", []],
    ]);
  }

  assertProfile(profile) {
    if (!this.profiles.has(profile)) throw new Error(`Unknown tool profile: ${profile}`);
  }

  setConfigurationBlocked(blocked) {
    this.configurationBlocked = blocked === true;
    this.apply();
  }

  setProfile(profile, names, options = {}) {
    this.assertProfile(profile);
    this.profiles.set(profile, uniqueToolNames(names));
    if (options.activate === true) this.mode = profile;
    if (options.apply === false || (options.activate !== true && this.mode !== profile)) {
      return this.getEffectiveTools(profile);
    }
    this.apply();
    return this.getEffectiveTools(profile);
  }

  activate(profile, names) {
    this.assertProfile(profile);
    if (names !== undefined) this.profiles.set(profile, uniqueToolNames(names));
    this.mode = profile;
    this.apply();
    return this.getEffectiveTools(profile);
  }

  getRequestedTools(profile = this.mode) {
    this.assertProfile(profile);
    return [...(this.profiles.get(profile) ?? [])];
  }

  getRegisteredTools() {
    return [...this.getRegisteredToolDefinitions().keys()];
  }

  getRegisteredToolDefinitions() {
    const definitions = new Map();
    for (const tool of this.pi.getAllTools?.() ?? []) {
      if (typeof tool?.name !== "string" || !tool.name.trim()) continue;
      definitions.set(tool.name, tool);
    }
    return definitions;
  }

  getRegisteredToolNames() {
    return new Set(this.getRegisteredTools());
  }

  getCatalogToolNames() {
    return new Set(this.getCatalogTools());
  }

  getUnavailableTools(names) {
    const registered = this.getRegisteredToolDefinitions();
    return uniqueToolNames(names).flatMap((name) => {
      if (!registered.has(name)) return [{ name, reason: "not registered" }];
      if (registered.get(name).exposure === "hidden") {
        return [{ name, reason: "hidden by its provider" }];
      }
      return [];
    });
  }

  getEffectiveTools(profile = this.mode) {
    this.assertProfile(profile);
    if (this.configurationBlocked) return [];
    const registered = this.getRegisteredToolDefinitions();
    return this.getRequestedTools(profile).filter(
      (name) => registered.has(name) && registered.get(name).exposure !== "hidden",
    );
  }

  getDesiredCatalogTools() {
    const allowed = new Set(this.getEffectiveTools());
    const registered = this.getRegisteredToolDefinitions();
    const active = uniqueToolNames(this.pi.getActiveTools?.() ?? []);
    const activeSet = new Set(active);
    // Authorization and model exposure are different sets. Deferred/codemode
    // tools can be called through ctx.executeTool without being declared. Keep
    // an authorized declaration that tool_search (or another loader) activated,
    // but do not promote every registered tool into the model's loadout.
    const visible = (name) => {
      if (!allowed.has(name)) return false;
      const exposure = registered.get(name)?.exposure ?? "direct";
      return exposure === "direct" || exposure === "model-only" ||
        ((exposure === "codemode" || exposure === "deferred") && activeSet.has(name));
    };
    // Pi also preserves retained order. Matching it avoids repeated setter calls
    // when a late tool is appended or a profile's saved names are reordered.
    return uniqueToolNames([...active, ...registered.keys()]).filter(visible);
  }

  // Pi records model-visible tool changes as transcript deltas. Never freeze
  // authorization to a startup snapshot: native MCP registers asynchronously.
  refreshCatalog() {
    return this.getDesiredCatalogTools();
  }

  getCatalogTools() {
    return this.refreshCatalog();
  }

  isAllowed(toolName, profile = this.mode) {
    return this.getEffectiveTools(profile).includes(toolName);
  }

  apply() {
    const catalog = this.refreshCatalog();
    const current = uniqueToolNames(this.pi.getActiveTools?.() ?? []);
    if (!equalToolLists(current, catalog)) this.pi.setActiveTools(catalog);
    return this.getEffectiveTools();
  }

  snapshot() {
    return {
      mode: this.mode,
      configurationBlocked: this.configurationBlocked,
      requested: {
        normal: this.getRequestedTools("normal"),
        ask: this.getRequestedTools("ask"),
        plan: this.getRequestedTools("plan"),
      },
      effective: {
        normal: this.getEffectiveTools("normal"),
        ask: this.getEffectiveTools("ask"),
        plan: this.getEffectiveTools("plan"),
      },
      allowedTools: this.getEffectiveTools(),
      catalogTools: this.getCatalogTools(),
      activeTools: uniqueToolNames(this.pi.getActiveTools?.() ?? []),
    };
  }
}

export function createToolProfileController(pi, options) {
  return new ToolProfileController(pi, options);
}

export const __test = {
  equalToolLists,
  uniqueToolNames,
};

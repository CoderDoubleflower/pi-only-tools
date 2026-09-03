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
    this.requiredTools = uniqueToolNames(options.requiredTools ?? []);
    this.catalog = [];
    this.catalogInitialized = false;
    // Extension action methods are unavailable while extensions are being loaded.
    // The complete session catalog is frozen from runtime state at session_start.
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
    return uniqueToolNames(
      (this.pi.getAllTools?.() ?? [])
        .map((tool) => tool?.name)
        .filter((name) => typeof name === "string" && name.length > 0),
    );
  }

  getRegisteredToolNames() {
    return new Set(this.getRegisteredTools());
  }

  getCatalogToolNames() {
    return new Set(this.catalogInitialized ? this.catalog : this.getRegisteredTools());
  }

  getUnavailableTools(names) {
    const registered = this.getRegisteredToolNames();
    const catalog = this.getCatalogToolNames();
    return uniqueToolNames(names).flatMap((name) => {
      if (!registered.has(name)) return [{ name, reason: "not registered" }];
      if (this.catalogInitialized && !catalog.has(name)) {
        return [{ name, reason: "not in the frozen session catalog; reload or start a new session" }];
      }
      return [];
    });
  }

  getEffectiveTools(profile = this.mode) {
    const registered = this.getRegisteredToolNames();
    const catalog = this.getCatalogToolNames();
    return this.getRequestedTools(profile).filter(
      (name) => registered.has(name) && catalog.has(name),
    );
  }

  getDesiredCatalogTools() {
    const desired = new Set(this.requiredTools);
    for (const profile of this.profiles.keys()) {
      for (const name of this.getRequestedTools(profile)) desired.add(name);
    }
    return this.getRegisteredTools().filter((name) => desired.has(name));
  }

  // The provider-visible catalog is one ordered snapshot of every tool
  // registered at the session boundary. Mode/profile changes only alter the
  // runtime allowlist; they never add, remove, or reorder tool definitions.
  refreshCatalog() {
    if (!this.catalogInitialized) {
      this.catalog = this.getRegisteredTools();
      this.catalogInitialized = true;
    }
    return [...this.catalog];
  }

  resetCatalog() {
    this.catalog = [];
    this.catalogInitialized = false;
  }

  getCatalogTools() {
    return this.catalogInitialized ? [...this.catalog] : this.refreshCatalog();
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

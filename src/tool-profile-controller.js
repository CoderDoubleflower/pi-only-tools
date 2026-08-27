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
    // The normal profile is initialized from runtime state during session_start instead.
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

  getUnavailableTools(names) {
    const registered = this.getRegisteredToolNames();
    return uniqueToolNames(names).flatMap((name) =>
      registered.has(name) ? [] : [{ name, reason: "not registered" }],
    );
  }

  getEffectiveTools(profile = this.mode) {
    const registered = this.getRegisteredToolNames();
    return this.getRequestedTools(profile).filter((name) => registered.has(name));
  }

  getDesiredCatalogTools() {
    const desired = new Set(this.requiredTools);
    for (const profile of this.profiles.keys()) {
      for (const name of this.getRequestedTools(profile)) desired.add(name);
    }
    return this.getRegisteredTools().filter((name) => desired.has(name));
  }

  refreshCatalog() {
    const registered = new Set(this.getRegisteredTools());
    const desired = this.getDesiredCatalogTools();

    if (!this.catalogInitialized) {
      this.catalog = desired;
      this.catalogInitialized = true;
      return [...this.catalog];
    }

    // Keep the catalog monotonic within one extension/session lifetime. Removing a
    // tool from a profile only changes the runtime allowlist; it must not rewrite
    // the provider-visible tool prefix. Newly selected tools append in registry
    // order so the existing prefix remains reusable.
    this.catalog = this.catalog.filter((name) => registered.has(name));
    const current = new Set(this.catalog);
    for (const name of desired) {
      if (current.has(name)) continue;
      current.add(name);
      this.catalog.push(name);
    }
    return [...this.catalog];
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

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
    // Runtime action methods are unavailable while extensions are loading. The
    // catalogue is synchronized after session_start, once all tools exist.
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
    if (options.apply !== false) this.syncCatalog();
    return this.getEffectiveTools(profile);
  }

  activate(profile, names) {
    this.assertProfile(profile);
    if (names !== undefined) this.profiles.set(profile, uniqueToolNames(names));
    this.mode = profile;
    this.syncCatalog();
    return this.getEffectiveTools(profile);
  }

  getRequestedTools(profile = this.mode) {
    this.assertProfile(profile);
    return [...(this.profiles.get(profile) ?? [])];
  }

  getRegisteredToolOrder() {
    return uniqueToolNames(
      (this.pi.getAllTools?.() ?? [])
        .map((tool) => tool?.name)
        .filter((name) => typeof name === "string" && name.length > 0),
    );
  }

  getRegisteredToolNames() {
    return new Set(this.getRegisteredToolOrder());
  }

  getUnavailableTools(names) {
    const registered = this.getRegisteredToolNames();
    return uniqueToolNames(names).flatMap((name) =>
      registered.has(name) ? [] : [{ name, reason: "not registered" }],
    );
  }

  getEffectiveTools(profile = this.mode) {
    const unavailable = new Set(this.getUnavailableTools(this.getRequestedTools(profile)).map((entry) => entry.name));
    return this.getRequestedTools(profile).filter((name) => !unavailable.has(name));
  }

  getAllowedTools(profile = this.mode) {
    return this.getEffectiveTools(profile);
  }

  getCatalogTools() {
    const requested = new Set();
    for (const profile of this.profiles.keys()) {
      for (const name of this.getEffectiveTools(profile)) requested.add(name);
    }
    return this.getRegisteredToolOrder().filter((name) => requested.has(name));
  }

  syncCatalog() {
    const catalog = this.getCatalogTools();
    const current = uniqueToolNames(this.pi.getActiveTools?.() ?? []);
    if (!equalToolLists(current, catalog)) this.pi.setActiveTools?.(catalog);
    return catalog;
  }

  // Backward-compatible name used by existing integration points. Applying a
  // profile now synchronizes the stable union catalogue instead of swapping to
  // the current profile's subset.
  apply() {
    return this.syncCatalog();
  }

  snapshot() {
    const catalogTools = this.getCatalogTools();
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
      catalogTools,
      activeTools: uniqueToolNames(this.pi.getActiveTools?.() ?? catalogTools),
    };
  }
}

export function createToolProfileController(pi, options) {
  return new ToolProfileController(pi, options);
}

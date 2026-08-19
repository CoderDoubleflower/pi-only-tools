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
    this.protectedTools = new Set(uniqueToolNames(options.protectedTools));
    const initial = uniqueToolNames(pi.getActiveTools?.() ?? []);
    this.profiles = new Map([
      ["normal", initial],
      ["plan", []],
      ["execution", []],
    ]);
    this.permanentlyDisabled = new Set();
  }

  assertProfile(profile) {
    if (!this.profiles.has(profile)) throw new Error(`Unknown tool profile: ${profile}`);
  }

  setPermanentDisabled(names, options = {}) {
    this.permanentlyDisabled = new Set(uniqueToolNames(names));
    return options.apply === false ? this.getEffectiveTools() : this.apply();
  }

  setProfile(profile, names, options = {}) {
    this.assertProfile(profile);
    this.profiles.set(profile, uniqueToolNames(names));
    if (options.activate === true) this.mode = profile;
    if (options.apply === false || (options.activate !== true && this.mode !== profile)) {
      return this.getEffectiveTools(profile);
    }
    return this.apply();
  }

  activate(profile, names) {
    this.assertProfile(profile);
    if (names !== undefined) this.profiles.set(profile, uniqueToolNames(names));
    this.mode = profile;
    return this.apply();
  }

  getRequestedTools(profile = this.mode) {
    this.assertProfile(profile);
    return [...(this.profiles.get(profile) ?? [])];
  }

  getRegisteredToolNames() {
    return new Set(
      (this.pi.getAllTools?.() ?? [])
        .map((tool) => tool?.name)
        .filter((name) => typeof name === "string" && name.length > 0),
    );
  }

  isPermanentlyDisabled(name) {
    return this.permanentlyDisabled.has(name) && !this.protectedTools.has(name);
  }

  getUnavailableTools(names) {
    const registered = this.getRegisteredToolNames();
    return uniqueToolNames(names).flatMap((name) => {
      if (!registered.has(name)) return [{ name, reason: "not registered" }];
      if (this.isPermanentlyDisabled(name)) return [{ name, reason: "permanently disabled" }];
      return [];
    });
  }

  getEffectiveTools(profile = this.mode) {
    const unavailable = new Set(this.getUnavailableTools(this.getRequestedTools(profile)).map((entry) => entry.name));
    return this.getRequestedTools(profile).filter((name) => !unavailable.has(name));
  }

  apply() {
    const effective = this.getEffectiveTools();
    const current = uniqueToolNames(this.pi.getActiveTools?.() ?? []);
    if (!equalToolLists(current, effective)) this.pi.setActiveTools(effective);
    return effective;
  }

  snapshot() {
    return {
      mode: this.mode,
      requested: {
        normal: this.getRequestedTools("normal"),
        plan: this.getRequestedTools("plan"),
        execution: this.getRequestedTools("execution"),
      },
      effective: {
        normal: this.getEffectiveTools("normal"),
        plan: this.getEffectiveTools("plan"),
        execution: this.getEffectiveTools("execution"),
      },
      permanentlyDisabledTools: [...this.permanentlyDisabled].sort((a, b) => a.localeCompare(b, "en")),
      activeTools: this.getEffectiveTools(),
    };
  }
}

export function createToolProfileController(pi, options) {
  return new ToolProfileController(pi, options);
}

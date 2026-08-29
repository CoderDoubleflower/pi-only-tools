export const DELEGATED_TOOL_RENDERERS = Object.freeze([
  "shell_command",
  "apply_patch",
]);

const DELEGATED_TOOL_RENDERER_SET = new Set(DELEGATED_TOOL_RENDERERS);

/**
 * Keep pi-only-tools responsible for tool schemas and execution only.
 *
 * The active TUI owns presentation for shell_command/apply_patch. In the
 * user's normal setup, pi-open-tui recognizes both names and applies its
 * shared Claude-style renderer. Without pi-open-tui, Pi falls back to its
 * normal tool shell instead of receiving a second competing renderer here.
 */
export function stripDelegatedToolRendering(tool) {
  if (!tool || !DELEGATED_TOOL_RENDERER_SET.has(tool.name)) return tool;

  const {
    renderCall: _renderCall,
    renderResult: _renderResult,
    renderShell: _renderShell,
    ...definition
  } = tool;
  return definition;
}

export function createToolRendererDelegationApi(pi) {
  if (!pi || typeof pi.registerTool !== "function") return pi;

  const registerTool = pi.registerTool.bind(pi);
  return new Proxy(pi, {
    get(target, property) {
      if (property === "registerTool") {
        return (tool) => registerTool(stripDelegatedToolRendering(tool));
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export const __test = {
  createToolRendererDelegationApi,
  stripDelegatedToolRendering,
};

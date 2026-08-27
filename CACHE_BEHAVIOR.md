# Prompt-cache behavior

`pi-only-tools` keeps one model-facing tool catalogue stable across Normal, Ask, and Plan mode changes.

## Stable catalogue

The catalogue is the deterministic union of the effective Normal, Ask, and Plan profiles, ordered by Pi's registered-tool order. Switching mode changes only the active permission profile; it does not remove, re-add, or reorder provider tool definitions.

Editing `/only-tools`, loading a different configuration, registering new tools, or reloading extensions may intentionally rebuild the catalogue. Those are configuration changes rather than ordinary mode changes and may start a new prompt-cache prefix.

## Runtime permissions

Tool visibility is not authorization. Every call is checked against the current runtime state:

- Normal uses the Normal profile.
- Ask uses the read-only Ask profile.
- Plan planning uses the Plan profile plus required Plan tools.
- Plan Ready allows no model-initiated tools.
- Approved-plan execution uses the Normal profile.

The runtime gate remains authoritative for providers that cannot express an allowed-tool subset.

## OpenAI Responses

For `openai` and `openai-codex` models using `openai-responses`, the extension preserves the complete `tools` array and sets only `tool_choice`:

- an `allowed_tools` object for a non-empty mode allowlist;
- `"none"` when the current state permits no tools.

Other providers and payload formats are left unchanged and remain protected by the runtime gate.

## Mode context

A single static mode protocol is appended to the system prompt in every mode. Dynamic values such as:

- selected mode and stage;
- allowed tool names;
- canonical plan path;
- plan revision and SHA-256;
- approved revision and SHA-256;

are placed in a hidden `pi-only-tools-mode-context` message. The message is emitted only when its fingerprint changes and is re-emitted after session start, tree navigation, or compaction. This keeps dynamic state at the end of the reusable prompt prefix instead of changing the system prompt.

## Remaining cache boundaries

The following still create separate cache domains or prefixes by design:

- changing provider or model between Normal and Plan profiles;
- changing thinking/model configuration where the provider treats it as a separate request shape;
- editing profile membership so the stable union catalogue changes;
- registering, removing, or changing a tool description or parameter schema;
- reloading extensions that alter the base system prompt.

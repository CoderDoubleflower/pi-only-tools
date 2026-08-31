# Changelog

## Unreleased

- Add a Codex-compatible standalone `web_search` tool with batched search/navigation commands, current-model authentication, bounded recent context, structured response metadata, and regression coverage.
- Allow the native `bash` tool in Ask and Plan by default so enabled Skills can run their required inspection commands; keep `shell_command`, `apply_patch`, PowerShell, edit/write, and workflow-control tools blocked in Ask.
- Strengthen the stable and legacy Ask/Plan prompts so every Bash command must remain non-mutating and must not create, edit, move, rename, or delete files, alter Git/config/dependencies, redirect output to files, or bypass blocked write tools.
- Upgrade profile configuration to version 6, adding `web_search` to legacy profiles and adding `bash` once to Ask/Plan while preserving later user removals.
- Remove `renderCall`, `renderResult`, and `renderShell: "self"` from the production `shell_command` and `apply_patch` definitions so the active TUI owns their presentation; `pi-open-tui` can now apply its shared OpenAI-style renderer without competing tool-local framing.
- Keep the specialized `EnterPlanMode` and `plan_write` renderers unchanged because they own Plan-specific streaming and Markdown presentation rather than generic shell/patch chrome.
- Keep one provider-visible tool catalog for the extension/session lifetime; Normal, Ask, and Plan now change runtime allowlists instead of replacing the `tools` array.
- Preserve catalog prefix order across mode switches and permission removals; newly enabled registered tools append in Pi registry order and the catalog is rebuilt only after reload/session replacement.
- Replace mode-specific dynamic system-prompt rewrites with one fixed natural-language mode policy plus an ephemeral `context` runtime-state message that is not persisted to the session tree.
- Remove the model-visible `[PI-ONLY-TOOLS MODE PROTOCOL v1]` heading and keep idempotent injection through a natural opening sentence.
- Enforce the active allowlist fail-closed in every mode, including Normal and Plan-ready, while keeping the existing Ask/Plan checks as defense in depth.
- Constrain every `api=openai-responses` request with `tool_choice.allowed_tools` or `none` without provider-name filtering or rewriting `tools`; retain `PI_ONLY_TOOLS_ALLOWED_TOOLS=off` for incompatible gateways.
- Add cache-stability tests covering catalog monotonicity, runtime-state replacement, provider payload rewriting, and the Normal/Ask/Plan workflow.
- Keep Ask and Plan footer statuses in the same leading plugin-status slot by using distinct keys with one shared fixed sort prefix.
- Add a persistent Ask tool profile beside Normal and Plan in `/only-tools`; Ask model and effort inherit Normal.
- Add one `/mode` selector for Normal, Ask, and Plan, and remove the separate `/ask` command family.
- Keep Shift+Tab as one global mode cycle: Normal → Ask → Plan → Normal, while preserving the idle-only switching guard.
- Make the Ask column an explicit user-maintained allowlist for read-only third-party/MCP tools while locking known write, alternate-shell, patch, and Plan-control tools off.
- Enforce Ask permissions through the shared runtime allowlist gate and retain the Ask-specific `tool_call` check as defense in depth.
- Move Ask read-only behavior into the fixed natural-language mode policy; the ephemeral runtime-state message carries the active mode and allowed tool names.
- Stream the growing `plan_write.content` Markdown in the TUI while tool arguments are generated, without writing partial content to the canonical plan file.
- Make visible plan titles, headings, step labels, and prose follow the user's language; validate localized plans by semantic H2 order while preserving legacy English plans.
- Fix automatic Plan review dispatch so `agent_settled` routes through Pi's command pipeline and receives a command-capable context instead of calling `/plan-approve` with an event context.
- Make a valid `plan_write` publish the exact revision directly to user review and terminate the planning turn.
- Remove the model-facing `ExitPlanMode` tool; only an explicit user review action can enter execution.
- Render `EnterPlanMode` and `plan_write` with Claude-style tool framing and Pi Markdown instead of one muted text block.
- Keep approved-plan handoff messages hidden from the transcript so a revision is displayed only once.
- Strengthen the planning prompt and canonical template with verified current state, concrete implementation flow, compatibility risks, and repository-supported verification.

## 0.5.3

- Fix Profile matrix column drift when the selected cell contains ANSI styling by padding plain text before applying color/bold.
- Highlight the selected profile header, row label, and cell with the accent color while preserving fixed visual column widths.
- Add an ANSI-aware regression test that locks Normal/Plan tool-column alignment.

## 0.5.2

- Use Shift+Tab as the global Normal/Plan toggle in TUI mode.
- Consume Shift+Tab before Pi's built-in thinking-cycle binding; Effort remains configurable from `/only-tools`.
- Simplify `/only-tools` spacing and footer text, and replace `[✓]` / `[×]` with larger `●` / `○` state glyphs.
- Use `◆` / `◇` for locked Plan-control cells and keep `?` for currently unavailable tools.

## 0.5.1

- Transpose `/only-tools` so Normal/Plan are columns and Model/Effort/tools are rows.
- Make Enter edit Model/Effort or toggle a tool cell, with arrows matching the visible row/column axes.
- Use clear `[✓]` / `[×]` tool states, keep locked/unregistered markers, and vertically scroll long tool lists.
- Preserve the selected matrix cell across model/effort pickers and avoid dirty saves when a picker is cancelled.

## 0.5.0

- Replace session/permanent tool states with one persistent profile × tool allowlist matrix.
- Configure Normal and Plan tool access side-by-side in one TUI; approved plans execute with Normal.
- Configure Normal/Plan model and thinking settings in the same matrix screen; legacy execution settings migrate to Normal.
- Migrate legacy permanentlyDisabledTools into profile omissions and stop applying a global denylist at runtime.
- Remove the separate Execution profile; Plan approval returns directly to Normal for implementation.

## 0.4.2

- Make bare `/only-tools` open the top-level Tool profiles menu.
- Surface Plan Mode configuration directly from the default `/only-tools` UI.
- Keep the legacy session tool editor available under Session tools and `/only-tools session`.
- Add a regression test locking the top-level menu contents.

## 0.4.1

- Defer all ExtensionAPI runtime action calls until Pi has initialized the session runtime.
- Initialize the normal tool profile during session_start instead of extension registration.
- Remove the registration-time tool-registry probe; standalone Plan Mode should be uninstalled before using the integrated runtime.
- Add a regression test that makes runtime action methods throw during extension loading.

## 0.4.0

- Merge Claude-style Plan Mode into pi-only-tools.
- Add unified normal, Plan, and execution tool profiles with one ToolProfileController.
- Add /only-tools plan, /only-tools profiles, and effective-profile diagnostics.
- Preserve legacy claude-plan-mode.json configuration and Plan session state.
- Apply permanent disables consistently without allowing pi-only-tools to overwrite Plan tools.
- Report requested, effective, unregistered, and permanently disabled Plan tools.

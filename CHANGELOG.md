# Changelog

## 0.6.0 (unreleased)

### Pi 1.5 compatibility and reliability

- Pin the development and integration-test baseline to Pi 1.5.2 and use host-provided peer dependencies. Test Node.js 22.19.0 and 24, with an additional latest-Pi job and weekly compatibility checks.
- Compute permissions from the live tool registry so authorized native MCP tools can register after session startup. Preserve requested names until the tools become available.
- Respect direct, model-only, deferred, codemode, and hidden tool exposure. Keep discovery tools opt-in, and update the active model loadout to the current profile instead of retaining a frozen union of tools.
- Add the shared mode policy through Pi's structured system-prompt sections. Preserve the host's incremental system/tool context and avoid forcing full system-prompt replacement.
- Support Responses tools declared in `input.additional_tools` and discovery outputs as well as top-level `tools`; intersect existing caller restrictions without changing tool declarations or cached input history.
- Preserve malformed and unknown-version tool configuration files. Keep the last valid permissions in an existing session, disable tools when a fresh session has no valid configuration, and require an explicit backup before resetting a damaged file.
- Wait for idle before slash-command mode changes while keeping model-initiated Plan transitions free of self-waits.
- Move plan persistence, publication, revision checks, and review dispatch into the Plan runtime. Keep the rendering module limited to presentation and remove the hidden legacy tool/proxy path.
- Share process lifecycle handling between shell and patch execution. Escalate Unix process-group termination even when the shell leader has exited, clean up inherited pipes, and cover immediate aborts.
- Capture bounded head and tail buffers for each output stream, preserving the actual end of long output, UTF-8 boundaries, original byte/line counts, and short output. Apply one combined model-output budget.
- Mark failed shell and patch results with `isError`, including timeouts, aborts, signals, spawn failures, and unknown exit status.
- Allow a dedicated, registered search `provider` / `model` pair with credentials resolved by Pi; provide clear diagnostics for missing models and unavailable search endpoints.
- Discover all test files automatically and add real-host loading, mode/profile enforcement, delayed native MCP registration, real Responses serialization, and process-lifecycle regression tests.

### Included workflow updates

- Add a Codex-compatible standalone `web_search` tool with batched search/navigation commands, current-model authentication, bounded recent context, structured response metadata, and regression coverage.
- Allow the native `bash` tool in Ask and Plan by default so enabled Skills can run their required inspection commands; keep `shell_command`, `apply_patch`, PowerShell, edit/write, and workflow-control tools blocked in Ask.
- Strengthen Ask/Plan prompts so every Bash command must remain non-mutating and must not create, edit, move, rename, or delete files, alter Git/config/dependencies, redirect output to files, or bypass blocked write tools.
- Upgrade profile configuration to version 6, adding `web_search` to legacy profiles and adding `bash` once to Ask/Plan while preserving later user removals.
- Remove `renderCall`, `renderResult`, and `renderShell: "self"` from the production `shell_command` and `apply_patch` definitions so the active TUI owns their presentation; `pi-open-tui` can now apply its shared OpenAI-style renderer without competing tool-local framing.
- Keep the specialized `EnterPlanMode` and `plan_write` renderers unchanged because they own Plan-specific streaming and Markdown presentation rather than generic shell/patch chrome.
- Use one fixed natural-language mode policy plus durable runtime-state messages; reconcile missing state at the context tail after branch changes or compaction.
- Remove the model-visible `[PI-ONLY-TOOLS MODE PROTOCOL v1]` heading and keep idempotent injection through a natural opening sentence.
- Enforce the active allowlist fail-closed in every mode, including Normal and Plan-ready, while keeping the existing Ask/Plan checks as defense in depth.
- Constrain every `api=openai-responses` request with `tool_choice.allowed_tools` or `none` without provider-name filtering or rewriting `tools`; retain `PI_ONLY_TOOLS_ALLOWED_TOOLS=off` for incompatible gateways.
- Add cache-stability tests covering dynamic tool exposure, runtime-state reconciliation, provider payload rewriting, and the Normal/Ask/Plan workflow.
- Keep Ask and Plan footer statuses in the same leading plugin-status slot by using distinct keys with one shared fixed sort prefix.
- Add a persistent Ask tool profile beside Normal and Plan in `/only-tools`; Ask model and effort inherit Normal.
- Add one `/mode` selector for Normal, Ask, and Plan, and remove the separate `/ask` command family.
- Keep Shift+Tab as one global mode cycle: Normal → Ask → Plan → Normal, while preserving the idle-only switching guard.
- Make the Ask column an explicit user-maintained allowlist for read-only third-party/MCP tools while locking known write, alternate-shell, patch, and Plan-control tools off.
- Enforce Ask permissions through the shared runtime allowlist gate and retain the Ask-specific `tool_call` check as defense in depth.
- Move Ask read-only behavior into the shared natural-language mode policy; runtime-state messages carry the active mode and allowed tool names.
- Stream the growing `plan_write.content` Markdown in the TUI while tool arguments are generated, without writing partial content to the canonical plan file.
- Make visible plan titles, headings, step labels, and prose follow the user's language; validate localized plans by semantic H2 order while preserving legacy English plans.
- Fix automatic Plan review dispatch so `agent_settled` routes through Pi's command pipeline and receives a command-capable context instead of calling `/plan-approve` with an event context.
- Make a valid `plan_write` publish the exact revision directly to user review and terminate the planning turn.
- Remove the model-facing `ExitPlanMode` tool; only an explicit user review action can enter execution.
- Render `EnterPlanMode` and `plan_write` with Claude-style tool framing and Pi Markdown instead of one muted text block.
- Keep same-session approved-plan handoff messages hidden from the transcript; new-session handoffs remain visible so the execution context is clear.
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

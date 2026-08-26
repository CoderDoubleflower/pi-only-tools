# Changelog

## Unreleased

- Keep Ask and Plan footer statuses in the same leading plugin-status slot by using distinct keys with one shared fixed sort prefix.
- Add a persistent Ask tool profile beside Normal and Plan in `/only-tools`; Ask model and effort inherit Normal.
- Add one `/mode` selector for Normal, Ask, and Plan, and remove the separate `/ask` command family.
- Keep Shift+Tab as one global mode cycle: Normal → Ask → Plan → Normal, while preserving the idle-only switching guard.
- Make the Ask column an explicit user-maintained allowlist for read-only third-party/MCP tools while locking known shell, edit, write, patch, and Plan-control tools off.
- Enforce Ask permissions both through the active tool set and a second `tool_call` allowlist check.
- Inject an explicit `[ASK MODE ACTIVE]` system contract that forbids file, Git, dependency, service, command, build, and test side effects.
- Upgrade profile configuration to version 4 and migrate existing Normal/Plan files with a safe default Ask profile.
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

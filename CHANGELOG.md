# Changelog

## 0.5.0

- Replace session/permanent tool states with one persistent profile × tool allowlist matrix.
- Configure Normal, Plan, and Execution tool access side-by-side in one TUI.
- Keep Plan/Execution model and thinking settings in the same matrix screen.
- Migrate legacy permanentlyDisabledTools into profile omissions and stop applying a global denylist at runtime.
- Make the Execution profile independent from Normal and hide Plan control tools outside their valid profile.

## 0.4.2

- Make bare `/only-tools` open the top-level Tool profiles menu.
- Surface Plan Mode configuration directly from the default `/only-tools` UI.
- Keep the legacy session tool editor available under Session tools and `/only-tools session`.
- Add a regression test locking the top-level menu contents.

## 0.4.1

- Defer all ExtensionAPI runtime action calls until Pi has initialized the session runtime.
- Initialize the normal tool profile during session_start instead of extension registration.
- Remove the registration-time tool-registry probe; standalone Plan Mode should be uninstalled before using the integrated runtime.
- Add a regression test that makes runtime actions throw during extension loading.

## 0.4.0

- Merge Claude-style Plan Mode into pi-only-tools.
- Add unified normal, Plan, and execution tool profiles with one ToolProfileController.
- Add /only-tools plan, /only-tools profiles, and effective-profile diagnostics.
- Preserve legacy claude-plan-mode.json configuration and Plan session state.
- Apply permanent disables consistently without allowing pi-only-tools to overwrite Plan tools.
- Report requested, effective, unregistered, and permanently disabled Plan tools.


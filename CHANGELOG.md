# Changelog

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


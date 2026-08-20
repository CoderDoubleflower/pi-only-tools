# Changelog

## 0.4.0

- Merge Claude-style Plan Mode into pi-only-tools.
- Add unified normal, Plan, and execution tool profiles with one ToolProfileController.
- Add /only-tools plan, /only-tools profiles, and effective-profile diagnostics.
- Preserve legacy claude-plan-mode.json configuration and Plan session state.
- Apply permanent disables consistently without allowing pi-only-tools to overwrite Plan tools.
- Report requested, effective, unregistered, and permanently disabled Plan tools.


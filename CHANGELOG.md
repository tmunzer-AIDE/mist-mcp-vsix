# Changelog

All notable changes to this project are documented in this file.

## 0.2.4 - 2026-04-13

- Added managed Skills commands to install, update, and remove Copilot skills from `https://github.com/tmunzer-AIDE/mist-skills`.
- Simplified skills install/update flow to always use branch `main` and repository root (no ref/path prompts).
- Added support for both workspace skill installs (`.github/skills`) and personal/global installs (`~/.copilot/skills`).
- Added token verification against `GET /api/v1/self` before storing profile tokens, including cloud-specific validation messaging.
- Added host-change safeguards that validate existing stored tokens against the newly selected cloud before profile updates are saved.
- Improved token prompt behavior so pressing Escape cancels profile edits/configuration instead of silently continuing.
- Hardened managed skill state handling by using workspace-scoped state for workspace installs and sanitizing persisted skill names/IDs.
- Hardened skill sync and file safety with path validation, atomic temp/backup writes, rollback protection, and safe backup cleanup.
- Added cancellable skill sync with aggregate timeout controls and clearer cancellation/error reporting.
- Improved partial-failure handling by persisting recoverable sync state, tracking cleanup failures, and avoiding state loss on partial removals.
- Improved UX messages for scope fallback, ref fallback, obsolete cleanup warnings, and single-toast sync result notifications.

## 0.2.3 - 2026-04-13

- Triggered MCP server definition refresh when clearing the active profile token to force header re-resolution.

## 0.2.2 - 2026-04-13

- Fixed host picker behavior to preselect the current host while editing profiles.
- Fixed host picker error path to return cancellation instead of silently applying a fallback host.
- Added safety checks for migrated and previously stored tokens before they can be reused.
- Added user-facing warnings when invalid legacy/stored tokens are discarded.
- Stopped automatically switching the active profile when editing an existing profile.
- Added active profile visibility in the MCP server label and a command to show the active profile.
- Refactored legacy migration flow to initialize once during activation and reuse that initialization across commands.
- Expanded test coverage with profile utility tests (ID generation uniqueness and profile-name validation rules).

## 0.2.1 - 2026-04-13
- Hardened token validation to reject line breaks and control characters before storing or sending headers.
- Tightened profile name validation (reserved names, character restrictions, and max length).
- Synced README command and endpoint documentation with current extension behavior.

## 0.2.0 - 2026-04-13

- Added profile-based configuration to support multiple Mist API tokens.
- Added active profile selection used when resolving MCP request headers.
- Added profile management commands:
	- Add or Update Profile
	- Select Active Profile
	- Edit Profile
	- Delete Profile
	- Rename Profile
	- Clear Active Profile Token
- Added legacy migration from single token/host settings to a default profile.
- Updated profile editing behavior so leaving token input empty keeps the existing token.
- Updated README to document multi-profile setup and management commands.

## 0.1.4 - 2026-04-13

- Added extension icon support in the package metadata.
- Added Makefile-based packaging workflow with required VERSION.
- Added dist output directory for generated VSIX artifacts.
- Improved README with configuration, development, and contribution guidance.
- Added Marketplace metadata fields (repository, bugs, homepage, keywords).

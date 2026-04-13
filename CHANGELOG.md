# Changelog

All notable changes to this project are documented in this file.

## 0.2.1 - 2026-04-13

- Hardened token validation to reject line breaks and control characters before storing or sending headers.
- Tightened profile name validation (reserved names, character restrictions, and max length).
- Switched profile selection logic to use internal profile IDs (avoids name/label collision edge cases).
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

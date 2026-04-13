# Mist MCP Provider VS Code Extension

This extension distributes a preconfigured MCP server definition provided as **Mist MCP Server**.

The server is configured as:

- URL: `https://mcp.ai.juniper.net/mcp/mist`
- Transport: HTTP
- Headers:
  - `Authorization: Bearer <token>`
  - `X-Mist-Base-URL: <selected-host>`

## User Inputs

This extension supports multiple profiles, so you can store different API tokens (including for the same host).

Each profile stores:

1. Mist API token (stored securely in VS Code secret storage)
2. Mist Host URL (saved in extension global state)

Host options:

- https://api.mist.com
- https://api.eu.mist.com
- https://api.gc1.mist.com
- https://api.gc2.mist.com
- https://api.gc3.mist.com
- https://api.gc4.mist.com
- https://api.gc5.mist.com
- https://api.gc6.mist.com
- https://api.gc7.mist.com
- https://api.ac2.mist.com
- https://api.ac5.mist.com
- https://api.ac6.mist.com

Default host is `https://api.mist.com`.

## Commands

- `Mist MCP: Add or Update Profile`
- `Mist MCP: Select Active Profile`
- `Mist MCP: Edit Profile`
- `Mist MCP: Delete Profile`
- `Mist MCP: Rename Profile`
- `Mist MCP: Show Active Profile`
- `Mist MCP: Clear Active Profile Token`

## Configure and Use

### 1. Configure credentials and host

1. Open Command Palette.
2. Run `Mist MCP: Add or Update Profile`.
3. Choose **Add New Profile** or select an existing profile to update.
4. Enter the profile token.
5. Select the profile host URL.

The token is saved in VS Code Secret Storage and the host is saved in extension state.

### 2. Select the active profile

1. Open Command Palette.
2. Run `Mist MCP: Select Active Profile`.
3. Choose the profile to use for MCP requests.

### 3. Use the MCP server

1. Open Copilot Chat / agent mode in VS Code.
2. Start any flow that uses MCP tools.
3. When VS Code resolves the server, this extension provides:
  - MCP URL: `https://mcp.ai.juniper.net/mcp/mist`
  - `Authorization: Bearer <token>`
  - `X-Mist-Base-URL: <selected-host>`

If token or host is missing, VS Code prompts you.

The MCP server entry label includes the active profile name, for example:

- `Mist MCP Server (Prod)`

You can also run `Mist MCP: Show Active Profile` from the Command Palette.

### 4. Update or reset later

- Re-run `Mist MCP: Add or Update Profile` to add more profiles or update an existing one.
- Run `Mist MCP: Select Active Profile` to switch which token/host is used.
- Run `Mist MCP: Edit Profile` to modify the host and optionally replace the token of one profile.
- Run `Mist MCP: Delete Profile` to remove one profile and its stored token.
- Run `Mist MCP: Rename Profile` to rename one profile.
- Run `Mist MCP: Clear Active Profile Token` to remove only the active profile token.

## Development

### Prerequisites

- Node.js 20+
- npm 10+
- VS Code 1.105+

### Setup and validation

```bash
npm install
npm run compile
npm test
```

### Watch mode

```bash
npm run watch
```

## Build and Package

Build a distributable VSIX and set the extension version in one step:

```bash
make package VERSION=x.y.z
```

This command will:

1. Update `package.json` version (without creating a git tag)
2. Install dependencies
3. Compile TypeScript
4. Run tests
5. Package the extension

Output artifact:

- `dist/mist-mcp-provider-<version>.vsix`

Clean build outputs:

```bash
make clean
```

## Contributing

1. Create a feature branch.
2. Implement changes in `src/` and add or update tests in `src/test/`.
3. Run `npm test` and `make package VERSION=x.y.z`.
4. Update README when behavior, commands, or build flow changes.
5. Open a pull request with a short summary and test notes.

Never commit API tokens or other secrets.

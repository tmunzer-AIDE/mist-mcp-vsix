import * as vscode from "vscode";
import {
  DEFAULT_MIST_HOST,
  isAllowedMistHost,
  MIST_HOST_OPTIONS,
  MIST_SERVER_URI
} from "./hosts";

const PROVIDER_ID = "mist.mcp.provider";
const SERVER_LABEL = "Mist MCP Server";
const TOKEN_SECRET_KEY = "mist.apiToken";
const HOST_STATE_KEY = "mist.hostUrl";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Mist MCP Provider");
  context.subscriptions.push(output);

  const provider: vscode.McpServerDefinitionProvider<vscode.McpHttpServerDefinition> = {
    provideMcpServerDefinitions: () => {
      output.appendLine("Providing Mist MCP server definition.");
      return [new vscode.McpHttpServerDefinition(SERVER_LABEL, vscode.Uri.parse(MIST_SERVER_URI))];
    },
    resolveMcpServerDefinition: async (server) => {
      if (server.label !== SERVER_LABEL) {
        return server;
      }

      const token = await getOrPromptToken(context);
      if (!token) {
        output.appendLine("MCP resolve cancelled: token is missing.");
        vscode.window.showWarningMessage("Mist MCP server was not started because no API token was provided.");
        return undefined;
      }

      const host = await getOrPromptHost(context);
      if (!host) {
        output.appendLine("MCP resolve cancelled: host is missing.");
        vscode.window.showWarningMessage("Mist MCP server was not started because no host was selected.");
        return undefined;
      }

      server.headers = {
        Authorization: `Bearer ${token}`,
        "X-Mist-Base-URL": host
      };

      output.appendLine(`Resolved Mist MCP headers for host ${host}.`);
      return server;
    }
  };

  context.subscriptions.push(vscode.lm.registerMcpServerDefinitionProvider(PROVIDER_ID, provider));

  context.subscriptions.push(
    vscode.commands.registerCommand("mistMcpProvider.configure", async () => {
      const token = await promptForToken();
      if (!token) {
        vscode.window.showWarningMessage("Configuration cancelled: token was not provided.");
        return;
      }

      const host = await promptForHost(DEFAULT_MIST_HOST);
      if (!host) {
        vscode.window.showWarningMessage("Configuration cancelled: host was not selected.");
        return;
      }

      await context.secrets.store(TOKEN_SECRET_KEY, token);
      await context.globalState.update(HOST_STATE_KEY, host);
      output.appendLine(`Configuration updated for host ${host}.`);
      vscode.window.showInformationMessage("Mist MCP configuration saved.");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("mistMcpProvider.clearToken", async () => {
      await context.secrets.delete(TOKEN_SECRET_KEY);
      output.appendLine("Stored Mist API token cleared.");
      vscode.window.showInformationMessage("Stored Mist MCP token cleared.");
    })
  );

  output.appendLine("Mist MCP Provider extension activated.");
}

export function deactivate(): void {
  // Nothing to clean up. VS Code disposes subscriptions automatically.
}

async function getOrPromptToken(context: vscode.ExtensionContext): Promise<string | undefined> {
  const existing = await context.secrets.get(TOKEN_SECRET_KEY);
  if (existing && existing.trim().length > 0) {
    return existing;
  }

  const token = await promptForToken();
  if (token) {
    await context.secrets.store(TOKEN_SECRET_KEY, token);
  }

  return token;
}

async function getOrPromptHost(context: vscode.ExtensionContext): Promise<string | undefined> {
  const existingHost = context.globalState.get<string>(HOST_STATE_KEY);
  if (existingHost && isAllowedMistHost(existingHost)) {
    return existingHost;
  }

  const host = await promptForHost(existingHost ?? DEFAULT_MIST_HOST);
  if (host) {
    await context.globalState.update(HOST_STATE_KEY, host);
  }

  return host;
}

async function promptForToken(): Promise<string | undefined> {
  const token = await vscode.window.showInputBox({
    title: "Mist MCP Token",
    prompt: "Enter your Mist API token",
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => {
      if (!value.trim()) {
        return "Token cannot be empty.";
      }

      return undefined;
    }
  });

  return token?.trim();
}

async function promptForHost(defaultHost: string): Promise<string | undefined> {
  const validDefault = isAllowedMistHost(defaultHost) ? defaultHost : DEFAULT_MIST_HOST;
  const host = await vscode.window.showQuickPick(MIST_HOST_OPTIONS, {
    title: "Mist Host URL",
    placeHolder: "Mist Host URL (e.g. api.mist.com)",
    ignoreFocusOut: true,
    canPickMany: false
  });

  if (!host) {
    return undefined;
  }

  if (!isAllowedMistHost(host)) {
    vscode.window.showErrorMessage("Selected Mist host is not allowed.");
    return validDefault;
  }

  return host;
}

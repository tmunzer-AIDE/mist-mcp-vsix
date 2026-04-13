import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_MIST_HOST,
  isAllowedMistHost,
  MIST_HOST_OPTIONS,
  MIST_SERVER_URI
} from "./hosts";
import { createProfileId, getProfileNameValidationError, isSafeHeaderValue } from "./profile-utils";
import {
  collectSkillDirectories,
  formatGitHubRepoSpecifier,
  getSkillNameFromDirectory,
  isSafeSkillName,
  type GitHubRepoSpec
} from "./skills-utils";

const PROVIDER_ID = "mist.mcp.provider";
const SERVER_LABEL = "Mist MCP Server";
const LEGACY_TOKEN_SECRET_KEY = "mist.apiToken";
const LEGACY_HOST_STATE_KEY = "mist.hostUrl";
const PROFILES_STATE_KEY = "mist.profiles";
const ACTIVE_PROFILE_STATE_KEY = "mist.activeProfile";
const PROFILE_TOKEN_SECRET_PREFIX = "mist.profileToken.";
const MANAGED_SKILLS_STATE_PREFIX = "mist.managedSkills.";
const FIXED_SKILLS_REPO_URL = "https://github.com/tmunzer-AIDE/mist-skills";
const FIXED_SKILLS_REPO_SPEC: GitHubRepoSpec = {
  owner: "tmunzer-AIDE",
  repo: "mist-skills"
};
const DEFAULT_SKILLS_REF = "main";
const DEFAULT_SKILLS_PATH_PREFIX = "";
const GITHUB_FETCH_TIMEOUT_MS = 30_000;
const SKILLS_SYNC_TIMEOUT_MS = 180_000;
const TOKEN_VALIDATION_TIMEOUT_MS = 15_000;
const USER_CANCEL_REASON = "Skills sync cancelled by user.";

interface MistProfile {
  id: string;
  name: string;
  host: string;
}

interface ProfileQuickPickItem extends vscode.QuickPickItem {
  profileId: string;
}

type SkillsInstallScope = "workspace" | "global";

interface SkillsTarget {
  scope: SkillsInstallScope;
  destinationRoot: string;
  displayPath: string;
}

interface ManagedSkillsState {
  repo: string;
  ref: string;
  pathPrefix: string;
  installedSkillNames: string[];
  installedAt: string;
}

interface GitHubTreeResponse {
  tree?: Array<{ path?: string; type?: string }>;
  truncated?: boolean;
  message?: string;
}

interface RepoSkillFiles {
  skillName: string;
  skillDirectory: string;
  filePaths: string[];
}

type StoredTokenValidationResult = "valid" | "missing" | "malformed" | "invalid";
type PromptedTokenResult = { token?: string; reason: "ok" | "missing" | "validation_failed" };

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Mist MCP Provider");
  context.subscriptions.push(output);
  const didChangeEmitter = new vscode.EventEmitter<void>();
  context.subscriptions.push(didChangeEmitter);

  const refreshServerDefinitions = (): void => {
    didChangeEmitter.fire();
  };

  const migrationReady = migrateLegacySettingsIfNeeded(context, output).catch((error: unknown) => {
    const details = error instanceof Error ? error.message : String(error);
    output.appendLine(`Legacy migration failed: ${details}`);
  });

  const provider: vscode.McpServerDefinitionProvider<vscode.McpHttpServerDefinition> = {
    onDidChangeMcpServerDefinitions: didChangeEmitter.event,
    provideMcpServerDefinitions: async () => {
      await migrationReady;
      output.appendLine("Providing Mist MCP server definition.");
      return [new vscode.McpHttpServerDefinition(getServerLabel(context), vscode.Uri.parse(MIST_SERVER_URI))];
    },
    resolveMcpServerDefinition: async (server) => {
      if (!server.label.startsWith(SERVER_LABEL)) {
        return server;
      }

      await migrationReady;

      const profile = await getOrPromptActiveProfile(context, output);
      if (!profile) {
        output.appendLine("MCP resolve cancelled: no active profile is available.");
        vscode.window.showWarningMessage("Mist MCP server was not started because no profile was selected.");
        return undefined;
      }

      const tokenResult = await getOrPromptTokenForProfile(context, profile, output);
      if (!tokenResult.token) {
        output.appendLine("MCP resolve cancelled: token is missing.");
        if (tokenResult.reason === "missing") {
          vscode.window.showWarningMessage("Mist MCP server was not started because no API token was provided.");
        }
        return undefined;
      }

      server.headers = {
        Authorization: `Bearer ${tokenResult.token}`,
        "X-Mist-Base-URL": profile.host
      };

      output.appendLine(`Resolved Mist MCP headers for profile ${profile.name} (${profile.host}).`);
      return server;
    }
  };

  context.subscriptions.push(vscode.lm.registerMcpServerDefinitionProvider(PROVIDER_ID, provider));

  context.subscriptions.push(
    vscode.commands.registerCommand("mistMcpProvider.configure", async () => {
      await migrationReady;
      await configureProfile(context, output, refreshServerDefinitions);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("mistMcpProvider.selectProfile", async () => {
      await migrationReady;
      await selectActiveProfile(context, output, refreshServerDefinitions);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("mistMcpProvider.editProfile", async () => {
      await migrationReady;
      await editProfile(context, output, refreshServerDefinitions);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("mistMcpProvider.deleteProfile", async () => {
      await migrationReady;
      await deleteProfile(context, output, refreshServerDefinitions);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("mistMcpProvider.renameProfile", async () => {
      await migrationReady;
      await renameProfile(context, output, refreshServerDefinitions);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("mistMcpProvider.showActiveProfile", async () => {
      await migrationReady;
      const activeProfile = getActiveProfile(context);
      if (!activeProfile) {
        vscode.window.showInformationMessage("No active Mist MCP profile is selected.");
        return;
      }

      vscode.window.showInformationMessage(`Active Mist MCP profile: ${activeProfile.name} (${activeProfile.host})`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("mistMcpProvider.clearToken", async () => {
      await migrationReady;
      const profile = await getOrPromptActiveProfile(context, output);
      if (!profile) {
        return;
      }

      await context.secrets.delete(getProfileTokenSecretKey(profile.id));
      refreshServerDefinitions();
      output.appendLine(`Stored Mist API token cleared for profile ${profile.name}.`);
      vscode.window.showInformationMessage(`Stored token cleared for profile ${profile.name}.`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("mistMcpProvider.installSkills", async () => {
      await installSkillsFromRepo(context, output);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("mistMcpProvider.updateSkills", async () => {
      await updateInstalledSkills(context, output);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("mistMcpProvider.removeSkills", async () => {
      await removeInstalledSkills(context, output);
    })
  );

  output.appendLine("Mist MCP Provider extension activated.");
}

export function deactivate(): void {
  // Nothing to clean up. VS Code disposes subscriptions automatically.
}

async function configureProfile(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  refreshServerDefinitions: () => void
): Promise<void> {
  const profiles = getProfiles(context);
  const pickItems: Array<vscode.QuickPickItem & { action: "add" | "edit"; profileId?: string }> = [
    {
      label: "$(add) Add New Profile",
      description: "Create a new token+host profile",
      action: "add"
    },
    ...profiles.map((profile) => ({
      label: profile.name,
      description: profile.host,
      detail: "Update this profile",
      action: "edit" as const,
      profileId: profile.id
    }))
  ];

  const selected = await vscode.window.showQuickPick(pickItems, {
    title: "Configure Mist MCP Profile",
    placeHolder: "Select a profile to update or add a new one",
    ignoreFocusOut: true
  });

  if (!selected) {
    return;
  }

  if (selected.action === "add") {
    const name = await promptForProfileName(profiles);
    if (!name) {
      return;
    }

    const host = await promptForHost(DEFAULT_MIST_HOST);
    if (!host) {
      vscode.window.showWarningMessage("Configuration cancelled: host was not selected.");
      return;
    }

    const token = await promptForToken();
    if (!token) {
      vscode.window.showWarningMessage("Configuration cancelled: token was not provided.");
      return;
    }

    const isValidToken = await validateTokenForHost(host, token, output);
    if (!isValidToken) {
      return;
    }

    const newProfile: MistProfile = {
      id: createProfileId(name),
      name,
      host
    };

    const nextProfiles = [...profiles, newProfile];
    await saveProfiles(context, nextProfiles);
    await context.globalState.update(ACTIVE_PROFILE_STATE_KEY, newProfile.id);
    await context.secrets.store(getProfileTokenSecretKey(newProfile.id), token);
    refreshServerDefinitions();
    output.appendLine(`Added profile ${newProfile.name} (${newProfile.host}).`);
    vscode.window.showInformationMessage(`Mist MCP profile ${newProfile.name} saved and set active.`);
    return;
  }

  const existingProfile = profiles.find((profile) => profile.id === selected.profileId);
  if (!existingProfile) {
    vscode.window.showErrorMessage("Selected profile could not be found.");
    return;
  }

  const host = await promptForHost(existingProfile.host);
  if (!host) {
    vscode.window.showWarningMessage("Configuration cancelled: host was not selected.");
    return;
  }

  const tokenInput = await promptForOptionalToken({
    title: "Mist MCP Token",
    prompt: "Enter a new token or leave empty to keep the existing one"
  });
  if (tokenInput === undefined) {
    vscode.window.showInformationMessage("Configuration cancelled.");
    return;
  }

  const token = tokenInput === "" ? undefined : tokenInput;
  if (token) {
    const isValidToken = await validateTokenForHost(host, token, output);
    if (!isValidToken) {
      return;
    }

    await context.secrets.store(getProfileTokenSecretKey(existingProfile.id), token);
  } else if (host !== existingProfile.host) {
    const storedTokenValidation = await validateStoredTokenForHost(context, existingProfile, host, output);
    if (storedTokenValidation !== "valid") {
      if (storedTokenValidation === "missing") {
        vscode.window.showWarningMessage(
          "Configuration cancelled: no valid stored token found for this profile. Enter a token for the selected cloud."
        );
        return;
      }

      if (storedTokenValidation === "malformed") {
        vscode.window.showWarningMessage(
          "Configuration cancelled: no valid stored token found for this profile. Enter a token for the selected cloud."
        );
        return;
      }
      return;
    }
  }

  const nextProfiles = profiles.map((profile) => {
    if (profile.id !== existingProfile.id) {
      return profile;
    }

    return {
      ...profile,
      host
    };
  });

  await saveProfiles(context, nextProfiles);
  refreshServerDefinitions();

  output.appendLine(`Updated profile ${existingProfile.name} (${host}).`);
  if (token) {
    vscode.window.showInformationMessage(`Mist MCP profile ${existingProfile.name} updated, token replaced.`);
    return;
  }

  vscode.window.showInformationMessage(`Mist MCP profile ${existingProfile.name} updated.`);
}

async function selectActiveProfile(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  refreshServerDefinitions: () => void
): Promise<void> {
  const profiles = getProfiles(context);
  if (profiles.length === 0) {
    const action = await vscode.window.showInformationMessage("No Mist MCP profile is configured.", "Configure Profile");
    if (action === "Configure Profile") {
      await configureProfile(context, output, refreshServerDefinitions);
    }

    return;
  }

  const activeProfileId = context.globalState.get<string>(ACTIVE_PROFILE_STATE_KEY);
  const selected = await vscode.window.showQuickPick<ProfileQuickPickItem>(
    profiles.map((profile): ProfileQuickPickItem => ({
      label: profile.name,
      description: profile.host,
      detail: profile.id === activeProfileId ? "Currently active" : undefined,
      profileId: profile.id
    })),
    {
      title: "Select Active Mist MCP Profile",
      placeHolder: "Choose which profile is used for MCP requests",
      ignoreFocusOut: true
    }
  );

  if (!selected) {
    return;
  }

  const profile = profiles.find((item) => item.id === selected.profileId);
  if (!profile) {
    vscode.window.showErrorMessage("Selected profile could not be found.");
    return;
  }

  await context.globalState.update(ACTIVE_PROFILE_STATE_KEY, profile.id);
  refreshServerDefinitions();
  output.appendLine(`Active profile set to ${profile.name} (${profile.host}).`);
  vscode.window.showInformationMessage(`Mist MCP active profile set to ${profile.name}.`);
}

async function editProfile(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  refreshServerDefinitions: () => void
): Promise<void> {
  const profiles = getProfiles(context);
  const selectedProfile = await promptForExistingProfile(profiles, "Edit Mist MCP Profile", "Choose a profile to edit");
  if (!selectedProfile) {
    return;
  }

  const host = await promptForHost(selectedProfile.host);
  if (!host) {
    vscode.window.showWarningMessage("Edit cancelled: host was not selected.");
    return;
  }

  const tokenInput = await promptForOptionalToken({
    title: "Mist MCP Profile Token",
    prompt: "Enter a new token or leave empty to keep the existing one"
  });

  if (tokenInput === undefined) {
    vscode.window.showInformationMessage("Edit cancelled.");
    return;
  }

  const token = tokenInput === "" ? undefined : tokenInput;

  let replacedToken = false;
  if (token) {
    const isValidToken = await validateTokenForHost(host, token, output);
    if (!isValidToken) {
      return;
    }

    await context.secrets.store(getProfileTokenSecretKey(selectedProfile.id), token);
    replacedToken = true;
  } else if (host !== selectedProfile.host) {
    const storedTokenValidation = await validateStoredTokenForHost(context, selectedProfile, host, output);
    if (storedTokenValidation !== "valid") {
      if (storedTokenValidation === "missing" || storedTokenValidation === "malformed") {
        vscode.window.showWarningMessage(
          "Edit cancelled: no valid stored token found for this profile. Enter a token for the selected cloud."
        );
        return;
      }
      return;
    }
  }

  const nextProfiles = profiles.map((profile) => {
    if (profile.id !== selectedProfile.id) {
      return profile;
    }

    return {
      ...profile,
      host
    };
  });

  await saveProfiles(context, nextProfiles);
  refreshServerDefinitions();

  output.appendLine(`Edited profile ${selectedProfile.name} (${host}).`);
  if (replacedToken) {
    vscode.window.showInformationMessage(`Profile ${selectedProfile.name} updated, token replaced.`);
    return;
  }

  vscode.window.showInformationMessage(`Profile ${selectedProfile.name} updated.`);
}

async function deleteProfile(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  refreshServerDefinitions: () => void
): Promise<void> {
  const profiles = getProfiles(context);
  const selectedProfile = await promptForExistingProfile(
    profiles,
    "Delete Mist MCP Profile",
    "Choose a profile to delete"
  );
  if (!selectedProfile) {
    return;
  }

  const confirmed = await vscode.window.showWarningMessage(
    `Delete profile ${selectedProfile.name}? This removes its stored token.`,
    { modal: true },
    "Delete"
  );

  if (confirmed !== "Delete") {
    return;
  }

  const nextProfiles = profiles.filter((profile) => profile.id !== selectedProfile.id);
  await saveProfiles(context, nextProfiles);
  await context.secrets.delete(getProfileTokenSecretKey(selectedProfile.id));

  const activeProfileId = context.globalState.get<string>(ACTIVE_PROFILE_STATE_KEY);
  if (activeProfileId === selectedProfile.id) {
    const nextActiveProfileId = nextProfiles.length > 0 ? nextProfiles[0].id : undefined;
    await context.globalState.update(ACTIVE_PROFILE_STATE_KEY, nextActiveProfileId);
  }
  refreshServerDefinitions();

  output.appendLine(`Deleted profile ${selectedProfile.name}.`);
  vscode.window.showInformationMessage(`Profile ${selectedProfile.name} deleted.`);
}

async function renameProfile(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  refreshServerDefinitions: () => void
): Promise<void> {
  const profiles = getProfiles(context);
  const selectedProfile = await promptForExistingProfile(
    profiles,
    "Rename Mist MCP Profile",
    "Choose a profile to rename"
  );
  if (!selectedProfile) {
    return;
  }

  const renamedProfile = await promptForRenamedProfileName(selectedProfile, profiles);
  if (!renamedProfile) {
    return;
  }

  if (renamedProfile === selectedProfile.name) {
    return;
  }

  const nextProfiles = profiles.map((profile) => {
    if (profile.id !== selectedProfile.id) {
      return profile;
    }

    return {
      ...profile,
      name: renamedProfile
    };
  });

  await saveProfiles(context, nextProfiles);
  refreshServerDefinitions();
  output.appendLine(`Renamed profile ${selectedProfile.name} to ${renamedProfile}.`);
  vscode.window.showInformationMessage(`Profile renamed to ${renamedProfile}.`);
}

async function getOrPromptTokenForProfile(
  context: vscode.ExtensionContext,
  profile: MistProfile,
  output: vscode.OutputChannel
): Promise<PromptedTokenResult> {
  const secretKey = getProfileTokenSecretKey(profile.id);
  const existing = await context.secrets.get(secretKey);
  if (existing) {
    const normalizedExisting = existing.trim();
    if (normalizedExisting && isSafeHeaderValue(normalizedExisting)) {
      return { token: normalizedExisting, reason: "ok" };
    }

    // Drop invalid legacy/stale values so the user is prompted for a fresh token.
    await context.secrets.delete(secretKey);
    vscode.window.showWarningMessage(
      `The stored token for profile ${profile.name} was invalid and has been removed. Please enter a new token.`
    );
  }

  const token = await promptForToken();
  if (!token) {
    return { reason: "missing" };
  }

  const isValidToken = await validateTokenForHost(profile.host, token, output);
  if (!isValidToken) {
    return { reason: "validation_failed" };
  }

  await context.secrets.store(secretKey, token);

  return { token, reason: "ok" };
}

async function validateTokenForHost(
  host: string,
  token: string,
  output: vscode.OutputChannel
): Promise<boolean> {
  const endpoint = new URL("/api/v1/self", host).toString();

  try {
    const response = await fetch(endpoint, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Token ${token}`
      },
      signal: AbortSignal.timeout(TOKEN_VALIDATION_TIMEOUT_MS)
    });

    if (response.ok) {
      return true;
    }

    if (response.status === 401 || response.status === 403) {
      vscode.window.showErrorMessage(`The API token is invalid for the selected cloud (${host}).`);
      output.appendLine(`Token validation rejected for cloud ${host}: HTTP ${response.status}.`);
      return false;
    }

    const responseDetail = await readResponseSnippet(response);
    const detailSuffix = responseDetail ? ` ${responseDetail}` : "";
    vscode.window.showErrorMessage(
      `Unable to validate API token for ${host} (HTTP ${response.status}).${detailSuffix}`
    );
    output.appendLine(
      `Token validation failed for cloud ${host}: HTTP ${response.status}.${responseDetail ? ` ${responseDetail}` : ""}`
    );
    return false;
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Unable to validate API token for ${host}. ${details}`);
    output.appendLine(`Token validation failed for cloud ${host}: ${details}`);
    return false;
  }
}

async function validateStoredTokenForHost(
  context: vscode.ExtensionContext,
  profile: MistProfile,
  host: string,
  output: vscode.OutputChannel
): Promise<StoredTokenValidationResult> {
  const existingToken = await context.secrets.get(getProfileTokenSecretKey(profile.id));
  const normalizedToken = existingToken?.trim();
  if (!normalizedToken) {
    output.appendLine(`Stored token for profile ${profile.name} is missing while validating host change.`);
    return "missing";
  }

  if (!isSafeHeaderValue(normalizedToken)) {
    output.appendLine(`Stored token for profile ${profile.name} is malformed while validating host change.`);
    return "malformed";
  }

  const isValidToken = await validateTokenForHost(host, normalizedToken, output);
  return isValidToken ? "valid" : "invalid";
}

async function readResponseSnippet(response: Response): Promise<string | undefined> {
  try {
    const text = (await response.text()).trim();
    if (!text) {
      return undefined;
    }

    return text.length <= 160 ? text : `${text.slice(0, 157)}...`;
  } catch {
    return undefined;
  }
}

async function getOrPromptActiveProfile(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel
): Promise<MistProfile | undefined> {
  let profiles = getProfiles(context);
  if (profiles.length === 0) {
    const action = await vscode.window.showInformationMessage("No Mist MCP profile is configured.", "Configure Profile");
    if (action !== "Configure Profile") {
      return undefined;
    }

    await configureProfile(context, output, () => {
      // No refresh callback is needed in this helper path.
    });
    profiles = getProfiles(context);
    if (profiles.length === 0) {
      return undefined;
    }
  }

  const activeProfileId = context.globalState.get<string>(ACTIVE_PROFILE_STATE_KEY);
  const activeProfile = profiles.find((profile) => profile.id === activeProfileId);
  if (activeProfile) {
    return activeProfile;
  }

  if (profiles.length === 1) {
    await context.globalState.update(ACTIVE_PROFILE_STATE_KEY, profiles[0].id);
    return profiles[0];
  }

  const selected = await vscode.window.showQuickPick<ProfileQuickPickItem>(
    profiles.map((profile): ProfileQuickPickItem => ({
      label: profile.name,
      description: profile.host,
      profileId: profile.id
    })),
    {
      title: "Select Active Mist MCP Profile",
      placeHolder: "Choose which profile is used for MCP requests",
      ignoreFocusOut: true
    }
  );

  if (!selected) {
    return undefined;
  }

  const profile = profiles.find((item) => item.id === selected.profileId);
  if (!profile) {
    return undefined;
  }

  await context.globalState.update(ACTIVE_PROFILE_STATE_KEY, profile.id);
  return profile;
}

async function promptForToken(): Promise<string | undefined> {
  const token = await vscode.window.showInputBox({
    title: "Mist MCP Token",
    prompt: "Enter your Mist API token",
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => {
      const normalized = value.trim();
      if (!normalized) {
        return "Token cannot be empty.";
      }

      if (!isSafeHeaderValue(normalized)) {
        return "Token cannot contain line breaks or control characters.";
      }

      return undefined;
    }
  });

  const normalized = token?.trim();
  if (!normalized || !isSafeHeaderValue(normalized)) {
    return undefined;
  }

  return normalized;
}

async function promptForOptionalToken(options: { title: string; prompt: string }): Promise<string | "" | undefined> {
  const token = await vscode.window.showInputBox({
    title: options.title,
    prompt: options.prompt,
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => {
      const normalized = value.trim();
      if (!normalized) {
        return undefined;
      }

      if (!isSafeHeaderValue(normalized)) {
        return "Token cannot contain line breaks or control characters.";
      }

      return undefined;
    }
  });

  if (token === undefined) {
    return undefined;
  }

  const normalized = token?.trim();
  if (!normalized) {
    return "";
  }

  if (!isSafeHeaderValue(normalized)) {
    return undefined;
  }

  return normalized;
}

async function promptForProfileName(existingProfiles: MistProfile[]): Promise<string | undefined> {
  const existingNames = new Set(existingProfiles.map((profile) => profile.name.toLowerCase()));
  const name = await vscode.window.showInputBox({
    title: "Mist MCP Profile Name",
    prompt: "Enter a unique profile name",
    ignoreFocusOut: true,
    validateInput: (value) => {
      return getProfileNameValidationError(value, existingNames);
    }
  });

  const normalized = name?.trim();
  if (!normalized || getProfileNameValidationError(normalized, existingNames)) {
    return undefined;
  }

  return normalized;
}

async function promptForRenamedProfileName(
  currentProfile: MistProfile,
  existingProfiles: MistProfile[]
): Promise<string | undefined> {
  const existingNames = new Set(
    existingProfiles
      .filter((profile) => profile.id !== currentProfile.id)
      .map((profile) => profile.name.toLowerCase())
  );

  const name = await vscode.window.showInputBox({
    title: "Rename Mist MCP Profile",
    prompt: "Enter a new unique profile name",
    value: currentProfile.name,
    ignoreFocusOut: true,
    validateInput: (value) => {
      return getProfileNameValidationError(value, existingNames);
    }
  });

  const normalized = name?.trim();
  if (!normalized || getProfileNameValidationError(normalized, existingNames)) {
    return undefined;
  }

  return normalized;
}

async function promptForHost(defaultHost: string): Promise<string | undefined> {
  const validDefault = isAllowedMistHost(defaultHost) ? defaultHost : DEFAULT_MIST_HOST;
  const hostItems: vscode.QuickPickItem[] = [
    { label: validDefault, description: "Current" },
    ...MIST_HOST_OPTIONS.filter((host) => host !== validDefault).map((host) => ({ label: host }))
  ];
  const selected = await vscode.window.showQuickPick(hostItems, {
    title: "Mist Host URL",
    placeHolder: "Mist Host URL (e.g. api.mist.com)",
    ignoreFocusOut: true
  });

  if (!selected) {
    return undefined;
  }

  const host = selected.label;

  if (!isAllowedMistHost(host)) {
    vscode.window.showErrorMessage("Selected Mist host is not allowed.");
    return undefined;
  }

  return host;
}

function getProfiles(context: vscode.ExtensionContext): MistProfile[] {
  const rawProfiles = context.globalState.get<unknown>(PROFILES_STATE_KEY);
  if (!Array.isArray(rawProfiles)) {
    return [];
  }

  const profiles: MistProfile[] = [];
  for (const candidate of rawProfiles) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }

    const profile = candidate as Partial<MistProfile>;
    if (typeof profile.id !== "string" || typeof profile.name !== "string" || typeof profile.host !== "string") {
      continue;
    }

    const normalizedId = profile.id.trim();
    const normalizedName = profile.name.trim();
    const normalizedHost = profile.host.trim();
    if (!normalizedId || !normalizedName || !isAllowedMistHost(normalizedHost)) {
      continue;
    }

    profiles.push({
      id: normalizedId,
      name: normalizedName,
      host: normalizedHost
    });
  }

  return profiles;
}

async function promptForExistingProfile(
  profiles: MistProfile[],
  title: string,
  placeHolder: string
): Promise<MistProfile | undefined> {
  if (profiles.length === 0) {
    vscode.window.showInformationMessage("No Mist MCP profiles are configured.");
    return undefined;
  }

  const selected = await vscode.window.showQuickPick<ProfileQuickPickItem>(
    profiles.map((profile): ProfileQuickPickItem => ({
      label: profile.name,
      description: profile.host,
      profileId: profile.id
    })),
    {
      title,
      placeHolder,
      ignoreFocusOut: true
    }
  );

  if (!selected) {
    return undefined;
  }

  return profiles.find((profile) => profile.id === selected.profileId);
}

async function saveProfiles(context: vscode.ExtensionContext, profiles: MistProfile[]): Promise<void> {
  await context.globalState.update(PROFILES_STATE_KEY, profiles);
}

function getProfileTokenSecretKey(profileId: string): string {
  return `${PROFILE_TOKEN_SECRET_PREFIX}${profileId}`;
}

async function installSkillsFromRepo(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
  const target = await promptForSkillsTarget(["workspace", "global"], {
    title: "Install Mist Skills",
    placeHolder: "Choose where to install skills"
  });
  if (!target) {
    return;
  }

  const existingState = getManagedSkillsState(context, target.scope);
  output.appendLine(`Using fixed skills source: ${FIXED_SKILLS_REPO_URL}.`);

  const ref = await vscode.window.showInputBox({
    title: "Repository Ref",
    prompt: "Branch, tag, or commit to install from",
    value: existingState?.ref ?? DEFAULT_SKILLS_REF,
    ignoreFocusOut: true,
    validateInput: (value) => {
      if (!value.trim()) {
        return "Ref cannot be empty.";
      }

      return undefined;
    }
  });

  if (!ref || !ref.trim()) {
    return;
  }

  const pathPrefix = await vscode.window.showInputBox({
    title: "Skills Path In Repository",
    prompt: "Optional subfolder path that contains skill folders (leave empty for repo root scan)",
    value: existingState?.pathPrefix ?? DEFAULT_SKILLS_PATH_PREFIX,
    ignoreFocusOut: true
  });

  if (pathPrefix === undefined) {
    return;
  }

  await syncSkillsFromGitHub({
    context,
    output,
    target,
    repoSpec: FIXED_SKILLS_REPO_SPEC,
    ref: ref.trim(),
    pathPrefix: pathPrefix.trim(),
    mode: "install"
  });
}

async function updateInstalledSkills(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
  const availableScopes = getManagedSkillScopes(context);
  if (availableScopes.length === 0) {
    vscode.window.showInformationMessage("No managed skills are installed yet.");
    return;
  }

  const target = await promptForSkillsTarget(availableScopes, {
    title: "Update Installed Skills",
    placeHolder: "Choose which managed install to update"
  });
  if (!target) {
    return;
  }

  const state = getManagedSkillsState(context, target.scope);
  if (!state) {
    vscode.window.showWarningMessage("No managed skill metadata found for the selected target.");
    return;
  }

  if (state.repo !== formatGitHubRepoSpecifier(FIXED_SKILLS_REPO_SPEC)) {
    output.appendLine(
      `Ignoring previously stored skills source ${state.repo} and using fixed source ${FIXED_SKILLS_REPO_URL}.`
    );
  }

  const requestedRef = state.ref.trim();
  const resolvedRef = requestedRef || DEFAULT_SKILLS_REF;
  if (!requestedRef) {
    output.appendLine(
      `Stored skills ref for ${target.scope} scope was empty; falling back to default ref ${DEFAULT_SKILLS_REF}.`
    );
    vscode.window.showInformationMessage(
      `Stored skills ref was empty. Falling back to default ref ${DEFAULT_SKILLS_REF}.`
    );
  }

  await syncSkillsFromGitHub({
    context,
    output,
    target,
    repoSpec: FIXED_SKILLS_REPO_SPEC,
    ref: resolvedRef,
    pathPrefix: state.pathPrefix.trim(),
    mode: "update",
    existingState: state
  });
}

async function removeInstalledSkills(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
  const availableScopes = getManagedSkillScopes(context);
  if (availableScopes.length === 0) {
    vscode.window.showInformationMessage("No managed skills are installed yet.");
    return;
  }

  const target = await promptForSkillsTarget(availableScopes, {
    title: "Remove Installed Skills",
    placeHolder: "Choose which managed install to remove"
  });
  if (!target) {
    return;
  }

  const state = getManagedSkillsState(context, target.scope);
  if (!state) {
    vscode.window.showInformationMessage("No managed skills are tracked for the selected target.");
    return;
  }

  if (state.installedSkillNames.length === 0) {
    await getManagedSkillsStorage(context, target.scope).update(getManagedSkillsStateKey(target.scope), undefined);
    output.appendLine(`Cleared stale managed skills state for ${target.scope} scope.`);
    vscode.window.showInformationMessage("No managed skills were listed. Stale managed state has been cleared.");
    return;
  }

  const confirmed = await vscode.window.showWarningMessage(
    `Remove ${state.installedSkillNames.length} managed skill(s) from ${target.displayPath}?`,
    { modal: true },
    "Remove"
  );

  if (confirmed !== "Remove") {
    return;
  }

  let removalError: unknown;
  const removedSkillNames = new Set<string>();
  for (const skillName of state.installedSkillNames) {
    try {
      const skillPath = resolveSkillPathWithinRoot(target.destinationRoot, skillName);
      await fs.rm(skillPath, { recursive: true, force: true });
      removedSkillNames.add(skillName);
    } catch (error) {
      removalError ??= error;
      const details = error instanceof Error ? error.message : String(error);
      output.appendLine(`Managed skill removal failed for ${skillName}: ${details}`);
    }
  }

  if (removalError) {
    const details = removalError instanceof Error ? removalError.message : String(removalError);
    vscode.window.showErrorMessage(`Failed to remove one or more managed skills: ${details}`);
  }

  const remainingSkillNames = state.installedSkillNames.filter((name) => !removedSkillNames.has(name));
  const nextState = remainingSkillNames.length > 0
    ? {
      ...state,
      installedSkillNames: remainingSkillNames,
      installedAt: new Date().toISOString()
    }
    : undefined;

  try {
    await getManagedSkillsStorage(context, target.scope).update(getManagedSkillsStateKey(target.scope), nextState);
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    output.appendLine(`Failed to clear managed skills state for ${target.scope}: ${details}`);
    vscode.window.showErrorMessage(`Failed to clear managed skills state: ${details}`);
    return;
  }

  if (removalError) {
    output.appendLine(
      `Managed skill removal completed with errors. ${remainingSkillNames.length} skill(s) remain tracked in state.`
    );
    return;
  }

  output.appendLine(
    `Removed ${state.installedSkillNames.length} managed skill(s) from ${target.displayPath} (${target.scope}).`
  );
  vscode.window.showInformationMessage(`Removed ${state.installedSkillNames.length} managed skill(s).`);
}

async function syncSkillsFromGitHub(options: {
  context: vscode.ExtensionContext;
  output: vscode.OutputChannel;
  target: SkillsTarget;
  repoSpec: GitHubRepoSpec;
  ref: string;
  pathPrefix: string;
  mode: "install" | "update";
  existingState?: ManagedSkillsState;
}): Promise<void> {
  const { context, output, target, repoSpec, ref, pathPrefix, mode, existingState } = options;
  const repoLabel = formatGitHubRepoSpecifier(repoSpec);
  const syncAbortController = new AbortController();
  const syncTimeoutHandle = setTimeout(() => {
    syncAbortController.abort(new Error(`Skills sync timed out after ${SKILLS_SYNC_TIMEOUT_MS / 1000} seconds.`));
  }, SKILLS_SYNC_TIMEOUT_MS);

  let repoSkills: RepoSkillFiles[];
  try {
    repoSkills = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: mode === "install" ? "Installing skills" : "Updating skills",
        cancellable: true
      },
      async (progress, cancellationToken) => {
        const cancellationSubscription = cancellationToken.onCancellationRequested(() => {
          syncAbortController.abort(new Error(USER_CANCEL_REASON));
        });

        try {
          progress.report({ message: `Reading repository tree for ${repoLabel}@${ref}...` });
          const treeEntries = await fetchGitHubTree(repoSpec, ref, output, syncAbortController.signal);
          const skills = getRepoSkillFiles(treeEntries, pathPrefix);
          return skills;
        } finally {
          cancellationSubscription.dispose();
        }
      }
    );
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    if (isUserCancelledSync(syncAbortController.signal)) {
      output.appendLine(`Skill sync cancelled by user while reading ${repoLabel}@${ref}.`);
      vscode.window.showInformationMessage("Skills sync cancelled.");
    } else {
      output.appendLine(`Skill sync failed while reading ${repoLabel}@${ref}: ${details}`);
      vscode.window.showErrorMessage(`Unable to read skills from ${repoLabel}@${ref}: ${details}`);
    }
    clearTimeout(syncTimeoutHandle);
    return;
  }

  const skillNames = repoSkills.map((skill) => skill.skillName);
  const installedSet = new Set(skillNames);
  const previousSkills = existingState?.installedSkillNames ?? getManagedSkillsState(context, target.scope)?.installedSkillNames ?? [];
  const obsoleteManagedSkills = previousSkills.filter((name) => !installedSet.has(name));
  const overwriteSkills = await getExistingSkillNames(target.destinationRoot, skillNames);

  if (overwriteSkills.length > 0 || obsoleteManagedSkills.length > 0) {
    const overwriteText = overwriteSkills.length > 0
      ? `replace ${overwriteSkills.length} existing skill folder(s)`
      : undefined;
    const removeText = obsoleteManagedSkills.length > 0
      ? `remove ${obsoleteManagedSkills.length} previously managed skill folder(s)`
      : undefined;
    const actionText = [overwriteText, removeText].filter((part): part is string => Boolean(part)).join(" and ");

    const confirmed = await vscode.window.showWarningMessage(
      `This operation will ${actionText} in ${target.displayPath}. Continue?`,
      { modal: true },
      "Continue"
    );

    if (confirmed !== "Continue") {
      clearTimeout(syncTimeoutHandle);
      return;
    }
  }

  const syncedSkillNames: string[] = [];
  const failedObsoleteSkillNames: string[] = [];

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: mode === "install" ? "Installing skills" : "Updating skills",
        cancellable: true
      },
      async (progress, cancellationToken) => {
        const cancellationSubscription = cancellationToken.onCancellationRequested(() => {
          syncAbortController.abort(new Error(USER_CANCEL_REASON));
        });

        try {
          throwIfSignalAborted(syncAbortController.signal);
          await fs.mkdir(target.destinationRoot, { recursive: true });

          let index = 0;
          for (const skill of repoSkills) {
            throwIfSignalAborted(syncAbortController.signal);
            index += 1;
            progress.report({ message: `Syncing ${skill.skillName} (${index}/${repoSkills.length})` });
            await writeSkillFromRepo(target.destinationRoot, repoSpec, ref, skill, syncAbortController.signal);
            syncedSkillNames.push(skill.skillName);
          }

          for (const skillName of obsoleteManagedSkills) {
            try {
              const skillPath = resolveSkillPathWithinRoot(target.destinationRoot, skillName);
              await fs.rm(skillPath, { recursive: true, force: true });
            } catch (error) {
              failedObsoleteSkillNames.push(skillName);
              const details = error instanceof Error ? error.message : String(error);
              output.appendLine(`Failed to remove obsolete managed skill ${skillName}: ${details}`);
            }
          }
        } finally {
          cancellationSubscription.dispose();
        }
      }
    );
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    if (syncedSkillNames.length > 0) {
      const preservedPreviousSkills = previousSkills.filter(
        (name) => installedSet.has(name) && !syncedSkillNames.includes(name)
      );
      const partialInstalledSkillNames = Array.from(new Set([...syncedSkillNames, ...preservedPreviousSkills]));

      const partialState: ManagedSkillsState = {
        repo: repoLabel,
        ref,
        pathPrefix,
        installedSkillNames: partialInstalledSkillNames,
        installedAt: new Date().toISOString()
      };

      try {
        await getManagedSkillsStorage(context, target.scope).update(getManagedSkillsStateKey(target.scope), partialState);
        output.appendLine(
          `Persisted partial managed skills state with ${syncedSkillNames.length} synchronized skill(s) after failure.`
        );
      } catch (persistError) {
        const persistDetails = persistError instanceof Error ? persistError.message : String(persistError);
        output.appendLine(`Failed to persist partial managed skills state: ${persistDetails}`);
      }
    }

    if (isUserCancelledSync(syncAbortController.signal)) {
      output.appendLine(
        `Skill sync cancelled by user after syncing ${syncedSkillNames.length}/${repoSkills.length} skill(s).`
      );
      if (syncedSkillNames.length > 0) {
        vscode.window.showInformationMessage(
          `Skills sync cancelled after syncing ${syncedSkillNames.length}/${repoSkills.length} skill(s).`
        );
      } else {
        vscode.window.showInformationMessage("Skills sync cancelled.");
      }
    } else {
      output.appendLine(`Skill sync failed while writing files: ${details}`);
      vscode.window.showErrorMessage(
        `Skill installation failed after syncing ${syncedSkillNames.length}/${repoSkills.length} skill(s): ${details}`
      );
    }
    clearTimeout(syncTimeoutHandle);
    return;
  }

  const nextState: ManagedSkillsState = {
    repo: repoLabel,
    ref,
    pathPrefix,
    installedSkillNames:
      failedObsoleteSkillNames.length > 0
        ? Array.from(new Set([...skillNames, ...failedObsoleteSkillNames]))
        : skillNames,
    installedAt: new Date().toISOString()
  };

  try {
    await getManagedSkillsStorage(context, target.scope).update(getManagedSkillsStateKey(target.scope), nextState);
    output.appendLine(
      `${mode === "install" ? "Installed" : "Updated"} ${skillNames.length} managed skill(s) from ${repoLabel}@${ref} to ${target.displayPath} (${target.scope}).`
    );
    if (failedObsoleteSkillNames.length > 0) {
      output.appendLine(
        `Completed skill sync with ${failedObsoleteSkillNames.length} obsolete cleanup warning(s): ${failedObsoleteSkillNames.join(", ")}.`
      );
      vscode.window.showWarningMessage(
        `Skills synchronized, but ${failedObsoleteSkillNames.length} obsolete skill folder(s) could not be removed.`
      );
    }

    vscode.window.showInformationMessage(
      `${mode === "install" ? "Installed" : "Updated"} ${skillNames.length} skill(s) in ${target.displayPath}.`
    );
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    output.appendLine(`Failed to persist managed skills state after sync: ${details}`);
    vscode.window.showErrorMessage(`Skills were synchronized, but saving managed state failed: ${details}`);
  } finally {
    clearTimeout(syncTimeoutHandle);
  }
}

async function fetchGitHubTree(
  repoSpec: GitHubRepoSpec,
  ref: string,
  output: vscode.OutputChannel,
  syncSignal: AbortSignal
): Promise<Array<{ path: string; type: string }>> {
  const treeUrl = new URL(
    `https://api.github.com/repos/${repoSpec.owner}/${repoSpec.repo}/git/trees/${encodeURIComponent(ref)}`
  );
  treeUrl.searchParams.set("recursive", "1");

  const response = await fetch(treeUrl.toString(), {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "mist-mcp-provider"
    },
    signal: createFetchAbortSignal(syncSignal, GITHUB_FETCH_TIMEOUT_MS)
  });

  if (!response.ok) {
    let message = response.statusText;
    try {
      const errBody = (await response.json()) as GitHubTreeResponse;
      if (typeof errBody?.message === "string") {
        message = errBody.message;
      }
    } catch {
      // Ignore non-JSON error responses and keep statusText.
    }

    throw new Error(`GitHub API error ${response.status}: ${message}`);
  }

  const body = (await response.json()) as GitHubTreeResponse;

  if (!Array.isArray(body.tree)) {
    throw new Error("GitHub tree response did not include file entries.");
  }

  if (body.truncated) {
    const message =
      `GitHub tree for ${formatGitHubRepoSpecifier(repoSpec)}@${ref} is truncated; installation was aborted to avoid partial skill sync.`;
    output.appendLine(message);
    throw new Error(message);
  }

  const entries: Array<{ path: string; type: string }> = [];
  for (const entry of body.tree) {
    if (typeof entry.path !== "string" || typeof entry.type !== "string") {
      continue;
    }

    entries.push({ path: entry.path, type: entry.type });
  }

  return entries;
}

function getRepoSkillFiles(treeEntries: Array<{ path: string; type: string }>, pathPrefix: string): RepoSkillFiles[] {
  const skillDirectories = collectSkillDirectories(treeEntries, pathPrefix);
  if (skillDirectories.length === 0) {
    throw new Error(
      pathPrefix
        ? `No SKILL.md files were found under "${pathPrefix}".`
        : "No SKILL.md files were found in the repository."
    );
  }

  const skills = skillDirectories.map((skillDirectory): RepoSkillFiles => {
    const filePrefix = `${skillDirectory}/`;
    const filePaths = treeEntries
      .filter((entry) => entry.type === "blob" && entry.path.startsWith(filePrefix))
      .map((entry) => entry.path)
      .sort((left, right) => left.localeCompare(right));

    return {
      skillName: getSkillNameFromDirectory(skillDirectory),
      skillDirectory,
      filePaths
    };
  });

  const seen = new Map<string, string>();
  for (const skill of skills) {
    if (!isSafeSkillName(skill.skillName)) {
      throw new Error(`Invalid skill name "${skill.skillName}" found in ${skill.skillDirectory}.`);
    }

    const duplicateSource = seen.get(skill.skillName);
    if (duplicateSource) {
      throw new Error(
        `Duplicate skill name "${skill.skillName}" found in ${duplicateSource} and ${skill.skillDirectory}.`
      );
    }

    seen.set(skill.skillName, skill.skillDirectory);
  }

  return skills.sort((left, right) => left.skillName.localeCompare(right.skillName));
}

async function writeSkillFromRepo(
  destinationRoot: string,
  repoSpec: GitHubRepoSpec,
  ref: string,
  skill: RepoSkillFiles,
  syncSignal: AbortSignal
): Promise<void> {
  throwIfSignalAborted(syncSignal);
  const destinationSkillPath = resolveSkillPathWithinRoot(destinationRoot, skill.skillName);
  const tempSkillPath = path.join(
    destinationRoot,
    `.${skill.skillName}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  const backupSkillPath = path.join(
    destinationRoot,
    `.${skill.skillName}.bak-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );

  await fs.rm(tempSkillPath, { recursive: true, force: true });
  await fs.mkdir(tempSkillPath, { recursive: true });

  let movedExistingToBackup = false;
  let movedTempToDestination = false;
  let rollbackSucceeded = false;

  try {
    const filePrefix = `${skill.skillDirectory}/`;
    for (const repoPath of skill.filePaths) {
      throwIfSignalAborted(syncSignal);
      if (!repoPath.startsWith(filePrefix)) {
        continue;
      }

      const relativePath = repoPath.slice(filePrefix.length);
      const safeSegments = getSafePathSegments(relativePath);
      if (!safeSegments) {
        throw new Error(`Invalid file path in repository: ${repoPath}`);
      }

      const destinationPath = path.join(tempSkillPath, ...safeSegments);
      const destinationParent = path.dirname(destinationPath);
      await fs.mkdir(destinationParent, { recursive: true });

      const fileBytes = await fetchGitHubRawFile(repoSpec, ref, repoPath, syncSignal);
      await fs.writeFile(destinationPath, fileBytes);
    }

    await fs.rm(backupSkillPath, { recursive: true, force: true });
    try {
      await fs.rename(destinationSkillPath, backupSkillPath);
      movedExistingToBackup = true;
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
    }

    await fs.rename(tempSkillPath, destinationSkillPath);
    movedTempToDestination = true;

    if (movedExistingToBackup) {
      await fs.rm(backupSkillPath, { recursive: true, force: true });
    }
  } catch (error) {
    if (!movedTempToDestination && movedExistingToBackup) {
      try {
        await fs.rename(backupSkillPath, destinationSkillPath);
        rollbackSucceeded = true;
      } catch {
        // If rollback fails, the original sync error remains the most actionable signal.
      }
    }
    throw error;
  } finally {
    await fs.rm(tempSkillPath, { recursive: true, force: true });
    if (movedTempToDestination || rollbackSucceeded || !movedExistingToBackup) {
      await fs.rm(backupSkillPath, { recursive: true, force: true });
    }
  }
}

async function fetchGitHubRawFile(
  repoSpec: GitHubRepoSpec,
  ref: string,
  repoPath: string,
  syncSignal: AbortSignal
): Promise<Buffer> {
  const encodedRef = encodeURIComponent(ref);
  const encodedPath = repoPath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const rawUrl = `https://raw.githubusercontent.com/${repoSpec.owner}/${repoSpec.repo}/${encodedRef}/${encodedPath}`;

  const response = await fetch(rawUrl, {
    headers: {
      "User-Agent": "mist-mcp-provider"
    },
    signal: createFetchAbortSignal(syncSignal, GITHUB_FETCH_TIMEOUT_MS)
  });

  if (!response.ok) {
    throw new Error(`Failed to download ${repoPath} (${response.status} ${response.statusText}).`);
  }

  const bytes = await response.arrayBuffer();
  return Buffer.from(bytes);
}

function getSafePathSegments(relativePath: string): string[] | undefined {
  const segments = relativePath.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return undefined;
  }

  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      return undefined;
    }

    if (segment.includes("\\") || segment.includes("\0")) {
      return undefined;
    }
  }

  return segments;
}

function getManagedSkillsState(context: vscode.ExtensionContext, scope: SkillsInstallScope): ManagedSkillsState | undefined {
  const raw = getManagedSkillsStorage(context, scope).get<unknown>(getManagedSkillsStateKey(scope));
  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  const candidate = raw as Partial<ManagedSkillsState>;
  if (
    typeof candidate.repo !== "string" ||
    typeof candidate.ref !== "string" ||
    typeof candidate.pathPrefix !== "string" ||
    !Array.isArray(candidate.installedSkillNames) ||
    typeof candidate.installedAt !== "string"
  ) {
    return undefined;
  }

  const installedSkillNames = candidate.installedSkillNames
    .filter((name): name is string => typeof name === "string")
    .map((name) => name.trim())
    .filter((name) => isSafeSkillName(name));

  return {
    repo: candidate.repo,
    ref: candidate.ref,
    pathPrefix: candidate.pathPrefix,
    installedSkillNames,
    installedAt: candidate.installedAt
  };
}

function getManagedSkillsStateKey(scope: SkillsInstallScope): string {
  return `${MANAGED_SKILLS_STATE_PREFIX}${scope}`;
}

function getManagedSkillsStorage(context: vscode.ExtensionContext, scope: SkillsInstallScope): vscode.Memento {
  return scope === "workspace" ? context.workspaceState : context.globalState;
}

function getManagedSkillScopes(context: vscode.ExtensionContext): SkillsInstallScope[] {
  const scopes: SkillsInstallScope[] = [];
  const workspaceState = getManagedSkillsState(context, "workspace");
  if (workspaceState) {
    scopes.push("workspace");
  }

  const globalState = getManagedSkillsState(context, "global");
  if (globalState) {
    scopes.push("global");
  }

  return scopes;
}

async function promptForSkillsTarget(
  scopes: SkillsInstallScope[],
  options: { title: string; placeHolder: string }
): Promise<SkillsTarget | undefined> {
  const uniqueScopes = Array.from(new Set(scopes));
  const unavailableScopes: SkillsInstallScope[] = [];
  const targets: SkillsTarget[] = [];

  for (const scope of uniqueScopes) {
    const target = resolveSkillsTarget(scope);
    if (!target) {
      unavailableScopes.push(scope);
      continue;
    }

    targets.push(target);
  }

  if (unavailableScopes.includes("workspace")) {
    const message = targets.some((target) => target.scope === "global")
      ? "Workspace scope unavailable (no folder is open); using global scope."
      : "Workspace scope unavailable because no folder is open.";
    vscode.window.showInformationMessage(message);
  }

  if (targets.length === 0) {
    vscode.window.showWarningMessage("No valid destination is available for skills.");
    return undefined;
  }

  if (targets.length === 1) {
    return targets[0];
  }

  const selected = await vscode.window.showQuickPick(
    targets.map((target) => ({
      label: target.scope === "workspace" ? "Workspace" : "Global (User)",
      description: target.displayPath,
      target
    })),
    {
      title: options.title,
      placeHolder: options.placeHolder,
      ignoreFocusOut: true
    }
  );

  return selected?.target;
}

function resolveSkillsTarget(scope: SkillsInstallScope): SkillsTarget | undefined {
  if (scope === "workspace") {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return undefined;
    }

    const destinationRoot = path.join(workspaceFolder.uri.fsPath, ".github", "skills");
    return {
      scope,
      destinationRoot,
      displayPath: destinationRoot
    };
  }

  const destinationRoot = path.join(os.homedir(), ".copilot", "skills");
  return {
    scope,
    destinationRoot,
    displayPath: destinationRoot
  };
}

async function getExistingSkillNames(destinationRoot: string, skillNames: string[]): Promise<string[]> {
  const existing: string[] = [];
  for (const skillName of skillNames) {
    let skillPath: string;
    try {
      skillPath = resolveSkillPathWithinRoot(destinationRoot, skillName);
    } catch {
      continue;
    }

    try {
      const stat = await fs.stat(skillPath);
      if (stat.isDirectory()) {
        existing.push(skillName);
      }
    } catch {
      // Path does not exist.
    }
  }

  return existing;
}

function resolveSkillPathWithinRoot(destinationRoot: string, skillName: string): string {
  if (!isSafeSkillName(skillName)) {
    throw new Error(`Invalid skill name "${skillName}".`);
  }

  const rootPath = path.resolve(destinationRoot);
  const candidatePath = path.resolve(destinationRoot, skillName);
  if (!candidatePath.startsWith(`${rootPath}${path.sep}`)) {
    throw new Error(`Skill name "${skillName}" would escape the destination root.`);
  }

  return candidatePath;
}

function isMissingPathError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as { code?: string };
  return candidate.code === "ENOENT";
}

function throwIfSignalAborted(signal: AbortSignal): void {
  if (!signal.aborted) {
    return;
  }

  const reason = signal.reason;
  if (typeof reason === "string" && reason.trim()) {
    throw new Error(reason);
  }

  if (reason instanceof Error) {
    throw reason;
  }

  throw new Error("Operation cancelled.");
}

function createFetchAbortSignal(syncSignal: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([syncSignal, AbortSignal.timeout(timeoutMs)]);
}

function isUserCancelledSync(signal: AbortSignal): boolean {
  if (!signal.aborted) {
    return false;
  }

  const reason = signal.reason;
  if (typeof reason === "string") {
    return reason === USER_CANCEL_REASON;
  }

  if (reason instanceof Error) {
    return reason.message === USER_CANCEL_REASON;
  }

  return false;
}

async function migrateLegacySettingsIfNeeded(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel
): Promise<void> {
  const profiles = getProfiles(context);
  if (profiles.length > 0) {
    return;
  }

  const legacyToken = await context.secrets.get(LEGACY_TOKEN_SECRET_KEY);
  if (!legacyToken || !legacyToken.trim()) {
    return;
  }

  const normalizedLegacyToken = legacyToken.trim();
  if (!isSafeHeaderValue(normalizedLegacyToken)) {
    output.appendLine("Skipped legacy token migration because the stored value contains invalid characters.");
    await context.secrets.delete(LEGACY_TOKEN_SECRET_KEY);
    vscode.window.showWarningMessage(
      "A legacy Mist MCP token was invalid and has been removed. Reconfigure your token before using MCP."
    );
    return;
  }

  const legacyHost = context.globalState.get<string>(LEGACY_HOST_STATE_KEY);
  const host = legacyHost && isAllowedMistHost(legacyHost) ? legacyHost : DEFAULT_MIST_HOST;
  const migratedProfile: MistProfile = {
    id: "default",
    name: "Default",
    host
  };

  await saveProfiles(context, [migratedProfile]);
  await context.globalState.update(ACTIVE_PROFILE_STATE_KEY, migratedProfile.id);
  await context.secrets.store(getProfileTokenSecretKey(migratedProfile.id), normalizedLegacyToken);
  await context.secrets.delete(LEGACY_TOKEN_SECRET_KEY);
  await context.globalState.update(LEGACY_HOST_STATE_KEY, undefined);
  output.appendLine("Migrated legacy Mist MCP configuration to profile-based settings.");
}

function getActiveProfile(context: vscode.ExtensionContext): MistProfile | undefined {
  const activeProfileId = context.globalState.get<string>(ACTIVE_PROFILE_STATE_KEY);
  if (!activeProfileId) {
    return undefined;
  }

  const profiles = getProfiles(context);
  return profiles.find((profile) => profile.id === activeProfileId);
}

function getServerLabel(context: vscode.ExtensionContext): string {
  const activeProfile = getActiveProfile(context);
  if (!activeProfile) {
    return `${SERVER_LABEL} (No active profile)`;
  }

  return `${SERVER_LABEL} (${activeProfile.name})`;
}

import * as vscode from "vscode";
import {
  DEFAULT_MIST_HOST,
  isAllowedMistHost,
  MIST_HOST_OPTIONS,
  MIST_SERVER_URI
} from "./hosts";
import { createProfileId, getProfileNameValidationError, isSafeHeaderValue } from "./profile-utils";

const PROVIDER_ID = "mist.mcp.provider";
const SERVER_LABEL = "Mist MCP Server";
const LEGACY_TOKEN_SECRET_KEY = "mist.apiToken";
const LEGACY_HOST_STATE_KEY = "mist.hostUrl";
const PROFILES_STATE_KEY = "mist.profiles";
const ACTIVE_PROFILE_STATE_KEY = "mist.activeProfile";
const PROFILE_TOKEN_SECRET_PREFIX = "mist.profileToken.";

interface MistProfile {
  id: string;
  name: string;
  host: string;
}

interface ProfileQuickPickItem extends vscode.QuickPickItem {
  profileId: string;
}

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

      const token = await getOrPromptTokenForProfile(context, profile);
      if (!token) {
        output.appendLine("MCP resolve cancelled: token is missing.");
        vscode.window.showWarningMessage("Mist MCP server was not started because no API token was provided.");
        return undefined;
      }

      server.headers = {
        Authorization: `Bearer ${token}`,
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

  const token = await promptForOptionalToken({
    title: "Mist MCP Token",
    prompt: "Enter a new token or leave empty to keep the existing one"
  });
  if (token) {
    await context.secrets.store(getProfileTokenSecretKey(existingProfile.id), token);
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

  const token = await promptForOptionalToken({
    title: "Mist MCP Profile Token",
    prompt: "Enter a new token or leave empty to keep the existing one"
  });

  let replacedToken = false;
  if (token) {
    await context.secrets.store(getProfileTokenSecretKey(selectedProfile.id), token);
    replacedToken = true;
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
  profile: MistProfile
): Promise<string | undefined> {
  const secretKey = getProfileTokenSecretKey(profile.id);
  const existing = await context.secrets.get(secretKey);
  if (existing) {
    const normalizedExisting = existing.trim();
    if (normalizedExisting && isSafeHeaderValue(normalizedExisting)) {
      return normalizedExisting;
    }

    // Drop invalid legacy/stale values so the user is prompted for a fresh token.
    await context.secrets.delete(secretKey);
    vscode.window.showWarningMessage(
      `The stored token for profile ${profile.name} was invalid and has been removed. Please enter a new token.`
    );
  }

  const token = await promptForToken();
  if (token) {
    await context.secrets.store(secretKey, token);
  }

  return token;
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

async function promptForOptionalToken(options: { title: string; prompt: string }): Promise<string | undefined> {
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

  const normalized = token?.trim();
  if (!normalized) {
    return undefined;
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

    const normalizedName = profile.name.trim();
    const normalizedHost = profile.host.trim();
    if (!normalizedName || !isAllowedMistHost(normalizedHost)) {
      continue;
    }

    profiles.push({
      id: profile.id,
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

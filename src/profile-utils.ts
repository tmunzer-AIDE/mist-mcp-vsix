const RESERVED_PROFILE_NAMES = new Set(["add new profile", "$(add) add new profile"]);
const PROFILE_NAME_MAX_LENGTH = 64;
const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;

let profileIdCounter = 0;

export function createProfileId(name: string): string {
  const normalized = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  const timestamp = Date.now().toString(36);
  profileIdCounter = (profileIdCounter + 1) % 1_679_616;
  const counter = profileIdCounter.toString(36).padStart(4, "0");
  return `${normalized || "profile"}-${timestamp}-${counter}`;
}

export function isSafeHeaderValue(input: string): boolean {
  return !(/[\r\n\x00-\x1F\x7F]/.test(input));
}

export function getProfileNameValidationError(value: string, existingNames: Set<string>): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return "Profile name cannot be empty.";
  }

  if (trimmed.length > PROFILE_NAME_MAX_LENGTH) {
    return `Profile name must be ${PROFILE_NAME_MAX_LENGTH} characters or fewer.`;
  }

  if (!PROFILE_NAME_PATTERN.test(trimmed)) {
    return "Use letters, numbers, spaces, dot, underscore, or hyphen. Name must start with a letter or number.";
  }

  const lowered = trimmed.toLowerCase();
  if (RESERVED_PROFILE_NAMES.has(lowered)) {
    return "This profile name is reserved.";
  }

  if (existingNames.has(lowered)) {
    return "A profile with this name already exists.";
  }

  return undefined;
}

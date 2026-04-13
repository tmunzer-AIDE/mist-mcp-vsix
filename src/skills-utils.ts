export interface GitHubRepoSpec {
  owner: string;
  repo: string;
}

export interface GitHubTreeEntry {
  path: string;
  type: string;
}

const SKILL_FILE_NAME = "SKILL.md";

export function parseGitHubRepoSpecifier(input: string): GitHubRepoSpec | undefined {
  const normalized = input.trim();
  if (!normalized) {
    return undefined;
  }

  const httpsMatch = normalized.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (httpsMatch) {
    return {
      owner: httpsMatch[1],
      repo: httpsMatch[2]
    };
  }

  const sshMatch = normalized.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (sshMatch) {
    return {
      owner: sshMatch[1],
      repo: sshMatch[2]
    };
  }

  const shortMatch = normalized.match(/^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  if (shortMatch) {
    return {
      owner: shortMatch[1],
      repo: shortMatch[2]
    };
  }

  return undefined;
}

export function formatGitHubRepoSpecifier(spec: GitHubRepoSpec): string {
  return `${spec.owner}/${spec.repo}`;
}

export function collectSkillDirectories(entries: GitHubTreeEntry[], prefix?: string): string[] {
  const normalizedPrefix = normalizePrefix(prefix);
  const directories = new Set<string>();

  for (const entry of entries) {
    if (entry.type !== "blob") {
      continue;
    }

    if (!entry.path.endsWith(`/${SKILL_FILE_NAME}`) && entry.path !== SKILL_FILE_NAME) {
      continue;
    }

    if (normalizedPrefix && !isPathInPrefix(entry.path, normalizedPrefix)) {
      continue;
    }

    const parts = entry.path.split("/");
    if (parts.length < 2) {
      continue;
    }

    directories.add(parts.slice(0, -1).join("/"));
  }

  return Array.from(directories).sort((left, right) => left.localeCompare(right));
}

export function getSkillNameFromDirectory(skillDirectory: string): string {
  const parts = skillDirectory.split("/").filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? skillDirectory;
}

export function isSafeSkillName(skillName: string): boolean {
  const normalized = skillName.trim();
  if (!normalized) {
    return false;
  }

  if (normalized === "." || normalized === "..") {
    return false;
  }

  if (normalized.includes("/") || normalized.includes("\\")) {
    return false;
  }

  if (normalized.includes("\0")) {
    return false;
  }

  return true;
}

function normalizePrefix(prefix?: string): string {
  if (!prefix) {
    return "";
  }

  return prefix.trim().replace(/^\/+|\/+$/g, "");
}

function isPathInPrefix(candidatePath: string, prefix: string): boolean {
  return candidatePath === prefix || candidatePath.startsWith(`${prefix}/`);
}
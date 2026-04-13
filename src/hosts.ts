export const MIST_SERVER_URI = "https://mcp.ai.juniper.net/mcp/mist";

export const MIST_HOST_OPTIONS = [
  "https://api.mist.com",
  "https://api.eu.mist.com",
  "https://api.gc1.mist.com",
  "https://api.gc2.mist.com",
  "https://api.gc3.mist.com",
  "https://api.gc4.mist.com",
  "https://api.gc5.mist.com",
  "https://api.gc6.mist.com",
  "https://api.gc7.mist.com",
  "https://api.ac2.mist.com",
  "https://api.ac5.mist.com",
  "https://api.ac6.mist.com"
] as const;

export const DEFAULT_MIST_HOST = "https://api.mist.com";

export function normalizeHost(input: string): string {
  return input.trim();
}

export function isAllowedMistHost(input: string): boolean {
  const normalized = normalizeHost(input);
  return MIST_HOST_OPTIONS.includes(normalized as (typeof MIST_HOST_OPTIONS)[number]);
}

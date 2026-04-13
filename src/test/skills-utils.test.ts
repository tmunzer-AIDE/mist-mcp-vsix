import test from "node:test";
import assert from "node:assert/strict";
import {
  collectSkillDirectories,
  formatGitHubRepoSpecifier,
  getSkillNameFromDirectory,
  isSafeSkillName,
  parseGitHubRepoSpecifier
} from "../skills-utils";

test("parseGitHubRepoSpecifier handles https, ssh, and owner/repo formats", () => {
  assert.deepEqual(parseGitHubRepoSpecifier("https://github.com/tmunzer-AIDE/mist-skills"), {
    owner: "tmunzer-AIDE",
    repo: "mist-skills"
  });
  assert.deepEqual(parseGitHubRepoSpecifier("git@github.com:tmunzer-AIDE/mist-skills.git"), {
    owner: "tmunzer-AIDE",
    repo: "mist-skills"
  });
  assert.deepEqual(parseGitHubRepoSpecifier("tmunzer-AIDE/mist-skills"), {
    owner: "tmunzer-AIDE",
    repo: "mist-skills"
  });
});

test("parseGitHubRepoSpecifier rejects unsupported values", () => {
  assert.equal(parseGitHubRepoSpecifier(""), undefined);
  assert.equal(parseGitHubRepoSpecifier("https://example.com/repo"), undefined);
  assert.equal(parseGitHubRepoSpecifier("mist-skills"), undefined);
});

test("collectSkillDirectories finds directories containing SKILL.md", () => {
  const entries = [
    { path: "skills/network/SKILL.md", type: "blob" },
    { path: "skills/network/references/a.md", type: "blob" },
    { path: "skills/sle/SKILL.md", type: "blob" },
    { path: "README.md", type: "blob" },
    { path: "skills", type: "tree" }
  ];

  assert.deepEqual(collectSkillDirectories(entries), ["skills/network", "skills/sle"]);
  assert.deepEqual(collectSkillDirectories(entries, "skills"), ["skills/network", "skills/sle"]);
  assert.deepEqual(collectSkillDirectories(entries, "skills/network"), ["skills/network"]);
});

test("format and name helpers return stable values", () => {
  assert.equal(formatGitHubRepoSpecifier({ owner: "tmunzer-AIDE", repo: "mist-skills" }), "tmunzer-AIDE/mist-skills");
  assert.equal(getSkillNameFromDirectory("skills/network"), "network");
});

test("isSafeSkillName rejects path traversal and separators", () => {
  assert.equal(isSafeSkillName("network"), true);
  assert.equal(isSafeSkillName(".."), false);
  assert.equal(isSafeSkillName("."), false);
  assert.equal(isSafeSkillName("folder/name"), false);
  assert.equal(isSafeSkillName("folder\\name"), false);
});
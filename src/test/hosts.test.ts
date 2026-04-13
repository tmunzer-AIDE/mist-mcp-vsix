import test from "node:test";
import assert from "node:assert/strict";
import { isAllowedMistHost, normalizeHost } from "../hosts";

test("normalizeHost trims whitespace", () => {
  assert.equal(normalizeHost("  https://api.mist.com  "), "https://api.mist.com");
});

test("isAllowedMistHost accepts known hosts", () => {
  assert.equal(isAllowedMistHost("https://api.mist.com"), true);
  assert.equal(isAllowedMistHost("https://api.eu.mist.com"), true);
});

test("isAllowedMistHost rejects unknown hosts", () => {
  assert.equal(isAllowedMistHost("https://example.com"), false);
});

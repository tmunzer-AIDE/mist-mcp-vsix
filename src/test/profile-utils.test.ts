import test from "node:test";
import assert from "node:assert/strict";
import { createProfileId, getProfileNameValidationError } from "../profile-utils";

test("createProfileId returns unique ids for rapid calls", () => {
  const ids = new Set<string>();
  for (let i = 0; i < 200; i += 1) {
    ids.add(createProfileId("My Profile"));
  }

  assert.equal(ids.size, 200);
});

test("getProfileNameValidationError accepts valid names", () => {
  const existing = new Set<string>(["default"]);
  assert.equal(getProfileNameValidationError("Profile_One-1", existing), undefined);
});

test("getProfileNameValidationError rejects empty and invalid names", () => {
  const existing = new Set<string>();

  assert.equal(getProfileNameValidationError("   ", existing), "Profile name cannot be empty.");
  assert.equal(
    getProfileNameValidationError("invalid/name", existing),
    "Use letters, numbers, spaces, dot, underscore, or hyphen. Name must start with a letter or number."
  );
  assert.equal(
    getProfileNameValidationError("add new profile", existing),
    "This profile name is reserved."
  );
});

test("getProfileNameValidationError rejects duplicates case-insensitively", () => {
  const existing = new Set<string>(["prod profile"]);
  assert.equal(
    getProfileNameValidationError("Prod Profile", existing),
    "A profile with this name already exists."
  );
});

test("getProfileNameValidationError rejects long names", () => {
  const existing = new Set<string>();
  const tooLong = "a".repeat(65);
  assert.equal(
    getProfileNameValidationError(tooLong, existing),
    "Profile name must be 64 characters or fewer."
  );
});

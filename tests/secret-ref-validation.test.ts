import { describe, expect, it } from "vitest";
import {
  isValidSecretRef,
  validateSecretRefFields,
  normalizeSecretRef,
  persistedSecretRef,
  secretIdFromRef,
  withPersistedSecretRefs,
} from "../src/secret-ref-validation.js";

const VALID_UUID = "12f7ed4a-1234-4d0c-9abc-bd58d44d15e1";
const VALID_UUID_2 = "abcdef01-2345-6789-abcd-ef0123456789";

describe("isValidSecretRef", () => {
  it("accepts standard UUIDs in any case", () => {
    expect(isValidSecretRef(VALID_UUID)).toBe(true);
    expect(isValidSecretRef(VALID_UUID.toUpperCase())).toBe(true);
  });

  it("accepts UUIDs with surrounding whitespace", () => {
    expect(isValidSecretRef(`  ${VALID_UUID}  `)).toBe(true);
  });

  it("rejects empty and non-string inputs", () => {
    expect(isValidSecretRef("")).toBe(false);
    expect(isValidSecretRef("   ")).toBe(false);
    expect(isValidSecretRef(undefined)).toBe(false);
    expect(isValidSecretRef(null)).toBe(false);
    expect(isValidSecretRef(123)).toBe(false);
    expect(isValidSecretRef({})).toBe(false);
  });

  it("rejects non-UUID strings (raw tokens, JSON blobs, malformed UUIDs)", () => {
    expect(isValidSecretRef("not-a-uuid")).toBe(false);
    expect(isValidSecretRef("123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11")).toBe(false);
    expect(isValidSecretRef(`{"id":"${VALID_UUID}"}`)).toBe(false);
    expect(isValidSecretRef("12f7ed4a-1234-4d0c-9abc-bd58d44d15e")).toBe(false);
    expect(isValidSecretRef("12f7ed4a12344d0c9abcbd58d44d15e1")).toBe(false);
  });

  it("accepts the object shape current hosts resolve secret refs to", () => {
    expect(isValidSecretRef({ type: "secret_ref", secretId: VALID_UUID })).toBe(true);
  });

  it("accepts the object shape with an optional version", () => {
    expect(isValidSecretRef({ type: "secret_ref", secretId: VALID_UUID, version: 3 })).toBe(true);
  });

  it("rejects object shapes missing the secret_ref discriminant or a valid secretId", () => {
    expect(isValidSecretRef({ secretId: VALID_UUID })).toBe(false);
    expect(isValidSecretRef({ type: "other", secretId: VALID_UUID })).toBe(false);
    expect(isValidSecretRef({ type: "secret_ref", secretId: "not-a-uuid" })).toBe(false);
    expect(isValidSecretRef({ type: "secret_ref" })).toBe(false);
    expect(isValidSecretRef(null)).toBe(false);
  });
});

describe("validateSecretRefFields", () => {
  it("returns no errors when only the required field is set to a valid UUID", () => {
    expect(validateSecretRefFields({ telegramBotTokenRef: VALID_UUID })).toEqual([]);
  });

  it("returns no errors when all three fields are valid UUIDs", () => {
    expect(
      validateSecretRefFields({
        telegramBotTokenRef: VALID_UUID,
        paperclipBoardApiTokenRef: VALID_UUID_2,
        transcriptionApiKeyRef: VALID_UUID,
      }),
    ).toEqual([]);
  });

  it("treats empty strings as missing for optional fields (no error)", () => {
    expect(
      validateSecretRefFields({
        telegramBotTokenRef: VALID_UUID,
        paperclipBoardApiTokenRef: "",
        transcriptionApiKeyRef: "   ",
      }),
    ).toEqual([]);
  });

  it("flags missing required telegramBotTokenRef with the legacy message", () => {
    const errors = validateSecretRefFields({});
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBe("telegramBotTokenRef is required.");
  });

  it("flags non-UUID telegramBotTokenRef with field-specific guidance", () => {
    const errors = validateSecretRefFields({ telegramBotTokenRef: "123456:raw-bot-token" });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("telegramBotTokenRef must be the UUID of a Paperclip secret");
    expect(errors[0]).toContain("POST /api/companies/{id}/secrets");
  });

  it("flags non-UUID values in optional fields too", () => {
    const errors = validateSecretRefFields({
      telegramBotTokenRef: VALID_UUID,
      paperclipBoardApiTokenRef: "sk-not-a-uuid",
      transcriptionApiKeyRef: "another-bad-value",
    });
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("paperclipBoardApiTokenRef must be the UUID");
    expect(errors[1]).toContain("transcriptionApiKeyRef must be the UUID");
  });

  it("truncates long pasted values in error messages to avoid leaking secrets to logs", () => {
    const longSecret = "x".repeat(200);
    const errors = validateSecretRefFields({ telegramBotTokenRef: longSecret });
    expect(errors[0]).toContain("\"xxxxxxxxxxxx…\"");
    expect(errors[0]).not.toContain(longSecret);
  });

  it("describes non-string values by their type rather than echoing them", () => {
    const errors = validateSecretRefFields({
      telegramBotTokenRef: { id: VALID_UUID } as unknown as string,
    });
    expect(errors[0]).toContain("<object>");
  });

  it("returns no errors when the host resolves refs to the secret_ref object shape", () => {
    expect(
      validateSecretRefFields({
        telegramBotTokenRef: { type: "secret_ref", secretId: VALID_UUID },
        paperclipBoardApiTokenRef: { type: "secret_ref", secretId: VALID_UUID_2, version: 1 },
      }),
    ).toEqual([]);
  });
});

describe("normalizeSecretRef", () => {
  it("wraps a bare UUID into the object form the host requires", () => {
    expect(normalizeSecretRef("11111111-2222-4333-8444-555555555555")).toEqual({
      type: "secret_ref",
      secretId: "11111111-2222-4333-8444-555555555555",
    });
  });

  it("passes an already-correct object through unchanged", () => {
    const ref = { type: "secret_ref", secretId: "11111111-2222-4333-8444-555555555555" };
    expect(normalizeSecretRef(ref)).toBe(ref);
  });

  it("rejects values that are not usable refs", () => {
    expect(normalizeSecretRef("not-a-uuid")).toBeNull();
    expect(normalizeSecretRef("")).toBeNull();
    expect(normalizeSecretRef(null)).toBeNull();
    expect(normalizeSecretRef({ type: "other", secretId: "x" })).toBeNull();
  });
});

describe("settings form secret refs", () => {
  it("reads the secret id from a bare UUID or a secret_ref object", () => {
    expect(secretIdFromRef(`  ${VALID_UUID}  `)).toBe(VALID_UUID);
    expect(secretIdFromRef({ type: "secret_ref", secretId: VALID_UUID, version: "latest" })).toBe(VALID_UUID);
    expect(secretIdFromRef({ type: "secret_ref", secretId: VALID_UUID, version: 2 })).toBe(VALID_UUID);
    expect(secretIdFromRef("")).toBe("");
    expect(secretIdFromRef("not-a-uuid")).toBe("");
    expect(secretIdFromRef({ type: "other", secretId: VALID_UUID })).toBe("");
  });

  it("persists a UUID or an unversioned object as latest", () => {
    const expected = { type: "secret_ref", secretId: VALID_UUID, version: "latest" };
    expect(persistedSecretRef(VALID_UUID)).toEqual(expected);
    expect(persistedSecretRef({ type: "secret_ref", secretId: VALID_UUID })).toEqual(expected);
    expect(persistedSecretRef({ type: "secret_ref", secretId: VALID_UUID, version: "latest" })).toEqual(expected);
    expect(persistedSecretRef({ type: "secret_ref", secretId: VALID_UUID, version: 0 })).toEqual(expected);
    expect(persistedSecretRef({ type: "secret_ref", secretId: VALID_UUID, version: "4" })).toEqual(expected);
  });

  it("keeps a numeric version pin already stored on the reference", () => {
    expect(persistedSecretRef({ type: "secret_ref", secretId: VALID_UUID, version: 4 })).toEqual({
      type: "secret_ref",
      secretId: VALID_UUID,
      version: 4,
    });
  });

  it("leaves empty and invalid values empty instead of writing an object", () => {
    expect(persistedSecretRef("")).toBe("");
    expect(persistedSecretRef("   ")).toBe("");
    expect(persistedSecretRef(null)).toBe("");
    expect(persistedSecretRef("raw-bot-token")).toBe("");
  });

  it("rewrites only the three secret-ref fields when saving plugin config", () => {
    const saved = withPersistedSecretRefs({
      telegramBotTokenRef: VALID_UUID,
      paperclipBoardApiTokenRef: { type: "secret_ref", secretId: VALID_UUID_2 },
      transcriptionApiKeyRef: "",
      paperclipPublicUrl: "https://pmo.datactil.com",
    });

    expect(saved.telegramBotTokenRef).toEqual({
      type: "secret_ref",
      secretId: VALID_UUID,
      version: "latest",
    });
    expect(saved.paperclipBoardApiTokenRef).toEqual({
      type: "secret_ref",
      secretId: VALID_UUID_2,
      version: "latest",
    });
    expect(
      withPersistedSecretRefs({
        telegramBotTokenRef: { type: "secret_ref", secretId: VALID_UUID, version: 4 },
        paperclipPublicUrl: "https://pmo.datactil.com",
      }).telegramBotTokenRef,
    ).toEqual({
      type: "secret_ref",
      secretId: VALID_UUID,
      version: 4,
    });
    expect(saved.transcriptionApiKeyRef).toBe("");
    expect(saved.paperclipPublicUrl).toBe("https://pmo.datactil.com");
  });
});

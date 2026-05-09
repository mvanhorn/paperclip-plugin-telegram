import { describe, expect, it } from "vitest";
import { isValidSecretRef, validateSecretRefFields } from "../src/secret-ref-validation.js";

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
});

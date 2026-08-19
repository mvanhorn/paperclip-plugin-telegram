import { describe, it, expect, vi } from "vitest";
import { str, errorMessage } from "../src/coerce.js";

describe("str", () => {
  it("passes strings through unchanged", () => {
    expect(str("hello")).toBe("hello");
  });

  it("stringifies numbers, bigints, and booleans", () => {
    expect(str(42)).toBe("42");
    expect(str(0)).toBe("0");
    expect(str(false)).toBe("false");
    expect(str(10n)).toBe("10");
  });

  it("returns the fallback for null and undefined", () => {
    expect(str(null)).toBe("");
    expect(str(undefined)).toBe("");
    expect(str(null, "fallback")).toBe("fallback");
    expect(str(undefined, "fallback")).toBe("fallback");
  });

  it("returns the fallback instead of '[object Object]' for a plain object", () => {
    expect(str({ nested: "value" })).toBe("");
    expect(str({ nested: "value" }, "n/a")).toBe("n/a");
  });

  it("returns the fallback instead of stringifying an array", () => {
    expect(str([1, 2, 3], "n/a")).toBe("n/a");
  });

  it("logs a warning when a non-primitive is coerced, if a logger is given", () => {
    const warn = vi.fn();
    str({ nested: "value" }, "n/a", { warn });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/non-primitive/i);
  });

  it("does not log when the value is already a primitive", () => {
    const warn = vi.fn();
    str("hello", "", { warn });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("errorMessage", () => {
  it("uses the Error's message", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("stringifies a primitive throw value", () => {
    expect(errorMessage("boom")).toBe("boom");
  });

  it("falls back for a non-Error object throw value instead of '[object Object]'", () => {
    expect(errorMessage({ code: "EBADF" })).toBe("unknown error");
    expect(errorMessage({ code: "EBADF" }, "custom fallback")).toBe("custom fallback");
  });

  it("falls back for null and undefined", () => {
    expect(errorMessage(null)).toBe("unknown error");
    expect(errorMessage(undefined)).toBe("unknown error");
  });
});

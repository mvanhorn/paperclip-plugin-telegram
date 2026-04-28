import { describe, expect, it } from "vitest";
import { resolvePaperclipApiBaseUrl } from "../src/paperclip-api.js";

describe("resolvePaperclipApiBaseUrl", () => {
  it("prefers paperclipPublicUrl when provided", () => {
    expect(resolvePaperclipApiBaseUrl("http://localhost:3100", "https://paperclip.example.com"))
      .toBe("https://paperclip.example.com");
  });

  it("falls back to paperclipBaseUrl when no public URL is configured", () => {
    expect(resolvePaperclipApiBaseUrl("http://localhost:3100", ""))
      .toBe("http://localhost:3100");
  });

  it("normalizes trailing slashes", () => {
    expect(resolvePaperclipApiBaseUrl("http://localhost:3100/", "https://paperclip.example.com/"))
      .toBe("https://paperclip.example.com");
  });
});

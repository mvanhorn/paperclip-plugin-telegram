import { describe, expect, it } from "vitest";
import { checkHttpRequestUrl, validateHostAllowlist } from "../src/http-host-policy.js";

const allow = ["api.example.com", "*.corp.example.org", "svc.example.com:8443"];

describe("checkHttpRequestUrl", () => {
  it("denies everything when the allowlist is empty", () => {
    expect(checkHttpRequestUrl("https://api.example.com/x", []).ok).toBe(false);
  });
  it("allows exact hosts and wildcard subdomains", () => {
    expect(checkHttpRequestUrl("https://api.example.com/v1?a=1", allow).ok).toBe(true);
    expect(checkHttpRequestUrl("https://a.b.corp.example.org/", allow).ok).toBe(true);
    expect(checkHttpRequestUrl("https://API.EXAMPLE.COM./", allow).ok).toBe(true);
  });
  it("wildcard does not match the apex or look-alike hosts", () => {
    expect(checkHttpRequestUrl("https://corp.example.org/", allow).ok).toBe(false);
    expect(checkHttpRequestUrl("https://evilcorp.example.org/", allow).ok).toBe(false);
    expect(checkHttpRequestUrl("https://api.example.com.evil.io/", allow).ok).toBe(false);
  });
  it("rejects http, credentials, and bad URLs", () => {
    expect(checkHttpRequestUrl("http://api.example.com/", allow).ok).toBe(false);
    expect(checkHttpRequestUrl("https://user:pw@api.example.com/", allow).ok).toBe(false);
    expect(checkHttpRequestUrl("https://api.example.com@evil.io/", allow).ok).toBe(false);
    expect(checkHttpRequestUrl("not a url", allow).ok).toBe(false);
    expect(checkHttpRequestUrl("file:///etc/passwd", allow).ok).toBe(false);
  });
  it("requires an explicit port entry for non-default ports", () => {
    expect(checkHttpRequestUrl("https://api.example.com:8443/", allow).ok).toBe(false);
    expect(checkHttpRequestUrl("https://svc.example.com:8443/", allow).ok).toBe(true);
    expect(checkHttpRequestUrl("https://svc.example.com/", allow).ok).toBe(false);
  });
  it("blocks loopback and metadata addresses unless explicitly listed", () => {
    expect(checkHttpRequestUrl("https://localhost/", allow).ok).toBe(false);
    expect(checkHttpRequestUrl("https://169.254.169.254/latest/meta-data", allow).ok).toBe(false);
  });
});

describe("validateHostAllowlist", () => {
  it("accepts valid entries and undefined", () => {
    expect(validateHostAllowlist(undefined)).toEqual([]);
    expect(validateHostAllowlist(allow)).toEqual([]);
  });
  it("rejects schemes, paths, and non-arrays", () => {
    expect(validateHostAllowlist(["https://api.example.com"]).length).toBe(1);
    expect(validateHostAllowlist(["api.example.com/path"]).length).toBe(1);
    expect(validateHostAllowlist("api.example.com").length).toBe(1);
  });
});

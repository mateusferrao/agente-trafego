import { describe, expect, it } from "vitest";
import { buildVerificationEmail, buildAccountExistsEmail, escapeHtml } from "./auth-email.js";

describe("escapeHtml", () => {
  it("escapa caracteres perigosos", () => {
    expect(escapeHtml(`<script>"x"&'y'`)).toBe("&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;");
  });
});

describe("buildVerificationEmail", () => {
  it("inclui o código no texto e no html + categoria auth", () => {
    const msg = buildVerificationEmail({ to: "a@b.co", from: "x@y.co", code: "123456" });
    expect(msg.category).toBe("auth");
    expect(msg.text).toContain("123456");
    expect(msg.html).toContain("123456");
    expect(msg.to).toBe("a@b.co");
  });
});

describe("buildAccountExistsEmail", () => {
  it("aponta pro login e escapa a URL", () => {
    const msg = buildAccountExistsEmail({ to: "a@b.co", from: "x@y.co", appUrl: "http://app" });
    expect(msg.text).toContain("http://app/login");
    expect(msg.html).toContain("http://app/login");
  });
});

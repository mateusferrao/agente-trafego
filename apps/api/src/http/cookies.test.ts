import { describe, expect, it } from "vitest";
import { sealContext, sessionCookieOptions, unsealContext } from "./cookies.js";

const PASSWORD = "x".repeat(32); // iron-session exige ≥32

describe("sealContext / unsealContext", () => {
  it("round-trip preserva o activeOrgId", async () => {
    const sealed = await sealContext({ activeOrgId: "org-1" }, PASSWORD);
    expect(sealed).not.toContain("org-1"); // opaco
    expect(await unsealContext(sealed, PASSWORD)).toEqual({ activeOrgId: "org-1" });
  });

  it("preserva activeOrgId null", async () => {
    const sealed = await sealContext({ activeOrgId: null }, PASSWORD);
    expect(await unsealContext(sealed, PASSWORD)).toEqual({ activeOrgId: null });
  });

  it("cookie ausente → null", async () => {
    expect(await unsealContext(undefined, PASSWORD)).toBeNull();
  });

  it("password errado (adulteração) → null, sem lançar", async () => {
    const sealed = await sealContext({ activeOrgId: "org-1" }, PASSWORD);
    expect(await unsealContext(sealed, "y".repeat(32))).toBeNull();
  });
});

describe("sessionCookieOptions", () => {
  it("secure só em produção; sempre httpOnly + sameSite lax", () => {
    expect(sessionCookieOptions(true)).toMatchObject({ secure: true, httpOnly: true, sameSite: "lax" });
    expect(sessionCookieOptions(false)).toMatchObject({ secure: false, httpOnly: true, path: "/" });
  });
});

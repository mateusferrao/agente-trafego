import { describe, expect, it } from "vitest";
import { sessionCookieOptions } from "./cookies.js";

describe("sessionCookieOptions", () => {
  it("secure só em produção; sempre httpOnly + sameSite lax + path raiz", () => {
    expect(sessionCookieOptions(true)).toMatchObject({ secure: true, httpOnly: true, sameSite: "lax" });
    expect(sessionCookieOptions(false)).toMatchObject({ secure: false, httpOnly: true, path: "/" });
  });
});

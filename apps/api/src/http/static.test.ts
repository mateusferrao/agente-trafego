import { describe, expect, it } from "vitest";
import { isApiPath } from "./static.js";

describe("isApiPath (fallback SPA vs api)", () => {
  it("casa prefixos de api (exato, com barra e com query)", () => {
    for (const u of ["/api", "/api/orgs", "/api?x=1", "/health", "/ready", "/openapi.json", "/webhooks/x"]) {
      expect(isApiPath(u)).toBe(true);
    }
  });

  it("NÃO casa rotas do SPA nem falso-positivo de prefixo", () => {
    for (const u of ["/", "/login", "/accounts", "/apixyz", "/healthz", "/settings"]) {
      expect(isApiPath(u)).toBe(false);
    }
  });
});

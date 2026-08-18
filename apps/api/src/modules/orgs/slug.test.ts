import { describe, expect, it } from "vitest";
import { orgSlug, slugify } from "./slug.js";

describe("slugify", () => {
  it("minúsculo, sem acento, hifeniza", () => {
    expect(slugify("Minha Órg Legal")).toBe("minha-org-legal");
  });
  it("colapsa símbolos e apara as pontas", () => {
    expect(slugify("  Açaí & Cia!!  ")).toBe("acai-cia");
  });
  it("string sem alfanumérico vira vazia", () => {
    expect(slugify("!!! ---")).toBe("");
  });
});

describe("orgSlug", () => {
  it("anexa sufixo hex ao base", () => {
    const s = orgSlug("Minha Org");
    expect(s).toMatch(/^minha-org-[0-9a-f]{6}$/);
  });
  it("cai em 'org' quando o nome não tem alfanumérico", () => {
    expect(orgSlug("###")).toMatch(/^org-[0-9a-f]{6}$/);
  });
  it("dois slugs do mesmo nome diferem (sufixo aleatório)", () => {
    expect(orgSlug("X")).not.toBe(orgSlug("X"));
  });
});

import { describe, expect, it } from "vitest";
import { canonicalizeTargeting } from "./targeting-canonical.js";

describe("canonicalizeTargeting (D4 — comparação estável de público)", () => {
  it("mesma audiência com ARRAYS reordenados → mesma string", () => {
    const a = { geo_locations: { countries: ["BR", "US"] }, interests: [{ id: "2" }, { id: "1" }] };
    const b = { geo_locations: { countries: ["US", "BR"] }, interests: [{ id: "1" }, { id: "2" }] };
    expect(canonicalizeTargeting(a)).toBe(canonicalizeTargeting(b));
  });

  it("mesma audiência com CHAVES em ordem diferente → mesma string", () => {
    const a = { age_min: 18, geo_locations: { countries: ["BR"] } };
    const b = { geo_locations: { countries: ["BR"] }, age_min: 18 };
    expect(canonicalizeTargeting(a)).toBe(canonicalizeTargeting(b));
  });

  it("público REALMENTE diferente → strings diferentes", () => {
    const a = { geo_locations: { countries: ["BR"] } };
    const b = { geo_locations: { countries: ["US"] } };
    expect(canonicalizeTargeting(a)).not.toBe(canonicalizeTargeting(b));
  });

  it("número como string ('18') == número (18) → mesma string (Graph devolve os dois)", () => {
    expect(canonicalizeTargeting({ age_min: "18" })).toBe(canonicalizeTargeting({ age_min: 18 }));
  });

  it("chave vazia/ausente não distingue (array vazio == ausente)", () => {
    expect(canonicalizeTargeting({ geo_locations: { countries: ["BR"] }, interests: [] })).toBe(
      canonicalizeTargeting({ geo_locations: { countries: ["BR"] } }),
    );
  });

  it("null/undefined → mesma string de objeto vazio", () => {
    expect(canonicalizeTargeting(null)).toBe(canonicalizeTargeting({}));
    expect(canonicalizeTargeting(undefined)).toBe(canonicalizeTargeting({}));
  });

  it("adicionar uma dimensão (gênero) → strings diferentes (detecta edição)", () => {
    const before = { geo_locations: { countries: ["BR"] } };
    const after = { geo_locations: { countries: ["BR"] }, genders: [1] };
    expect(canonicalizeTargeting(before)).not.toBe(canonicalizeTargeting(after));
  });
});

import { describe, expect, it } from "vitest";
import { targetingChanged } from "./targeting-canonical.js";

describe("targetingChanged (D4 — drift de público por contenção)", () => {
  it("público IDÊNTICO → não mudou", () => {
    const t = { geo_locations: { countries: ["BR"] }, age_min: 25 };
    expect(targetingChanged(t, t)).toBe(false);
  });

  it("Meta enriqueceu o read-back (campos extras) mas o que escrevemos continua → NÃO é drift", () => {
    // este é o caso que quebraria o happy-path se comparássemos por igualdade.
    const applied = { geo_locations: { countries: ["BR"] }, age_min: 25 };
    const current = {
      geo_locations: { countries: ["BR"], location_types: ["home", "recent"] },
      age_min: 25,
      age_max: 65,
      targeting_automation: { advantage_audience: 0 },
    };
    expect(targetingChanged(current, applied)).toBe(false);
  });

  it("interesse enriquecido com `name` no read-back → NÃO é drift (contido)", () => {
    const applied = { flexible_spec: [{ interests: [{ id: "123" }] }] };
    const current = { flexible_spec: [{ interests: [{ id: "123", name: "Corrida" }] }] };
    expect(targetingChanged(current, applied)).toBe(false);
  });

  it("arrays em ORDEM diferente → NÃO é drift (conjunto)", () => {
    const applied = { geo_locations: { countries: ["BR", "US"] } };
    const current = { geo_locations: { countries: ["US", "BR"] } };
    expect(targetingChanged(current, applied)).toBe(false);
  });

  it("número como string ('18') == número (18) → NÃO é drift", () => {
    expect(targetingChanged({ age_min: 18 }, { age_min: "18" })).toBe(false);
  });

  it("edição concorrente: país trocado (BR→US) → É drift", () => {
    const applied = { geo_locations: { countries: ["BR"] } };
    const current = { geo_locations: { countries: ["US"] } };
    expect(targetingChanged(current, applied)).toBe(true);
  });

  it("edição concorrente: uma cidade que setamos foi removida → É drift", () => {
    const applied = { geo_locations: { countries: ["BR", "US"] } };
    const current = { geo_locations: { countries: ["BR"] } }; // US sumiu
    expect(targetingChanged(current, applied)).toBe(true);
  });

  it("edição concorrente: idade mínima mudada (25→30) → É drift", () => {
    expect(targetingChanged({ age_min: 30 }, { age_min: 25 })).toBe(true);
  });

  it("sem baseline (applied vazio/null) → não bloqueia (fail-open)", () => {
    expect(targetingChanged({ geo_locations: { countries: ["US"] } }, null)).toBe(false);
    expect(targetingChanged({ geo_locations: { countries: ["US"] } }, {})).toBe(false);
  });

  it("current null (Meta não devolveu targeting) mas escrevemos algo → É drift (some do ar)", () => {
    expect(targetingChanged(null, { geo_locations: { countries: ["BR"] } })).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { audienceFromTargeting } from "./meta-audience-map.js";

describe("audienceFromTargeting", () => {
  it("targeting ausente → undefined", () => {
    expect(audienceFromTargeting(undefined)).toBeUndefined();
    expect(audienceFromTargeting({})).toBeUndefined();
  });

  it("só amplo (geo + idade), sem custom audience → prospecção", () => {
    const a = audienceFromTargeting({
      geo_locations: { countries: ["BR"] },
      age_min: 25,
      age_max: 54,
    });
    expect(a).toMatchObject({ stage: "prospecting", customAudienceCount: 0, exclusionCount: 0, geo: ["BR"], ageMin: 25, ageMax: 54 });
  });

  it("flexible_spec → interestGroupRefs/behaviorGroupRefs COM id (Slice 6 — cópia fiel)", () => {
    const a = audienceFromTargeting({
      geo_locations: { countries: ["BR"] },
      flexible_spec: [
        { interests: [{ id: "i1", name: "Estética" }, { id: "i2", name: "Beleza" }] },
        { behaviors: [{ id: "b1", name: "Compradores online" }] },
      ],
    });
    expect(a?.interestGroupRefs).toEqual([[{ id: "i1", name: "Estética" }, { id: "i2", name: "Beleza" }]]);
    expect(a?.behaviorGroupRefs).toEqual([[{ id: "b1", name: "Compradores online" }]]);
  });

  it("captura ids de público salvo incluído/excluído (Slice 9 — cópia fiel de remarketing)", () => {
    const a = audienceFromTargeting({
      custom_audiences: [{ id: "ca1", name: "Engajamento 90d" }],
      excluded_custom_audiences: [{ id: "ca2", name: "Compradores" }],
    });
    expect(a?.customAudienceIncludeIds).toEqual(["ca1"]);
    expect(a?.customAudienceExcludeIds).toEqual(["ca2"]);
  });

  it("custom audience de inclusão não-lookalike → remarketing", () => {
    const a = audienceFromTargeting({
      custom_audiences: [{ id: "1", name: "Visitantes do site 30d" }],
    });
    expect(a?.stage).toBe("remarketing");
    expect(a?.customAudienceCount).toBe(1);
  });

  it("inclusão só de lookalike → prospecção (lookalike é público frio)", () => {
    const a = audienceFromTargeting({
      custom_audiences: [{ id: "2", name: "Lookalike 1% Compradores" }],
    });
    expect(a?.stage).toBe("prospecting");
    expect(a?.customAudienceCount).toBe(1);
  });

  it("mistura lookalike + retarget na inclusão → remarketing (há quente)", () => {
    const a = audienceFromTargeting({
      custom_audiences: [
        { id: "2", name: "LAL 1% site" },
        { id: "3", name: "Engajou no Instagram" },
      ],
    });
    expect(a?.stage).toBe("remarketing");
    expect(a?.customAudienceCount).toBe(2);
  });

  it("conta exclusões e coleta interesses (top-N, dedupe)", () => {
    const a = audienceFromTargeting({
      geo_locations: { countries: ["BR"] },
      excluded_custom_audiences: [{ id: "9", name: "Compradores" }],
      flexible_spec: [{ interests: [{ id: "i1", name: "Estética" }, { id: "i2", name: "Beleza" }] }],
      interests: [{ id: "i1", name: "Estética" }],
    });
    expect(a?.exclusionCount).toBe(1);
    expect(a?.interests).toEqual(["Estética", "Beleza"]);
    expect(a?.stage).toBe("prospecting");
  });

  it("expansion: nenhum dos 3 flags presente → unknown (leitura honesta, não decide nada)", () => {
    const a = audienceFromTargeting({ geo_locations: { countries: ["BR"] } });
    expect(a?.expansion.summary).toBe("unknown");
  });

  it("expansion: advantage_audience=0 explícito e o resto ausente → off (0 explícito conta)", () => {
    const a = audienceFromTargeting({
      geo_locations: { countries: ["BR"] },
      targeting_automation: { advantage_audience: 0 },
    });
    expect(a?.expansion.summary).toBe("off");
  });

  it("expansion: advantage_audience=1 → on", () => {
    const a = audienceFromTargeting({
      geo_locations: { countries: ["BR"] },
      targeting_automation: { advantage_audience: 1 },
    });
    expect(a?.expansion.summary).toBe("on");
  });

  it("expansion: só targeting_relaxation_types.lookalike=1 (advantage_audience ausente) → on", () => {
    const a = audienceFromTargeting({
      geo_locations: { countries: ["BR"] },
      targeting_relaxation_types: { lookalike: 1 },
    });
    expect(a?.expansion.summary).toBe("on");
  });

  it("geoEntries preserva key de cidade/região (nome sozinho não basta pra remontar geo_locations)", () => {
    const a = audienceFromTargeting({
      geo_locations: { cities: [{ key: "2430536", name: "Belo Horizonte" }], regions: [{ key: "3157", name: "Minas Gerais" }] },
    });
    expect(a?.geoEntries).toEqual([
      { key: "3157", name: "Minas Gerais", kind: "region" },
      { key: "2430536", name: "Belo Horizonte", kind: "city" },
    ]);
  });
});

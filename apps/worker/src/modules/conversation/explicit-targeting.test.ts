import { describe, expect, it } from "vitest";
import { assembleExplicitTargeting, hasExplicitContent } from "./explicit-targeting.js";

describe("assembleExplicitTargeting", () => {
  it("sem primitivo/público → geo default BR", () => {
    const t = assembleExplicitTargeting({ geo: [] });
    expect(t.kind).toBe("explicit");
    expect(t.geo).toEqual([{ key: "BR", name: "Brasil", kind: "country" }]);
  });

  it("com áreas por endereço → geo vazio (o raio carrega o alvo, sem unir BR)", () => {
    const t = assembleExplicitTargeting({ geo: [], radiusAreas: [{ address: "Av. X, 100", radius: 5, distanceUnit: "kilometer" }] });
    expect(t.geo).toEqual([]);
    expect(t.radiusAreas).toHaveLength(1);
  });

  it("compõe geo/idade/gênero/interesses/behaviors/públicos no MESMO explicit", () => {
    const t = assembleExplicitTargeting({
      geo: [{ key: "C1", name: "BH", kind: "city" }],
      ageMin: 25,
      ageMax: 45,
      gender: "women",
      interests: [{ id: "i1", name: "A" }],
      behaviors: [{ id: "b1", name: "B" }],
      includeAudienceIds: ["IN"],
      excludeAudienceIds: ["OUT"],
    });
    expect(t.geo).toEqual([{ key: "C1", name: "BH", kind: "city" }]);
    expect(t.ageMin).toBe(25);
    expect(t.genders).toEqual([2]);
    expect(t.interestGroups).toEqual([[{ id: "i1", name: "A" }]]);
    expect(t.behaviorGroups).toEqual([[{ id: "b1", name: "B" }]]);
    expect(t.customAudienceIncludeIds).toEqual(["IN"]);
    expect(t.customAudienceExcludeIds).toEqual(["OUT"]);
  });

  it("gender 'all' não emite genders", () => {
    expect(assembleExplicitTargeting({ geo: [], gender: "all" }).genders).toBeUndefined();
  });

  it("público salvo vazio não emite custom_audiences", () => {
    const t = assembleExplicitTargeting({ geo: [{ key: "BR", name: "Brasil", kind: "country" }], includeAudienceIds: [], excludeAudienceIds: [] });
    expect(t.customAudienceIncludeIds).toBeUndefined();
  });
});

describe("hasExplicitContent", () => {
  it("false quando só geo vazio + gênero all", () => {
    expect(hasExplicitContent({ geo: [], gender: "all" })).toBe(false);
  });
  it("true com qualquer primitivo (idade)", () => {
    expect(hasExplicitContent({ geo: [], ageMin: 30 })).toBe(true);
  });
  it("true com público salvo de exclusão", () => {
    expect(hasExplicitContent({ geo: [], excludeAudienceIds: ["X"] })).toBe(true);
  });
});

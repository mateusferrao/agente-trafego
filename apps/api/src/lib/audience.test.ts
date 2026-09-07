import { describe, expect, it } from "vitest";
import type { ExplicitAudienceInput } from "../modules/drafts/schema.js";
import { buildExplicitFromInput, serializeExplicitAudience } from "./audience.js";

const fullInput: ExplicitAudienceInput = {
  geo: [
    { key: "BR", name: "Brasil", kind: "country" },
    { key: "C1", name: "Belo Horizonte", kind: "city", radius: 20, distanceUnit: "kilometer" },
  ],
  radiusAreas: [{ address: "Av. X, 100", radius: 5, distanceUnit: "kilometer" }],
  ageMin: 25,
  ageMax: 45,
  genders: [2],
  interestGroups: [[{ id: "i1", name: "Corrida" }]],
  behaviorGroups: [[{ id: "b1", name: "Viajantes" }]],
  customAudienceIncludeIds: ["IN"],
  customAudienceExcludeIds: ["OUT"],
};

describe("buildExplicitFromInput", () => {
  it("input do site → explicit neutro (raio de cidade clampado; campos vazios omitidos)", () => {
    const t = buildExplicitFromInput(fullInput);
    expect(t.kind).toBe("explicit");
    expect(t.geo[0]).toEqual({ key: "BR", name: "Brasil", kind: "country" }); // país sem raio
    expect(t.geo[1]).toMatchObject({ key: "C1", kind: "city", distanceUnit: "kilometer" }); // cidade com raio (clampado)
    expect(t.ageMin).toBe(25);
    expect(t.genders).toEqual([2]);
    expect(t.interestGroups).toEqual([[{ id: "i1", name: "Corrida" }]]);
    expect(t.customAudienceIncludeIds).toEqual(["IN"]);
  });

  it("input mínimo (só geo) não emite idade/gênero/grupos/públicos", () => {
    const t = buildExplicitFromInput({ geo: [{ key: "BR", name: "Brasil", kind: "country" }] });
    expect(t.ageMin).toBeUndefined();
    expect(t.genders).toBeUndefined();
    expect(t.interestGroups).toBeUndefined();
    expect(t.customAudienceIncludeIds).toBeUndefined();
  });
});

describe("serializeExplicitAudience", () => {
  it("explicit neutro → view (opcionais normalizados em null)", () => {
    const view = serializeExplicitAudience(buildExplicitFromInput({ geo: [{ key: "BR", name: "Brasil", kind: "country" }] }));
    expect(view.ageMin).toBeNull();
    expect(view.genders).toBeNull();
    expect(view.interestGroups).toEqual([]);
    expect(view.customAudienceIncludeIds).toEqual([]);
    expect(view.geo).toEqual([{ key: "BR", name: "Brasil", kind: "country", radius: null, distanceUnit: null }]);
  });

  it("round-trip: build → serialize preserva as dimensões cheias", () => {
    const view = serializeExplicitAudience(buildExplicitFromInput(fullInput));
    expect(view.ageMin).toBe(25);
    expect(view.ageMax).toBe(45);
    expect(view.genders).toEqual([2]);
    expect(view.interestGroups).toEqual([[{ id: "i1", name: "Corrida" }]]);
    expect(view.behaviorGroups).toEqual([[{ id: "b1", name: "Viajantes" }]]);
    expect(view.customAudienceIncludeIds).toEqual(["IN"]);
    expect(view.customAudienceExcludeIds).toEqual(["OUT"]);
    expect(view.radiusAreas).toHaveLength(1);
  });
});

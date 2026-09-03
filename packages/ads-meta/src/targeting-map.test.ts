import { describe, expect, it } from "vitest";
import type { TargetingSpec } from "@trafego/shared/types";
import { DEFAULT_TARGETING_GEO_COUNTRY, explicitTargetingToRaw, type ExplicitTargeting } from "./targeting-map.js";

function spec(over: Partial<ExplicitTargeting> = {}): ExplicitTargeting {
  return { kind: "explicit", geo: [{ key: "BR", name: "Brasil", kind: "country" }], ...over } as ExplicitTargeting;
}

describe("explicitTargetingToRaw", () => {
  it("geo por país + expansão SEMPRE fechada", () => {
    const raw = explicitTargetingToRaw(spec());
    expect(raw["geo_locations"]).toEqual({ countries: ["BR"] });
    expect(raw["targeting_automation"]).toEqual({ advantage_audience: 0 });
    expect(raw["targeting_relaxation_types"]).toEqual({ custom_audience: 0, lookalike: 0 });
  });

  it("geo vazio → fallback país (Meta rejeita geo_locations vazio)", () => {
    const raw = explicitTargetingToRaw(spec({ geo: [] }));
    expect(raw["geo_locations"]).toEqual({ countries: [DEFAULT_TARGETING_GEO_COUNTRY] });
  });

  it("raio é city-only: region ignora radius, city mantém", () => {
    const raw = explicitTargetingToRaw(
      spec({
        geo: [
          { key: "R1", name: "Região", kind: "region", radius: 20 },
          { key: "C1", name: "Cidade", kind: "city", radius: 15, distanceUnit: "kilometer" },
        ],
      }),
    );
    expect(raw["geo_locations"]).toEqual({
      regions: [{ key: "R1" }],
      cities: [{ key: "C1", radius: 15, distance_unit: "kilometer" }],
    });
  });

  it("idade/gênero/públicos salvos/grupos de interesse compõem no mesmo targeting", () => {
    const raw = explicitTargetingToRaw(
      spec({
        ageMin: 25,
        ageMax: 45,
        genders: [2],
        customAudienceIncludeIds: ["IN"],
        customAudienceExcludeIds: ["OUT"],
        interestGroups: [[{ id: "i1", name: "A" }], [{ id: "i2", name: "B" }]],
      }),
    );
    expect(raw["age_min"]).toBe(25);
    expect(raw["age_max"]).toBe(45);
    expect(raw["genders"]).toEqual([2]);
    expect(raw["custom_audiences"]).toEqual([{ id: "IN" }]);
    expect(raw["excluded_custom_audiences"]).toEqual([{ id: "OUT" }]);
    // 2 grupos → AND narrowing (1 objeto por grupo no flexible_spec).
    expect(raw["flexible_spec"]).toEqual([{ interests: [{ id: "i1" }] }, { interests: [{ id: "i2" }] }]);
  });

  it("aceita a variante explicit de um TargetingSpec neutro (tipo compatível)", () => {
    const neutral: TargetingSpec = spec({ ageMin: 30 });
    if (neutral.kind !== "explicit") throw new Error("unreachable");
    expect(explicitTargetingToRaw(neutral)["age_min"]).toBe(30);
  });
});

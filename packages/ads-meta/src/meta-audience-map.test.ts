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
});

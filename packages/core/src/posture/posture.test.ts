import { describe, expect, it } from "vitest";
import {
  DIDACTIC_DEPTH_LEVELS,
  DIRECTIVENESS_LEVELS,
  EXPERIENCE_LEVELS,
  VOLUME_LEVELS,
  type Posture,
} from "@trafego/shared";
import {
  composePostureBlock,
  experienceCatalog,
  experienceLevelIsCustom,
  experiencePresetDefaults,
  postureCatalog,
  volumeToRecCount,
} from "./index.js";

describe("volumeToRecCount", () => {
  it("mapeia enxuto=1, equilibrado=3, abrangente=5", () => {
    expect(volumeToRecCount("concise")).toBe(1);
    expect(volumeToRecCount("balanced")).toBe(3);
    expect(volumeToRecCount("comprehensive")).toBe(5);
  });
});

describe("experiencePresetDefaults", () => {
  it("iniciante = diretivo + abrangente + didático (mão na roda)", () => {
    expect(experiencePresetDefaults("beginner")).toEqual({
      directiveness: "directive",
      volume: "comprehensive",
      didacticDepth: "explanatory",
    });
  });
  it("intermediário = equilibrado nos três", () => {
    expect(experiencePresetDefaults("intermediate")).toEqual({
      directiveness: "balanced",
      volume: "balanced",
      didacticDepth: "balanced",
    });
  });
  it("avançado = consultivo + enxuto + direto (radar, não ser mandado)", () => {
    expect(experiencePresetDefaults("advanced")).toEqual({
      directiveness: "consultative",
      volume: "concise",
      didacticDepth: "direct",
    });
  });
});

describe("experienceLevelIsCustom", () => {
  it("null (definido pelo arquétipo) nunca é 'personalizado'", () => {
    const p: Posture = { ...experiencePresetDefaults("beginner"), experienceLevel: null };
    expect(experienceLevelIsCustom(p)).toBe(false);
  });
  it("eixos batem o preset → não é personalizado", () => {
    const p: Posture = { ...experiencePresetDefaults("advanced"), experienceLevel: "advanced" };
    expect(experienceLevelIsCustom(p)).toBe(false);
  });
  it("um eixo diverge do preset → personalizado", () => {
    const p: Posture = { ...experiencePresetDefaults("advanced"), volume: "comprehensive", experienceLevel: "advanced" };
    expect(experienceLevelIsCustom(p)).toBe(true);
  });
});

describe("composePostureBlock", () => {
  const posture: Posture = {
    directiveness: "directive",
    volume: "concise",
    didacticDepth: "explanatory",
    experienceLevel: "beginner",
  };

  it("rende 1 linha por eixo, rotulada, e deixa claro que é VOZ (não muda a análise)", () => {
    const block = composePostureBlock(posture);
    expect(block.toLowerCase()).toContain("postura");
    expect(block.toLowerCase()).toContain("não muda a análise");
    // uma linha por eixo (diretividade, volume, profundidade)
    const lines = block.split("\n").filter((l) => l.trim().startsWith("-"));
    expect(lines.length).toBe(3);
  });

  it("o texto reflete o nível escolhido (diretivo assume; didático explica)", () => {
    const block = composePostureBlock(posture).toLowerCase();
    expect(block).toContain("assuma"); // diretivo
    expect(block).toContain("explique"); // didático
  });

  it("consultivo NÃO manda; direto NÃO traduz", () => {
    const block = composePostureBlock({
      directiveness: "consultative",
      volume: "balanced",
      didacticDepth: "direct",
      experienceLevel: "advanced",
    }).toLowerCase();
    expect(block).toContain("devolva a decisão");
    expect(block).toContain("sem explicar");
  });
});

describe("postureCatalog", () => {
  it("expõe os 3 eixos, cada um com todos os níveis e textos amigáveis (PT)", () => {
    const cat = postureCatalog();
    expect(cat.map((a) => a.key)).toEqual(["directiveness", "volume", "didacticDepth"]);
    const byKey = Object.fromEntries(cat.map((a) => [a.key, a]));
    expect(byKey.directiveness!.levels.map((l) => l.level)).toEqual([...DIRECTIVENESS_LEVELS]);
    expect(byKey.volume!.levels.map((l) => l.level)).toEqual([...VOLUME_LEVELS]);
    expect(byKey.didacticDepth!.levels.map((l) => l.level)).toEqual([...DIDACTIC_DEPTH_LEVELS]);
    for (const axis of cat) {
      expect(axis.label.length).toBeGreaterThan(0);
      expect(axis.help.length).toBeGreaterThan(0);
      for (const lvl of axis.levels) {
        expect(lvl.label.length).toBeGreaterThan(0);
        expect(lvl.description.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("experienceCatalog", () => {
  it("expõe os presets com label/description/whenToUse (padrão archetypeCatalog)", () => {
    const cat = experienceCatalog();
    expect(cat.map((e) => e.level)).toEqual([...EXPERIENCE_LEVELS]);
    for (const e of cat) {
      expect(e.label.length).toBeGreaterThan(0);
      expect(e.description.length).toBeGreaterThan(0);
      expect(e.whenToUse.length).toBeGreaterThan(0);
    }
  });
});

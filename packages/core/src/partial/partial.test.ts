import { describe, expect, it } from "vitest";
import { partialNote, partialSeverity } from "./index.js";

describe("partialSeverity", () => {
  it("nenhum motivo → none", () => {
    expect(partialSeverity([])).toBe("none");
  });

  it("métricas/entidades faltando → hard (dado incompleto)", () => {
    expect(partialSeverity(["metrics"])).toBe("hard");
    expect(partialSeverity(["entities"])).toBe("hard");
    expect(partialSeverity(["creative_vision", "metrics"])).toBe("hard");
  });

  it("só criativo/campanha/ação → soft (métricas intactas)", () => {
    expect(partialSeverity(["creative_vision"])).toBe("soft");
    expect(partialSeverity(["campaign_analysis"])).toBe("soft");
    expect(partialSeverity(["action_apply"])).toBe("soft");
    expect(partialSeverity(["creative_vision", "campaign_analysis"])).toBe("soft");
  });
});

describe("partialNote", () => {
  it("none → sem nota", () => {
    expect(partialNote([])).toBeNull();
  });

  it("hard → nota que alerta sobre dado faltando", () => {
    expect(partialNote(["metrics"])).toContain("Análise parcial");
  });

  it("soft → nota suave que garante as métricas completas", () => {
    const note = partialNote(["creative_vision"]);
    expect(note).toContain("métricas vieram completas");
    expect(note).not.toContain("Análise parcial —");
  });
});

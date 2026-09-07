import { describe, expect, it } from "vitest";
import { computeApplyPreview } from "./index.js";

const base = { dryRun: false, killSwitch: false, accountAvailable: true, capabilityEnabled: true, kind: "action" as const };

describe("computeApplyPreview", () => {
  it("tudo ok → real, sem mensagem", () => {
    expect(computeApplyPreview(base)).toEqual({ effect: "real", message: null });
  });
  it("conta indisponível → blocked (prioridade máxima, vence trava)", () => {
    const p = computeApplyPreview({ ...base, accountAvailable: false, killSwitch: true });
    expect(p.effect).toBe("blocked");
    expect(p.message).toContain("indisponível");
  });
  it("kill-switch → blocked", () => {
    expect(computeApplyPreview({ ...base, killSwitch: true }).message).toContain("Trava total");
  });
  it("capacidade off (ação) → blocked com copy de ação", () => {
    expect(computeApplyPreview({ ...base, capabilityEnabled: false }).message).toContain("ações permitidas");
  });
  it("capacidade off (criação) → blocked com copy de criação", () => {
    expect(computeApplyPreview({ ...base, kind: "draft", capabilityEnabled: false }).message).toContain("habilite");
  });
  it("capacidade vence ensaio (ambos) → blocked", () => {
    expect(computeApplyPreview({ ...base, dryRun: true, capabilityEnabled: false }).effect).toBe("blocked");
  });
  it("ensaio (ação) → simulated", () => {
    const p = computeApplyPreview({ ...base, dryRun: true });
    expect(p.effect).toBe("simulated");
    expect(p.message).toContain("simula");
  });
  it("ensaio (criação) → simulated com copy de criação", () => {
    expect(computeApplyPreview({ ...base, kind: "draft", dryRun: true }).message).toContain("simula a criação");
  });
});

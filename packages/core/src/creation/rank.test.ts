import { describe, expect, it } from "vitest";
import type { CreativeAssetRef, PerformanceTier } from "@trafego/shared";
import { rankCreatives, type CreativeCandidate } from "./rank.js";

function ref(id: string, origin: "reuse" | "upload" = "reuse"): CreativeAssetRef {
  return { assetId: id, format: "image", origin };
}

function cand(id: string, over: Partial<CreativeCandidate> = {}): CreativeCandidate {
  return { ref: ref(id), ...over };
}

describe("rankCreatives", () => {
  it("ordena por tier: winner > performer > upload-não-provado > underperformer > zombie", () => {
    const winner = cand("w", { tier: "winner" });
    const performer = cand("p", { tier: "performer" });
    const upload = cand("u", { ref: ref("u", "upload") });
    const under = cand("d", { tier: "underperformer" });
    const zombie = cand("z", { tier: "zombie" });
    const out = rankCreatives([zombie, under, upload, performer, winner]);
    expect(out.map((c) => c.ref.assetId)).toEqual(["w", "p", "u", "d", "z"]);
  });

  it("exclui fatigada quando excludeFatigued", () => {
    const fresh = cand("a", { tier: "performer" });
    const tired = cand("b", { tier: "winner", fatigued: true });
    const out = rankCreatives([tired, fresh], { excludeFatigued: true });
    expect(out.map((c) => c.ref.assetId)).toEqual(["a"]);
  });

  it("prefere mídia não-ativa no desempate (mesmo tier)", () => {
    const active = cand("act", { tier: "winner", active: true });
    const inactive = cand("ina", { tier: "winner", active: false });
    const out = rankCreatives([active, inactive], { preferInactive: true });
    expect(out[0]?.ref.assetId).toBe("ina");
  });

  it("desempata por maior gasto (significância) quando tier e atividade iguais", () => {
    const low = cand("low", { tier: "performer", spendMinor: 100 });
    const high = cand("high", { tier: "performer", spendMinor: 900 });
    const out = rankCreatives([low, high]);
    expect(out[0]?.ref.assetId).toBe("high");
  });

  it("retorna vazio quando não há candidatos", () => {
    expect(rankCreatives([])).toEqual([]);
  });
});

// garante que o tipo PerformanceTier é o reusado (compile-time)
const _tierCheck: PerformanceTier = "winner";
void _tierCheck;

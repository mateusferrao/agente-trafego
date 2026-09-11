import { describe, expect, it } from "vitest";
import type { AdSetAd } from "@trafego/shared/ports";
import { pickAttachTemplate, resolveAdsetChoice } from "./attach-plan.js";

describe("resolveAdsetChoice — 1 usa · >1 pergunta · 0 pergunta", () => {
  it("1 conjunto ativo → usa", () => {
    expect(resolveAdsetChoice([{ adsetId: "A", status: "active" }])).toEqual({ kind: "use", adsetId: "A" });
  });
  it(">1 ativo → pergunta (nunca chuta), só os ativos como opção", () => {
    const d = resolveAdsetChoice([
      { adsetId: "A", status: "active", name: "Frio" },
      { adsetId: "B", status: "active", name: "Quente" },
      { adsetId: "C", status: "paused" },
    ]);
    expect(d.kind).toBe("ask");
    if (d.kind === "ask") expect(d.options.map((o) => o.adsetId)).toEqual(["A", "B"]);
  });
  it("0 ativo (só pausados) → pergunta (não cria conjunto sozinho)", () => {
    expect(resolveAdsetChoice([{ adsetId: "A", status: "paused" }]).kind).toBe("ask_none");
  });
  it("conjunto vazio → pergunta", () => {
    expect(resolveAdsetChoice([]).kind).toBe("ask_none");
  });
});

const ad = (adId: string, format: AdSetAd["format"], status: AdSetAd["status"] = "active"): AdSetAd => ({ adId, format, status });

describe("pickAttachTemplate — preferir mesmo tipo, senão reestrutura, senão pergunta", () => {
  it("vídeo: usa um anúncio de VÍDEO ativo (troca limpa, sem reestruturar)", () => {
    const d = pickAttachTemplate([ad("i", "image"), ad("v", "video")], "video");
    expect(d).toEqual({ kind: "use", templateAdId: "v", restructured: false });
  });
  it("vídeo mas só há molde de IMAGEM → usa e marca restructured (o eco avisa)", () => {
    const d = pickAttachTemplate([ad("i", "image")], "video");
    expect(d).toEqual({ kind: "use", templateAdId: "i", restructured: true });
  });
  it("prefere o molde ATIVO do mesmo tipo sobre um pausado", () => {
    const d = pickAttachTemplate([ad("vp", "video", "paused"), ad("va", "video", "active")], "video");
    expect(d).toEqual({ kind: "use", templateAdId: "va", restructured: false });
  });
  it("só carrossel/catálogo (não reusável) → pergunta o destino", () => {
    expect(pickAttachTemplate([ad("c", "carousel"), ad("k", "catalog")], "video").kind).toBe("ask_destination");
  });
  it("conjunto sem anúncio → pergunta o destino", () => {
    expect(pickAttachTemplate([], "image").kind).toBe("ask_destination");
  });
});

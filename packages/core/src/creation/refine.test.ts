import type { CampaignDraftSpec } from "@trafego/shared";
import { describe, expect, it } from "vitest";
import { advantageAgeConflict, applyDraftEdit, conversionRequiresPixel, flipBudgetLevel, normalizeLinkUrl, removeAdsetsAt, seedAdsetFromSingle } from "./refine.js";
import type { AdsetSpec, TargetingSpec } from "@trafego/shared";

describe("normalizeLinkUrl (URL de destino — fonte única chat+site)", () => {
  it("aceita http/https absoluto (normaliza)", () => {
    expect(normalizeLinkUrl("https://loja.com/promo")).toBe("https://loja.com/promo");
    expect(normalizeLinkUrl("http://loja.com")).toBe("http://loja.com/");
  });
  it("prefixa https:// quando vem só o domínio", () => {
    expect(normalizeLinkUrl("loja.com/promo")).toBe("https://loja.com/promo");
  });
  it("rejeita esquema não-http(s), host sem ponto, frase e vazio", () => {
    expect(normalizeLinkUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeLinkUrl("data:text/html,x")).toBeNull();
    expect(normalizeLinkUrl("ftp://foo.com")).toBeNull();
    expect(normalizeLinkUrl("https://foo")).toBeNull();
    expect(normalizeLinkUrl("meu site")).toBeNull();
    expect(normalizeLinkUrl("")).toBeNull();
    expect(normalizeLinkUrl(null)).toBeNull();
    expect(normalizeLinkUrl(undefined)).toBeNull();
  });
});

const fromScratch: CampaignDraftSpec = {
  version: 1,
  currency: "BRL",
  dailyBudgetMinor: 5000,
  activation: "paused",
  objective: "messaging_started",
  targeting: { kind: "advantage_plus" },
  variantsCount: 2,
  copyVariants: [
    { primaryText: "t1", headline: "h1" },
    { primaryText: "t2", headline: "h2" },
  ],
  creative: { assetId: "a1", format: "video", origin: "reuse", metaVideoId: "v1" },
  pageId: "page_1",
};

const duplicate: CampaignDraftSpec = {
  version: 1,
  currency: "BRL",
  dailyBudgetMinor: 6000,
  activation: "active",
};

const noCap = { hasPixel: true } as const;

describe("conversionRequiresPixel", () => {
  it("venda/lead exigem pixel; mensagem/app_install não", () => {
    expect(conversionRequiresPixel("purchase")).toBe(true);
    expect(conversionRequiresPixel("lead")).toBe(true);
    expect(conversionRequiresPixel("messaging_started")).toBe(false);
    expect(conversionRequiresPixel("app_install")).toBe(false);
  });
});

describe("advantageAgeConflict — idade fixa × otimização automática (§8: dono decide)", () => {
  const explicit = (age: { ageMin?: number; ageMax?: number }): TargetingSpec => ({ kind: "explicit", geo: [], ...age });

  it("advantage OFF → nunca conflita (a idade fixa é honrada normalmente)", () => {
    expect(advantageAgeConflict({ targeting: explicit({ ageMin: 45, ageMax: 65 }) }, false)).toBe(false);
  });
  it("advantage ON + piso acima da faixa (45+) → conflita (o caso real do log)", () => {
    expect(advantageAgeConflict({ targeting: explicit({ ageMin: 45 }) }, true)).toBe(true);
  });
  it("advantage ON + teto acima da faixa (até 65) → conflita", () => {
    expect(advantageAgeConflict({ targeting: explicit({ ageMax: 65 }) }, true)).toBe(true);
  });
  it("advantage ON + idade dentro de 18-25 → NÃO conflita (a Meta trava nessa faixa)", () => {
    expect(advantageAgeConflict({ targeting: explicit({ ageMin: 18, ageMax: 24 }) }, true)).toBe(false);
  });
  it("advantage ON + sem idade explícita (advantage_plus) → não conflita", () => {
    expect(advantageAgeConflict({ targeting: { kind: "advantage_plus" } }, true)).toBe(false);
  });
  it("multi-conjunto: conflita se QUALQUER conjunto tem idade acima da faixa sob advantage", () => {
    const adsets: readonly AdsetSpec[] = [
      { name: "A", targeting: { kind: "advantage_plus" } },
      { name: "B", targeting: explicit({ ageMin: 45 }) },
    ];
    expect(advantageAgeConflict({ adsets }, true)).toBe(true);
  });
});

describe("applyDraftEdit — merge puro do rascunho", () => {
  it("from_scratch: edita nomes + ativação e mantém o resto", () => {
    const r = applyDraftEdit("from_scratch", fromScratch, { campaignName: "Nova", adsetName: "Conj", activation: "active" }, noCap);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.spec.campaignName).toBe("Nova");
    expect(r.value.spec.adsetName).toBe("Conj");
    expect(r.value.spec.activation).toBe("active");
    expect(r.value.spec.creative).toEqual(fromScratch.creative);
  });

  it("from_scratch: budget é clampado ao teto e sinaliza corte", () => {
    const r = applyDraftEdit("from_scratch", fromScratch, { budgetMinor: 20000 }, { hasPixel: true, budgetCapMinor: 10000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.spec.dailyBudgetMinor).toBe(10000);
    expect(r.value.clampedByCap).toBe(true);
  });

  it("from_scratch: edição sem clamp LIMPA um requestedDailyBudgetMinor de clamp anterior", () => {
    // spec já veio de um clamp anterior (pediu 150, virou 100); agora o usuário edita p/ 50 (< teto).
    const clamped: CampaignDraftSpec = { ...fromScratch, dailyBudgetMinor: 10000, requestedDailyBudgetMinor: 15000 };
    const r = applyDraftEdit("from_scratch", clamped, { budgetMinor: 5000 }, { hasPixel: true, budgetCapMinor: 10000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.spec.dailyBudgetMinor).toBe(5000);
    expect(r.value.clampedByCap).toBe(false);
    expect(r.value.spec.requestedDailyBudgetMinor).toBeUndefined(); // não mostra "reduzido de" falso
  });

  it("from_scratch: objetivo que exige pixel SEM pixel → erro", () => {
    const r = applyDraftEdit("from_scratch", fromScratch, { objective: "purchase" }, { hasPixel: false });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("objective_requires_pixel");
  });

  it("from_scratch: objetivo que exige pixel COM pixel → ok, grava objetivo + pixelId", () => {
    const r = applyDraftEdit("from_scratch", fromScratch, { objective: "purchase", pixelId: "PX9" }, { hasPixel: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.spec.objective).toBe("purchase");
    expect(r.value.spec.pixelId).toBe("PX9");
  });

  it("duplicate: tentar editar pixelId → erro field_not_editable", () => {
    const r = applyDraftEdit("duplicate", duplicate, { pixelId: "PX9" }, noCap);
    expect(r.ok).toBe(false);
  });

  it("from_scratch: objetivo que NÃO exige pixel sem pixel → ok", () => {
    const r = applyDraftEdit("from_scratch", fromScratch, { objective: "app_install" }, { hasPixel: false });
    expect(r.ok).toBe(true);
  });

  it("from_scratch: copyVariants vazio → erro (mín 1)", () => {
    const r = applyDraftEdit("from_scratch", fromScratch, { copyVariants: [] }, noCap);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("empty_variants");
  });

  it("duplicate: edita budget/ativação/suffixLabel", () => {
    const r = applyDraftEdit("duplicate", duplicate, { budgetMinor: 7000, activation: "paused", suffixLabel: "escala 2" }, noCap);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.spec.dailyBudgetMinor).toBe(7000);
    expect(r.value.spec.activation).toBe("paused");
    expect(r.value.spec.suffixLabel).toBe("escala 2");
  });

  it("duplicate: tentar editar objetivo/nome → erro field_not_editable", () => {
    const r = applyDraftEdit("duplicate", duplicate, { objective: "purchase" }, noCap);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("field_not_editable");
  });

  it("from_scratch: linkUrl (destino do anúncio) grava no spec", () => {
    const site: CampaignDraftSpec = { ...fromScratch, objective: "purchase" };
    const r = applyDraftEdit("from_scratch", site, { linkUrl: "https://loja.com/promo" }, noCap);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.spec.linkUrl).toBe("https://loja.com/promo");
  });

  it("from_scratch: virar o objetivo pra WhatsApp LIMPA o link obsoleto (gate único §7)", () => {
    const site: CampaignDraftSpec = { ...fromScratch, objective: "purchase", linkUrl: "https://loja.com/promo" };
    const r = applyDraftEdit("from_scratch", site, { objective: "messaging_started" }, noCap);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.spec.objective).toBe("messaging_started");
    expect(r.value.spec.linkUrl).toBeUndefined();
  });

  it("duplicate: linkUrl é from_scratch-only → erro field_not_editable (escala herda o destino)", () => {
    const r = applyDraftEdit("duplicate", duplicate, { linkUrl: "https://loja.com/promo" }, noCap);
    expect(r.ok).toBe(false);
    if (r.ok || r.error.code !== "field_not_editable") throw new Error("esperava field_not_editable");
    expect(r.error.field).toBe("linkUrl");
  });

  it("from_scratch: pageId (Página de destino, W2) grava no spec", () => {
    const r = applyDraftEdit("from_scratch", fromScratch, { pageId: "PAGE_B" }, noCap);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.spec.pageId).toBe("PAGE_B");
  });

  it("duplicate: pageId é from_scratch-only → erro field_not_editable (escala herda a Página)", () => {
    const r = applyDraftEdit("duplicate", duplicate, { pageId: "PAGE_B" }, noCap);
    expect(r.ok).toBe(false);
    if (r.ok || r.error.code !== "field_not_editable") throw new Error("esperava field_not_editable");
    expect(r.error.field).toBe("pageId");
  });
});

describe("applyDraftEdit — C2 multi-conjunto (adsets, substituição total)", () => {
  const noCap = { hasPixel: true } as const;
  const two = [
    { name: "A", targeting: { kind: "advantage_plus" as const } },
    { name: "B", targeting: { kind: "advantage_plus" as const }, dailyBudgetMinor: 4000 },
  ];

  it("substitui os conjuntos (multi) e preserva o resto do spec", () => {
    const r = applyDraftEdit("from_scratch", fromScratch, { adsets: two }, noCap);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("esperava ok");
    expect(r.value.spec.adsets).toHaveLength(2);
    expect(r.value.spec.adsets?.[1]?.dailyBudgetMinor).toBe(4000);
    expect(r.value.spec.copyVariants).toHaveLength(2); // criativo/copy do rascunho intactos
  });

  it("lista vazia limpa os conjuntos (volta a single-conjunto)", () => {
    const withAdsets = { ...fromScratch, adsets: two };
    const r = applyDraftEdit("from_scratch", withAdsets, { adsets: [] }, noCap);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("esperava ok");
    expect(r.value.spec.adsets).toBeUndefined();
  });

  it("não editar adsets preserva os existentes", () => {
    const withAdsets = { ...fromScratch, adsets: two };
    const r = applyDraftEdit("from_scratch", withAdsets, { budgetMinor: 6000 }, noCap);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("esperava ok");
    expect(r.value.spec.adsets).toHaveLength(2);
  });

  it("adsets é from_scratch-only → erro em duplicate", () => {
    const r = applyDraftEdit("duplicate", duplicate, { adsets: two }, noCap);
    expect(r.ok).toBe(false);
    if (r.ok || r.error.code !== "field_not_editable") throw new Error("esperava field_not_editable");
    expect(r.error.field).toBe("adsets");
  });

  it("budgetMode (P2 conversão single→multi) grava no spec junto com adsets", () => {
    const r = applyDraftEdit("from_scratch", fromScratch, { adsets: two, budgetMode: "cbo" }, noCap);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("esperava ok");
    expect(r.value.spec.adsets).toHaveLength(2);
    expect(r.value.spec.budgetMode).toBe("cbo");
  });
});

describe("flipBudgetLevel (F1b — mover a verba ao trocar CBO↔ABO)", () => {
  const two: readonly AdsetSpec[] = [
    { name: "A", targeting: { kind: "advantage_plus" } },
    { name: "B", targeting: { kind: "advantage_plus" } },
  ];

  it("CBO→ABO: cada conjunto ganha o diário da campanha (verba POR conjunto, gasto sobe ~N×)", () => {
    const r = flipBudgetLevel(two, "abo", 10000);
    expect(r.campaignDailyMinor).toBe(10000);
    expect(r.adsets.map((a) => a.dailyBudgetMinor)).toEqual([10000, 10000]);
  });

  it("CBO→ABO: preserva um diário por-conjunto já existente (não sobrescreve)", () => {
    const mixed: readonly AdsetSpec[] = [{ name: "A", targeting: { kind: "advantage_plus" }, dailyBudgetMinor: 8000 }, two[1]!];
    const r = flipBudgetLevel(mixed, "abo", 10000);
    expect(r.adsets[0]?.dailyBudgetMinor).toBe(8000); // mantém
    expect(r.adsets[1]?.dailyBudgetMinor).toBe(10000); // herda o diário da campanha pro que não tinha
  });

  it("ABO→CBO: soma os diários dos conjuntos na campanha e limpa o per-conjunto", () => {
    const abo: readonly AdsetSpec[] = [
      { name: "A", targeting: { kind: "advantage_plus" }, dailyBudgetMinor: 3000 },
      { name: "B", targeting: { kind: "advantage_plus" }, dailyBudgetMinor: 4000 },
    ];
    const r = flipBudgetLevel(abo, "cbo", 5000);
    expect(r.campaignDailyMinor).toBe(7000); // soma preserva o gasto
    expect(r.adsets.every((a) => a.dailyBudgetMinor === undefined)).toBe(true);
  });

  it("ABO→CBO sem diários por-conjunto → mantém o diário da campanha", () => {
    const r = flipBudgetLevel(two, "cbo", 6000);
    expect(r.campaignDailyMinor).toBe(6000);
    expect(r.adsets.every((a) => a.dailyBudgetMinor === undefined)).toBe(true);
  });
});

describe("applyDraftEdit — F1b flip de budgetMode num rascunho multi-conjunto", () => {
  const noCap = { hasPixel: true } as const;
  const twoCbo: CampaignDraftSpec = {
    ...fromScratch,
    dailyBudgetMinor: 10000,
    budgetMode: "cbo",
    adsets: [
      { name: "A", targeting: { kind: "advantage_plus" } },
      { name: "B", targeting: { kind: "advantage_plus" } },
    ],
  };

  it("CBO→ABO: seta o diário por conjunto (verba POR conjunto — evita o campo vazio no apply)", () => {
    const r = applyDraftEdit("from_scratch", twoCbo, { budgetMode: "abo" }, noCap);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("esperava ok");
    expect(r.value.spec.budgetMode).toBe("abo");
    expect(r.value.spec.adsets?.map((a) => a.dailyBudgetMinor)).toEqual([10000, 10000]);
  });

  it("ABO→CBO: limpa o per-conjunto e consolida na campanha", () => {
    const twoAbo: CampaignDraftSpec = {
      ...twoCbo,
      budgetMode: "abo",
      adsets: [
        { name: "A", targeting: { kind: "advantage_plus" }, dailyBudgetMinor: 3000 },
        { name: "B", targeting: { kind: "advantage_plus" }, dailyBudgetMinor: 4000 },
      ],
    };
    const r = applyDraftEdit("from_scratch", twoAbo, { budgetMode: "cbo" }, noCap);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("esperava ok");
    expect(r.value.spec.budgetMode).toBe("cbo");
    expect(r.value.spec.dailyBudgetMinor).toBe(7000);
    expect(r.value.spec.adsets?.every((a) => a.dailyBudgetMinor === undefined)).toBe(true);
  });

  it("guardrail: CBO→ABO com budget acima do teto → cada conjunto é clampado ao teto (não fura)", () => {
    // budget + flip juntos: o apply ABO usa o diário do conjunto DIRETO (não re-clampa) → o core
    // precisa clampar cada conjunto, senão o teto de gasto novo é furado por conjunto.
    const r = applyDraftEdit("from_scratch", twoCbo, { budgetMode: "abo", budgetMinor: 99999 }, { hasPixel: true, budgetCapMinor: 10000 });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("esperava ok");
    expect(r.value.spec.adsets?.every((a) => a.dailyBudgetMinor === 10000)).toBe(true);
    expect(r.value.clampedByCap).toBe(true);
  });

  it("mesmo budgetMode (sem flip) NÃO mexe nos diários dos conjuntos", () => {
    const r = applyDraftEdit("from_scratch", twoCbo, { budgetMode: "cbo" }, noCap);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("esperava ok");
    expect(r.value.spec.adsets?.every((a) => a.dailyBudgetMinor === undefined)).toBe(true);
  });
});

describe("applyDraftEdit — F1a Advantage editável no rascunho pendente", () => {
  const noCap = { hasPixel: true } as const;

  it("liga Advantage (audience + criativo) no rascunho", () => {
    const r = applyDraftEdit("from_scratch", fromScratch, { advantageAudience: true, advantageCreative: true }, noCap);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("esperava ok");
    expect(r.value.spec.advantageAudience).toBe(true);
    expect(r.value.spec.advantageCreative).toBe(true);
  });

  it("desliga Advantage (false grava explicitamente, não some)", () => {
    const withAdvantage = { ...fromScratch, advantageAudience: true, advantageCreative: true };
    const r = applyDraftEdit("from_scratch", withAdvantage, { advantageAudience: false, advantageCreative: false }, noCap);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("esperava ok");
    expect(r.value.spec.advantageAudience).toBe(false);
    expect(r.value.spec.advantageCreative).toBe(false);
  });

  it("não editar Advantage preserva o valor existente", () => {
    const withAdvantage = { ...fromScratch, advantageAudience: true, advantageCreative: true };
    const r = applyDraftEdit("from_scratch", withAdvantage, { budgetMinor: 6000 }, noCap);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("esperava ok");
    expect(r.value.spec.advantageAudience).toBe(true);
    expect(r.value.spec.advantageCreative).toBe(true);
  });

  it("Advantage é from_scratch-only → erro em duplicate (escala herda da fonte)", () => {
    const r = applyDraftEdit("duplicate", duplicate, { advantageAudience: true }, noCap);
    expect(r.ok).toBe(false);
    if (r.ok || r.error.code !== "field_not_editable") throw new Error("esperava field_not_editable");
    expect(r.error.field).toBe("advantageAudience");
  });
});

describe("removeAdsetsAt (P2 — remover conjunto por índice)", () => {
  const abc: readonly AdsetSpec[] = [
    { name: "A", targeting: { kind: "advantage_plus" } },
    { name: "B", targeting: { kind: "advantage_plus" } },
    { name: "C", targeting: { kind: "advantage_plus" } },
  ];
  it("remove pelo índice, preservando a ordem dos restantes", () => {
    expect(removeAdsetsAt(abc, [1]).map((a) => a.name)).toEqual(["A", "C"]);
    expect(removeAdsetsAt(abc, [0, 2]).map((a) => a.name)).toEqual(["B"]);
  });
  it("índices fora da faixa e repetidos são ignorados", () => {
    expect(removeAdsetsAt(abc, [9, 1, 1]).map((a) => a.name)).toEqual(["A", "C"]);
  });
  it("lista vazia de índices → mantém tudo", () => {
    expect(removeAdsetsAt(abc, [])).toHaveLength(3);
  });
});

describe("seedAdsetFromSingle (P2 — converter 1 conjunto em teste multi-conjunto)", () => {
  it("leva nome + público explícito atuais pro conjunto 1", () => {
    const seeded = seedAdsetFromSingle({
      adsetName: "Meu público",
      targeting: { kind: "explicit", geo: [{ key: "BR", name: "Brasil", kind: "country" }] },
    });
    expect(seeded.name).toBe("Meu público");
    expect(seeded.targeting).toEqual({ kind: "explicit", geo: [{ key: "BR", name: "Brasil", kind: "country" }] });
  });
  it("público ausente → advantage_plus explícito (amplo honesto), sem nome", () => {
    const seeded = seedAdsetFromSingle({});
    expect(seeded.targeting).toEqual({ kind: "advantage_plus" });
    expect(seeded.name).toBeUndefined();
  });
});

import { describe, expect, it, vi } from "vitest";
import { adjustAdCount, audienceEchoPhrase, buildRefineEcho, buildResolvedSnapshot, chooseCreative, clampNewBudget, describeExplicitAudience, describeResolvedAudience, resolveCreationTargeting } from "./draft-proposal.js";
import type { CampaignDraftSpec } from "@trafego/shared";
import { creativeContentHash } from "../vision/resolver.js";
import type { WorkerDeps } from "../../composition.js";
import type { AudienceProfile } from "@trafego/shared";

const REF = { adAccountId: "act_1", accessToken: "tok" };
/** Estratégia default = comportamento de hoje (reusa o melhor veiculando; senão biblioteca). */
const BEST_PERFORMING = { mode: "serving", servingPick: "best_performing" } as const;

/** deps.db falso p/ o caminho de RECÊNCIA (sem match): 1º SELECT = libs (orderBy→limit) devolve
 *  `libRows`; 2º SELECT = visões cacheadas (where awaitável) → vazio (describeLibraryCandidates
 *  sempre consulta visão agora). */
function fakeDeps(libRows: unknown[]) {
  let call = 0;
  const db = {
    select: () => {
      call += 1;
      if (call === 1) return { from: () => ({ where: () => ({ orderBy: () => ({ limit: () => libRows }) }) }) };
      return { from: () => ({ where: () => [] as unknown[] }) };
    },
  };
  return { db, visionAnalyzerVersion: 1 } as unknown as WorkerDeps;
}

/** deps.db falso p/ o caminho CONTEXT-AWARE (com match): 1º SELECT = libs (orderBy→limit),
 *  2º SELECT = visões cacheadas (where awaitável). `llm.completeStructured` devolve o índice. */
function fakeDepsWithMatch(libRows: unknown[], visionRows: unknown[], pickIndex: number) {
  let call = 0;
  const db = {
    select: () => {
      call += 1;
      if (call === 1) return { from: () => ({ where: () => ({ orderBy: () => ({ limit: () => libRows }) }) }) };
      return { from: () => ({ where: () => visionRows }) }; // vision query (await direto)
    },
  };
  const llm = { completeStructured: vi.fn(async () => ({ output: { index: pickIndex }, usage: { inputTokens: 0, outputTokens: 0 } })) };
  return { deps: { db, visionAnalyzerVersion: 1, ports: { llm } } as unknown as WorkerDeps, llm };
}

const ORG = "o1";
const ACC = "a1";
const MATCH = { goal: "lead", businessContext: "clínica", guidance: null, model: "m" };

describe("chooseCreative (pool único: veiculando + biblioteca)", () => {
  it("criativo VEICULANDO presente → escolhe o veiculado (provado), NÃO consulta biblioteca", async () => {
    const select = vi.fn();
    const deps = { db: { select } } as unknown as WorkerDeps;
    const out = await chooseCreative(deps, ORG, ACC, REF, { imageHash: "H", sourceAdId: "ad_1" }, BEST_PERFORMING);
    expect(out).toEqual({ imageHash: "H", assetId: "ad_1", origin: "reuse", source: "serving" });
    expect(select).not.toHaveBeenCalled();
  });

  it("SEM veiculando, sem match → biblioteca por recência (mais recente)", async () => {
    const deps = fakeDeps([{ id: "asset_9", imageHash: "HLIB", videoId: null }]);
    const out = await chooseCreative(deps, ORG, ACC, REF, {}, BEST_PERFORMING);
    expect(out).toEqual({ imageHash: "HLIB", assetId: "asset_9", origin: "upload", source: "library" });
  });

  it("SEM veiculando + vídeo na biblioteca → usa metaVideoId", async () => {
    const deps = fakeDeps([{ id: "asset_v", imageHash: null, videoId: "VID1" }]);
    const out = await chooseCreative(deps, ORG, ACC, REF, {}, BEST_PERFORMING);
    expect(out).toEqual({ videoId: "VID1", assetId: "asset_v", origin: "upload", source: "library" });
  });

  it("SEM veiculando + biblioteca vazia → null", async () => {
    expect(await chooseCreative(fakeDeps([]), ORG, ACC, REF, {}, BEST_PERFORMING)).toBeNull();
  });

  it("CONTEXT-AWARE: com match + descrições, o matcher escolhe pelo CONTEXTO (não recência)", async () => {
    // 2 uploads (a=mais recente, b=mais antigo); o matcher (LLM) escolhe index 1 = 'b' pelo contexto.
    const { deps, llm } = fakeDepsWithMatch(
      [
        { id: "a", imageHash: "HA", videoId: null },
        { id: "b", imageHash: "HB", videoId: null },
      ],
      // as visões precisam de descrição p/ virarem candidatos (summary não-vazio) + hash casando
      // o contentHash estável de cada asset (senão descByHash não acha → cairia na recência):
      [
        { hash: creativeContentHash("a", undefined), result: { summary: "desc a" } },
        { hash: creativeContentHash("b", undefined), result: { summary: "desc b" } },
      ],
      1,
    );
    const out = await chooseCreative(deps, ORG, ACC, REF, {}, BEST_PERFORMING, MATCH);
    expect(llm.completeStructured).toHaveBeenCalledOnce(); // consultou o contexto
    expect(out?.assetId).toBe("b"); // escolheu pelo contexto (index 1), não a recência (a)
    expect(out?.source).toBe("library");
  });

  it("veiculando em vídeo → escolhe o vídeo veiculado", async () => {
    const deps = { db: { select: vi.fn() } } as unknown as WorkerDeps;
    const out = await chooseCreative(deps, ORG, ACC, REF, { videoId: "SVID", sourceAdId: "ad_2" }, BEST_PERFORMING);
    expect(out).toEqual({ videoId: "SVID", assetId: "ad_2", origin: "reuse", source: "serving" });
  });
});

describe("resolveCreationTargeting (público da campanha criada do zero)", () => {
  it("com adset vencedor real → herda o público provado (reuse_adset), não Advantage+ amplo", () => {
    expect(resolveCreationTargeting({ sourceAdsetId: "AS_WINNER" })).toEqual({
      kind: "reuse_adset",
      sourceAdsetId: "AS_WINNER",
    });
  });

  it("cold-start (sem adset vencedor) → cai em Advantage+ (não há público provado pra herdar)", () => {
    expect(resolveCreationTargeting({})).toEqual({ kind: "advantage_plus" });
  });
});

describe("audienceEchoPhrase (P0: eco não pode contradizer o targeting real)", () => {
  it("targetingKind=reuse_adset → NÃO diz 'amplo (Advantage+)' (bug fixado)", () => {
    const phrase = audienceEchoPhrase({ targetingKind: "reuse_adset" });
    expect(phrase).not.toContain("amplo");
    expect(phrase).toBe("herdado do conjunto que já converte");
  });

  it("targetingKind=advantage_plus → amplo (Advantage+)", () => {
    expect(audienceEchoPhrase({ targetingKind: "advantage_plus" })).toBe("amplo (Advantage+)");
  });

  it("targetingKind=explicit → usa a descrição explícita (público salvo entra aqui pós-colapso)", () => {
    expect(audienceEchoPhrase({ targetingKind: "explicit", explicitAudienceDescription: "Brasil, + público salvo indicado" })).toBe(
      "Brasil, + público salvo indicado",
    );
  });

  it("reuse_adset COM resolvedAudienceDescription → mostra o público real, não o genérico", () => {
    const phrase = audienceEchoPhrase({
      targetingKind: "reuse_adset",
      resolvedAudienceDescription: "Belo Horizonte, Contagem, Ibirité, 35-64 anos, sem expansão de público",
    });
    expect(phrase).toBe("herda o conjunto que já converte — Belo Horizonte, Contagem, Ibirité, 35-64 anos, sem expansão de público");
  });
});

describe("buildResolvedSnapshot / describeResolvedAudience (P0.2/P1 — público real no propose)", () => {
  const profileWith = (over: Partial<AudienceProfile>): AudienceProfile => ({
    stage: "prospecting",
    customAudienceCount: 0,
    exclusionCount: 0,
    expansion: { summary: "unknown" },
    ...over,
  });

  it("expansão ausente na fonte → snapshot fecha os 3 flags em 0 (nunca herda expansão às cegas)", () => {
    const snap = buildResolvedSnapshot(profileWith({}));
    expect(snap.expansionRaw).toEqual({ advantageAudience: 0, relaxCustomAudience: 0, relaxLookalike: 0 });
  });

  it("expansão ligada explícita na fonte → snapshot respeita (não força pra 0)", () => {
    const snap = buildResolvedSnapshot(profileWith({ expansion: { summary: "on", advantageAudience: 1, relaxCustomAudience: 0, relaxLookalike: 0 } }));
    expect(snap.expansionRaw.advantageAudience).toBe(1);
  });

  it("geoEntries (cidades) → snapshot.geo.cities com key preservado", () => {
    const snap = buildResolvedSnapshot(profileWith({ geoEntries: [{ key: "2430536", name: "Belo Horizonte", kind: "city" }] }));
    expect(snap.geo).toEqual({ cities: [{ key: "2430536", name: "Belo Horizonte" }] });
  });

  it("sem geoEntries mas com geo (países) → snapshot.geo.countries", () => {
    const snap = buildResolvedSnapshot(profileWith({ geo: ["BR"] }));
    expect(snap.geo).toEqual({ countries: ["BR"] });
  });

  it("describeResolvedAudience: cidades + idade + expansão fechada — eco honesto (P0.2)", () => {
    const desc = describeResolvedAudience(
      profileWith({
        geoEntries: [
          { key: "1", name: "Belo Horizonte", kind: "city" },
          { key: "2", name: "Contagem", kind: "city" },
          { key: "3", name: "Ibirité", kind: "city" },
          { key: "4", name: "Betim", kind: "city" },
        ],
        ageMin: 35,
        ageMax: 64,
      }),
    );
    expect(desc).toBe("Belo Horizonte, Contagem, Ibirité (+1 cidades), 35-64 anos, sem expansão de público");
  });

  it("describeResolvedAudience: expansão ligada explícita → avisa no texto", () => {
    const desc = describeResolvedAudience(profileWith({ expansion: { summary: "on", advantageAudience: 1 } }));
    expect(desc).toContain("expansão de público ligada");
  });
});

describe("clampNewBudget (teto de gasto novo — criar E escalar)", () => {
  it("pediu acima do teto → corta e sinaliza clampedByCap (transparência 'pediu X virou Y')", () => {
    expect(clampNewBudget(10000, 3000)).toEqual({ dailyBudgetMinor: 3000, clampedByCap: true });
  });

  it("pediu dentro do teto → passa sem clamp", () => {
    expect(clampNewBudget(2000, 3000)).toEqual({ dailyBudgetMinor: 2000, clampedByCap: false });
  });

  it("exatamente no teto → não conta como clamp", () => {
    expect(clampNewBudget(3000, 3000)).toEqual({ dailyBudgetMinor: 3000, clampedByCap: false });
  });

  it("sem teto configurado → nunca clampa", () => {
    expect(clampNewBudget(999999, null)).toEqual({ dailyBudgetMinor: 999999, clampedByCap: false });
    expect(clampNewBudget(999999, undefined)).toEqual({ dailyBudgetMinor: 999999, clampedByCap: false });
  });
});

describe("describeExplicitAudience (Fase 1, subfatia 3a)", () => {
  it("cidades + idade + gênero — eco completo, sempre 'sem expansão de público'", () => {
    const desc = describeExplicitAudience({
      kind: "explicit",
      geo: [
        { key: "1", name: "Belo Horizonte", kind: "city" },
        { key: "2", name: "Contagem", kind: "city" },
      ],
      ageMin: 25,
      ageMax: 45,
      genders: [2],
    });
    expect(desc).toBe("Belo Horizonte, Contagem, 25-45 anos, mulheres, sem expansão de público");
  });

  it("sem idade/gênero (só geo) → só geo + expansão", () => {
    expect(describeExplicitAudience({ kind: "explicit", geo: [{ key: "BR", name: "Brasil", kind: "country" }] })).toBe(
      "Brasil, sem expansão de público",
    );
  });

  it("com público salvo composto (customAudienceIncludeIds) → menciona a composição", () => {
    const desc = describeExplicitAudience({
      kind: "explicit",
      geo: [{ key: "1", name: "São Paulo", kind: "city" }],
      customAudienceIncludeIds: ["ca_1"],
      customAudienceExcludeIds: [],
    });
    expect(desc).toContain("+ público salvo indicado");
  });

  it("genders com [1,2] (ambos explícitos) → não rotula gênero (equivale a 'todos')", () => {
    const desc = describeExplicitAudience({ kind: "explicit", geo: [{ key: "BR", name: "Brasil", kind: "country" }], genders: [1, 2] });
    expect(desc).not.toContain("homens");
    expect(desc).not.toContain("mulheres");
  });

  it("1 grupo de interesses → 'A ou B' no eco", () => {
    const desc = describeExplicitAudience({
      kind: "explicit",
      geo: [{ key: "BR", name: "Brasil", kind: "country" }],
      interestGroups: [[{ id: "i1", name: "Estética" }, { id: "i2", name: "Pets" }]],
    });
    expect(desc).toContain("interesses: Estética ou Pets");
  });

  it("2 grupos (AND narrowing) → 'A e B' no eco", () => {
    const desc = describeExplicitAudience({
      kind: "explicit",
      geo: [{ key: "BR", name: "Brasil", kind: "country" }],
      interestGroups: [[{ id: "i1", name: "Estética" }], [{ id: "i2", name: "Luxo" }]],
    });
    expect(desc).toContain("interesses: Estética e Luxo");
  });

  it("sem interesses → não menciona 'interesses' no eco", () => {
    const desc = describeExplicitAudience({ kind: "explicit", geo: [{ key: "BR", name: "Brasil", kind: "country" }] });
    expect(desc).not.toContain("interesses");
  });
});

describe("buildRefineEcho — público (bug: refino não pode assumir 'amplo')", () => {
  const base: CampaignDraftSpec = {
    version: 1,
    currency: "BRL",
    dailyBudgetMinor: 5000,
    activation: "active",
    objective: "lead",
    variantsCount: 1,
    copyVariants: [],
    creative: { assetId: "a1", format: "image", origin: "reuse" },
    pageId: "P1",
  };

  it("rascunho EXPLICIT → descreve o público real (não 'amplo')", () => {
    const echo = buildRefineEcho("from_scratch", {
      ...base,
      targeting: { kind: "explicit", geo: [{ key: "1", name: "Belo Horizonte", kind: "city" }], ageMin: 25, ageMax: 45 },
    });
    expect(echo).toContain("Belo Horizonte");
    expect(echo).not.toContain("a Meta escolhe (mais amplo)");
  });

  it("rascunho ADVANTAGE_PLUS → aí sim 'amplo'", () => {
    const echo = buildRefineEcho("from_scratch", { ...base, targeting: { kind: "advantage_plus" } });
    expect(echo).toContain("amplo (Advantage+)");
  });

  it("rascunho REUSE_ADSET → 'herda o que já converte', nunca 'amplo'", () => {
    const echo = buildRefineEcho("from_scratch", { ...base, targeting: { kind: "reuse_adset", sourceAdsetId: "as_1" } });
    expect(echo).toContain("herda");
    expect(echo).not.toContain("amplo");
  });
});


describe("adjustAdCount (nº de anúncios preservando os existentes)", () => {
  const v = (h: string): { primaryText: string; headline: string } => ({ primaryText: `p-${h}`, headline: h });

  it("aumentar DUPLICA o último (preserva os existentes)", () => {
    const out = adjustAdCount([v("a"), v("b")], 4);
    expect(out.map((x) => x.headline)).toEqual(["a", "b", "b", "b"]);
  });

  it("diminuir CORTA os últimos (mín 1)", () => {
    expect(adjustAdCount([v("a"), v("b"), v("c")], 1).map((x) => x.headline)).toEqual(["a"]);
    expect(adjustAdCount([v("a"), v("b")], 0)).toHaveLength(1);
  });

  it("clampa no teto (MAX_ADS_PER_DRAFT = 10)", () => {
    expect(adjustAdCount([v("a")], 999)).toHaveLength(10);
  });

  it("igual → sem mudança", () => {
    const src = [v("a"), v("b")];
    expect(adjustAdCount(src, 2).map((x) => x.headline)).toEqual(["a", "b"]);
  });
});

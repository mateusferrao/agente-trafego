import { describe, expect, it, vi } from "vitest";
import { adjustAdCount, assignCreativesToVariants, audienceEchoPhrase, buildCreativePool, cleanPageQuery, composeCreatives, creativeRefOf, describeCopiesBlock, buildRefineEcho, buildResolvedSnapshot, chooseCreative, clampNewBudget, describeExplicitAudience, describeResolvedAudience, fillDistinctCreatives, filterByMedia, hasOfflineCover, interleaveMedia, matchPagesByQuery, normalizeAdCount, pageChoiceLabel, recoverOpenDraft, resolveCreationTargeting, resolveCreativeFill, resolveProposedExplicitTargeting, scaleForbiddenRefineField, stripGeoQualifier, describeConjuntosBlock, patchTouchesSinglePublico, patchHasNonLinkAction, mergeSegmentPublico } from "./draft-proposal.js";
import type { PageInfo } from "@trafego/shared";
import type { CopyVariant } from "@trafego/shared";
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
  const llm = {
    completeStructured: vi.fn(async (_req: { messages: Array<{ role: string; content: string }> }) => ({
      output: { index: pickIndex },
      usage: { inputTokens: 0, outputTokens: 0 },
    })),
  };
  return { deps: { db, visionAnalyzerVersion: 1, ports: { llm } } as unknown as WorkerDeps, llm };
}

const ORG = "o1";
const ACC = "a1";
const AGENT = "ag1";
const MATCH = { goal: "lead", businessContext: "clínica", guidance: null, model: "m" };

/** deps.db falso encadeado por PASSO (cada chamada `select()` consome o próximo passo):
 *  `limit` = query `.where().limit(n)` (ex: lookup de ad_creatives); `orderByLimit` = query
 *  `.where().orderBy().limit(n)` (ex: biblioteca por recência); `direct` = query awaitada sem
 *  limit/orderBy (ex: entity_analyses/visão cacheada). */
function fakeDepsSeq(steps: ReadonlyArray<{ limit?: unknown[]; orderByLimit?: unknown[]; direct?: unknown[] }>) {
  let call = 0;
  const db = {
    select: () => {
      const step = steps[call] ?? {};
      call += 1;
      return {
        from: () => ({
          where: () => {
            if (step.orderByLimit !== undefined) return { orderBy: () => ({ limit: () => step.orderByLimit }) };
            if (step.limit !== undefined) return { limit: () => step.limit };
            return step.direct ?? [];
          },
        }),
      };
    },
  };
  return { db, visionAnalyzerVersion: 1 } as unknown as WorkerDeps;
}

describe("chooseCreative (pool único: veiculando + biblioteca)", () => {
  it("criativo VEICULANDO presente, sem sinal de fadiga → escolhe o veiculado (provado)", async () => {
    const deps = fakeDepsSeq([
      { limit: [{ campaignId: "C1", adsetId: "AS1" }] }, // ad_creatives: campanha/adset do anúncio-fonte
      { direct: [{ curatedJson: { isCBO: true, healthSignals: [] } }] }, // entity_analyses: sem creative_fatigue
    ]);
    const out = (await chooseCreative(deps, ORG, ACC, AGENT, REF, { imageHash: "H", sourceAdId: "ad_1" }, BEST_PERFORMING)).creative;
    expect(out).toEqual({ imageHash: "H", assetId: "ad_1", origin: "reuse", source: "serving" });
  });

  it("criativo VEICULANDO fatigado (campanha/adset com creative_fatigue) → NÃO reusa, cai pra biblioteca (gap real corrigido)", async () => {
    const deps = fakeDepsSeq([
      { limit: [{ campaignId: "C1", adsetId: "AS1" }] },
      { direct: [{ curatedJson: { isCBO: true, healthSignals: ["creative_fatigue"] } }] },
      { orderByLimit: [{ id: "asset_9", imageHash: "HLIB", videoId: null }] }, // biblioteca por recência
      { direct: [] }, // visão cacheada (vazia)
    ]);
    const out = (await chooseCreative(deps, ORG, ACC, AGENT, REF, { imageHash: "H", sourceAdId: "ad_1" }, BEST_PERFORMING)).creative;
    expect(out).toEqual({ imageHash: "HLIB", assetId: "asset_9", origin: "upload", source: "library" });
  });

  it("SEM veiculando, sem match → biblioteca por recência (mais recente)", async () => {
    const deps = fakeDeps([{ id: "asset_9", imageHash: "HLIB", videoId: null }]);
    const out = (await chooseCreative(deps, ORG, ACC, AGENT, REF, {}, BEST_PERFORMING)).creative;
    expect(out).toEqual({ imageHash: "HLIB", assetId: "asset_9", origin: "upload", source: "library" });
  });

  it("SEM veiculando + vídeo na biblioteca → usa metaVideoId", async () => {
    const deps = fakeDeps([{ id: "asset_v", imageHash: null, videoId: "VID1" }]);
    const out = (await chooseCreative(deps, ORG, ACC, AGENT, REF, {}, BEST_PERFORMING)).creative;
    expect(out).toEqual({ videoId: "VID1", assetId: "asset_v", origin: "upload", source: "library" });
  });

  it("SEM veiculando + biblioteca vazia → null", async () => {
    expect((await chooseCreative(fakeDeps([]), ORG, ACC, AGENT, REF, {}, BEST_PERFORMING)).creative).toBeNull();
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
    const out = (await chooseCreative(deps, ORG, ACC, AGENT, REF, {}, BEST_PERFORMING, MATCH)).creative;
    expect(llm.completeStructured).toHaveBeenCalledOnce(); // consultou o contexto
    expect(out?.assetId).toBe("b"); // escolheu pelo contexto (index 1), não a recência (a)
    expect(out?.source).toBe("library");
  });

  it("S4c — sinais de qualidade da visão (proofStrength/persuasionSignals/weaknesses) chegam ao matcher", async () => {
    const { deps, llm } = fakeDepsWithMatch(
      [
        { id: "a", imageHash: "HA", videoId: null },
        { id: "b", imageHash: "HB", videoId: null },
      ],
      [
        { hash: creativeContentHash("a", undefined), result: { summary: "desc a" } },
        {
          hash: creativeContentHash("b", undefined),
          result: { summary: "desc b", proofStrength: "strong", persuasionSignals: 5, weaknesses: ["CTA fraco"] },
        },
      ],
      1,
    );
    await chooseCreative(deps, ORG, ACC, AGENT, REF, {}, BEST_PERFORMING, MATCH);
    const sent = llm.completeStructured.mock.calls[0]![0].messages[1]!.content;
    expect(sent).toContain("prova: strong");
    expect(sent).toContain("persuasão: 5/7");
    expect(sent).toContain("CTA fraco");
  });

  it("veiculando em vídeo, sem fadiga → escolhe o vídeo veiculado", async () => {
    const deps = fakeDepsSeq([{ limit: [{ campaignId: "C2", adsetId: "AS2" }] }, { direct: [{ curatedJson: { isCBO: true, healthSignals: [] } }] }]);
    const out = (await chooseCreative(deps, ORG, ACC, AGENT, REF, { videoId: "SVID", sourceAdId: "ad_2" }, BEST_PERFORMING)).creative;
    expect(out).toEqual({ videoId: "SVID", assetId: "ad_2", origin: "reuse", source: "serving" });
  });

  it("S3 — vencedor de estágio OPOSTO (prospecção → campanha de remarketing) NÃO herda automático, cai pra biblioteca", async () => {
    // o anúncio-fonte rodou em público FRIO (prospecting); a campanha nova é remarketing (match.campaignStage).
    const deps = fakeDepsSeq([
      { limit: [{ campaignId: "C1", adsetId: "AS1" }] },
      { direct: [{ entityId: "AS1", curatedJson: { isCBO: true, healthSignals: [], audience: { stage: "prospecting" } } }] },
      { orderByLimit: [{ id: "asset_9", imageHash: "HLIB", videoId: null }] },
      { direct: [] }, // visão cacheada vazia → cai na recência da biblioteca
    ]);
    const out = (await chooseCreative(deps, ORG, ACC, AGENT, REF, { imageHash: "H", sourceAdId: "ad_1" }, BEST_PERFORMING, { ...MATCH, campaignStage: "remarketing" })).creative;
    expect(out).toEqual({ imageHash: "HLIB", assetId: "asset_9", origin: "upload", source: "library" });
  });

  it("S3 — vencedor do MESMO estágio (remarketing → campanha de remarketing) é herdado normalmente", async () => {
    const deps = fakeDepsSeq([
      { limit: [{ campaignId: "C1", adsetId: "AS1" }] },
      { direct: [{ entityId: "AS1", curatedJson: { isCBO: true, healthSignals: [], audience: { stage: "remarketing" } } }] },
    ]);
    const out = (await chooseCreative(deps, ORG, ACC, AGENT, REF, { imageHash: "H", sourceAdId: "ad_1" }, BEST_PERFORMING, { ...MATCH, campaignStage: "remarketing" })).creative;
    expect(out).toEqual({ imageHash: "H", assetId: "ad_1", origin: "reuse", source: "serving" });
  });

  it("S3 — estágio da campanha desconhecido (unknown) → nunca demote (neutro), herda o vencedor", async () => {
    const deps = fakeDepsSeq([
      { limit: [{ campaignId: "C1", adsetId: "AS1" }] },
      { direct: [{ entityId: "AS1", curatedJson: { isCBO: true, healthSignals: [], audience: { stage: "prospecting" } } }] },
    ]);
    const out = (await chooseCreative(deps, ORG, ACC, AGENT, REF, { imageHash: "H", sourceAdId: "ad_1" }, BEST_PERFORMING, { ...MATCH, campaignStage: "unknown" })).creative;
    expect(out).toEqual({ imageHash: "H", assetId: "ad_1", origin: "reuse", source: "serving" });
  });

  it("S5 — vencedor AGING (ainda entrega) NÃO é rebaixado, mas volta com crítica caveat (prepare o próximo)", async () => {
    const deps = fakeDepsSeq([
      { limit: [{ campaignId: "C1", adsetId: "AS1" }] },
      { direct: [{ entityId: "AS1", curatedJson: { isCBO: true, healthSignals: ["creative_aging"] } }] },
    ]);
    const outcome = await chooseCreative(deps, ORG, ACC, AGENT, REF, { imageHash: "H", sourceAdId: "ad_1" }, BEST_PERFORMING);
    expect(outcome.creative).toEqual({ imageHash: "H", assetId: "ad_1", origin: "reuse", source: "serving" });
    expect(outcome.critique.verdict).toBe("caveat");
    expect(outcome.critique.reason).toBe("aging_winner");
    expect(outcome.critique.ressalva?.code).toBe("weak_creative_pick");
  });

  it("S5 — aging + sinal DURO juntos (weak_hook) → a dura vence: REBAIXA pra biblioteca (não caveat brando)", async () => {
    const deps = fakeDepsSeq([
      { limit: [{ campaignId: "C1", adsetId: "AS1" }] },
      { direct: [{ entityId: "AS1", curatedJson: { isCBO: true, healthSignals: ["creative_aging", "weak_hook_retention"] } }] },
      { orderByLimit: [{ id: "asset_9", imageHash: "HLIB", videoId: null }] },
      { direct: [] },
    ]);
    const outcome = await chooseCreative(deps, ORG, ACC, AGENT, REF, { imageHash: "H", sourceAdId: "ad_1" }, BEST_PERFORMING);
    expect(outcome.creative).toEqual({ imageHash: "HLIB", assetId: "asset_9", origin: "upload", source: "library" });
  });

  it("S5 — pick provado limpo → crítica solid (sem ressalva, respeita o fluxo)", async () => {
    const deps = fakeDepsSeq([
      { limit: [{ campaignId: "C1", adsetId: "AS1" }] },
      { direct: [{ entityId: "AS1", curatedJson: { isCBO: true, healthSignals: [] } }] },
    ]);
    const outcome = await chooseCreative(deps, ORG, ACC, AGENT, REF, { imageHash: "H", sourceAdId: "ad_1" }, BEST_PERFORMING);
    expect(outcome.critique.verdict).toBe("solid");
    expect(outcome.critique.ressalva).toBeUndefined();
  });
});

describe("hasOfflineCover (capa conhecida offline p/ montar anúncio de vídeo)", () => {
  it("imagem → true (imageHash é a capa)", () => {
    expect(hasOfflineCover({ imageHash: "H", assetId: "a", origin: "upload", source: "library" })).toBe(true);
  });
  it("vídeo com capa guardada → true", () => {
    expect(hasOfflineCover({ videoId: "V", imageHash: "H", assetId: "a", origin: "upload", source: "library" })).toBe(true);
  });
  it("vídeo SEM capa guardada → false (o apply resolve a capa ao vivo)", () => {
    expect(hasOfflineCover({ videoId: "V", assetId: "a", origin: "upload", source: "library" })).toBe(false);
  });
});

describe("buildCreativePool — vídeo da biblioteca sem capa: escolha explícita × auto-fill (diz×faz)", () => {
  const LIBRARY = { mode: "library" } as const;
  /** deps p/ describeLibraryCandidates: 1º SELECT = libs (orderBy→limit); 2º = visões (where direto). */
  const depsLib = (libRows: unknown[], visionRows: unknown[] = []) => fakeDepsSeq([{ orderByLimit: libRows }, { direct: visionRows }]);

  it("ESCOLHA explícita (includeCoverlessVideo) → o vídeo da biblioteca SEM capa entra no pool (picável)", async () => {
    const deps = depsLib([{ id: "vlib", imageHash: null, videoId: "VID9" }]);
    const pool = await buildCreativePool(deps, ORG, ACC, REF, LIBRARY, { includeCoverlessVideo: true });
    expect(pool.map((c) => c.ref)).toContainEqual({ videoId: "VID9", assetId: "vlib", origin: "upload", source: "library" });
  });

  it("AUTO-fill (default) → o mesmo vídeo SEM capa é excluído (não arrisca padding que dependa de fetch)", async () => {
    const deps = depsLib([{ id: "vlib", imageHash: null, videoId: "VID9" }]);
    const pool = await buildCreativePool(deps, ORG, ACC, REF, LIBRARY);
    expect(pool).toEqual([]); // dropado: video sem imageHash
  });

  it("vídeo COM capa entra nos dois modos (montável offline)", async () => {
    const row = [{ id: "vlib", imageHash: "COVER", videoId: "VID9" }];
    expect((await buildCreativePool(depsLib(row), ORG, ACC, REF, LIBRARY)).map((c) => c.ref)).toContainEqual({
      videoId: "VID9",
      imageHash: "COVER",
      assetId: "vlib",
      origin: "upload",
      source: "library",
    });
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
    // G13: honesto — "que está rodando", não "que já converte" (a fonte é rankeada, pode não converter).
    expect(phrase).toBe("herdado do conjunto que está rodando");
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
    expect(phrase).toBe("herda o público do conjunto que está rodando — Belo Horizonte, Contagem, Ibirité, 35-64 anos, sem expansão de público");
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

  it("idade SEM teto (45+) → '45+ anos', nunca '45-?'", () => {
    const desc = describeExplicitAudience({ kind: "explicit", geo: [{ key: "1", name: "Belo Horizonte", kind: "city" }], ageMin: 45, genders: [2] });
    expect(desc).toContain("45+ anos");
    expect(desc).not.toContain("45-?");
    expect(desc).toBe("Belo Horizonte, 45+ anos, mulheres, sem expansão de público");
  });

  it("idade SÓ com teto → 'até X anos'", () => {
    expect(describeExplicitAudience({ kind: "explicit", geo: [{ key: "BR", name: "Brasil", kind: "country" }], ageMax: 30 })).toBe(
      "Brasil, até 30 anos, sem expansão de público",
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

  it("P2: rascunho MULTI-CONJUNTO → lista os conjuntos + onde a verba mora (não o público único)", () => {
    const echo = buildRefineEcho("from_scratch", {
      ...base,
      budgetMode: "cbo",
      targeting: { kind: "advantage_plus" }, // targeting único NÃO deve ser ecoado num rascunho multi
      adsets: [
        { name: "Corredores", targeting: { kind: "explicit", geo: [{ key: "1", name: "Belo Horizonte", kind: "city" }] } },
        { name: "Ciclistas", targeting: { kind: "advantage_plus" } },
      ],
    });
    expect(echo).toContain("Teste de público, **2 conjuntos**");
    expect(echo).toContain("Corredores");
    expect(echo).toContain("Ciclistas");
    expect(echo).toContain("único na campanha");
  });

  it("F1a: rascunho com Advantage LIGADO → avisa que a Meta pode alterar imagem/texto", () => {
    const echo = buildRefineEcho("from_scratch", { ...base, advantageAudience: true, advantageCreative: true });
    expect(echo).toContain("Advantage ligado");
    expect(echo.toLowerCase()).toContain("imagem");
  });

  it("F1a: rascunho com Advantage DESLIGADO → confirma público/criativo fixos", () => {
    const echo = buildRefineEcho("from_scratch", { ...base, advantageAudience: false, advantageCreative: false });
    expect(echo).toContain("Advantage desligado");
  });

  it("F1a: rascunho sem sinal de Advantage → não fala de Advantage", () => {
    const echo = buildRefineEcho("from_scratch", { ...base });
    expect(echo).not.toContain("Advantage ligado");
    expect(echo).not.toContain("Advantage desligado");
  });
});

describe("describeConjuntosBlock (fonte única do eco de conjuntos — create + refino)", () => {
  it("lista nome + público resumido de cada conjunto; advantage → 'amplo'", () => {
    const out = describeConjuntosBlock([
      { name: "A", targeting: { kind: "explicit", geo: [{ key: "1", name: "Belo Horizonte", kind: "city" }] } },
      { name: "B", targeting: { kind: "advantage_plus" } },
    ]);
    expect(out).toContain("**2 conjuntos**");
    expect(out).toContain("1. *A*");
    expect(out).toContain("Belo Horizonte");
    expect(out).toContain("2. *B*");
    expect(out).toContain("amplo (a Meta escolhe)");
  });
});

describe("mergeSegmentPublico — P7 público completo por conjunto (segmento sobre a base)", () => {
  it("segmento sobrepõe por campo; ausente herda a base", () => {
    const base = { geo: ["Belo Horizonte"], gender: "women" as const, ageMin: 18 };
    // "mulheres 45+": só idade própria → herda geo/gênero da base.
    const seg1 = mergeSegmentPublico(base, { ageMin: 45 });
    expect(seg1).toEqual({ geo: ["Belo Horizonte"], gender: "women", ageMin: 45 });
    // "mulheres no geral": nada próprio → herda tudo (gênero women, faixa da base).
    const seg2 = mergeSegmentPublico(base, {});
    expect(seg2).toEqual({ geo: ["Belo Horizonte"], gender: "women", ageMin: 18 });
  });
  it("segmento traz interesse próprio (o testado) e herda a base demográfica", () => {
    const base = { geo: ["BR"], gender: "women" as const };
    const seg = mergeSegmentPublico(base, { interests: ["corrida"] });
    expect(seg).toEqual({ geo: ["BR"], gender: "women", interests: ["corrida"] });
  });
  it("base vazia (addSegment) → o público é só o do segmento", () => {
    const seg = mergeSegmentPublico({}, { gender: "men", ageMin: 30 });
    expect(seg).toEqual({ gender: "men", ageMin: 30 });
  });
  it("gênero do segmento sobrepõe o da base", () => {
    const seg = mergeSegmentPublico({ gender: "women" }, { gender: "men" });
    expect(seg.gender).toBe("men");
  });
});

describe("patchTouchesSinglePublico (guard multi-conjunto — P2)", () => {
  it("edições de público único → true; add/removeSegment e orçamento/nome → false", () => {
    expect(patchTouchesSinglePublico({ addInterests: ["corrida"] })).toBe(true);
    expect(patchTouchesSinglePublico({ ageMin: 25 })).toBe(true);
    expect(patchTouchesSinglePublico({ addAudiences: ["remarketing"] })).toBe(true);
    // operar OS conjuntos (não o público de um) NÃO é edição de público único:
    expect(patchTouchesSinglePublico({ addSegment: [{ interests: ["corrida"] }] })).toBe(false);
    expect(patchTouchesSinglePublico({ removeSegment: [1] })).toBe(false);
    expect(patchTouchesSinglePublico({ budgetReais: 50 })).toBe(false);
    expect(patchTouchesSinglePublico({ campaignName: "x" })).toBe(false);
  });
});

describe("patchHasNonLinkAction (Bug A — link espúrio não bloqueia um turno que pede outra coisa)", () => {
  it("só link → false (o link é o único pedido)", () => {
    expect(patchHasNonLinkAction({ link: "https://loja.com" })).toBe(false);
    expect(patchHasNonLinkAction({})).toBe(false);
  });
  it("link + outra ação → true (advantage/ativação/budget/público/objetivo/…)", () => {
    expect(patchHasNonLinkAction({ link: "https://loja.com", advantage: true })).toBe(true);
    expect(patchHasNonLinkAction({ advantage: false })).toBe(true);
    expect(patchHasNonLinkAction({ activation: "active" })).toBe(true);
    expect(patchHasNonLinkAction({ budgetReais: 50 })).toBe(true);
    expect(patchHasNonLinkAction({ budgetMode: "abo" })).toBe(true);
    expect(patchHasNonLinkAction({ objective: "purchase" })).toBe(true);
    expect(patchHasNonLinkAction({ addInterests: ["corrida"] })).toBe(true); // público (reusa patchTouchesSinglePublico)
    expect(patchHasNonLinkAction({ addSegment: [{ interests: ["corrida"] }] })).toBe(true);
    expect(patchHasNonLinkAction({ campaignName: "x" })).toBe(true);
    expect(patchHasNonLinkAction({ regenerateCopy: true })).toBe(true);
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

describe("creativeRefOf (ChosenCreative → CreativeAssetRef)", () => {
  const img = (h: string): { imageHash: string; assetId: string; origin: "reuse" | "upload"; source: "serving" | "library" } => ({ imageHash: h, assetId: `a-${h}`, origin: "reuse", source: "serving" });
  const vid = (v: string): { videoId: string; assetId: string; origin: "reuse" | "upload"; source: "serving" | "library" } => ({ videoId: v, assetId: `a-${v}`, origin: "upload", source: "library" });

  it("creativeRefOf: vídeo → format video + metaVideoId; imagem → format image + metaImageHash", () => {
    expect(creativeRefOf(vid("V9"))).toEqual({ assetId: "a-V9", format: "video", origin: "upload", metaVideoId: "V9" });
    expect(creativeRefOf(img("H9"))).toEqual({ assetId: "a-H9", format: "image", origin: "reuse", metaImageHash: "H9" });
  });
});

describe("normalizeAdCount (contagem pedida pelo dono, clampada)", () => {
  it("clampa 1..MAX_ADS_PER_DRAFT e arredonda", () => {
    expect(normalizeAdCount(5)).toBe(5);
    expect(normalizeAdCount(0)).toBe(1);
    expect(normalizeAdCount(999)).toBe(10);
    expect(normalizeAdCount(2.6)).toBe(3);
  });
  it("ausente/inválido → undefined (caller usa o default)", () => {
    expect(normalizeAdCount(undefined)).toBeUndefined();
    expect(normalizeAdCount(Number.NaN)).toBeUndefined();
  });
});

describe("assignCreativesToVariants (1:1 criativo↔anúncio, extras herdam o padrão)", () => {
  const cv = (h: string): CopyVariant => ({ primaryText: `p-${h}`, headline: h }) as CopyVariant;
  const img = (h: string) => ({ imageHash: h, assetId: `a-${h}`, origin: "reuse" as const, source: "serving" as const });

  it("<2 criativos → nenhum ganha ref própria (todos usam o padrão do spec)", () => {
    const out = assignCreativesToVariants([cv("a"), cv("b")], [img("H1")]);
    expect(out.every((v) => v.creative === undefined)).toBe(true);
  });

  it("≥2 criativos → 1:1 nos primeiros; slots além dos distintos ficam sem ref (herdam o padrão)", () => {
    const out = assignCreativesToVariants([cv("a"), cv("b"), cv("c")], [img("H1"), img("H2")]);
    expect(out[0]!.creative?.metaImageHash).toBe("H1");
    expect(out[1]!.creative?.metaImageHash).toBe("H2");
    expect(out[2]!.creative).toBeUndefined(); // 3º anúncio herda o criativo padrão (o melhor)
  });
});

describe("fillDistinctCreatives (aumento de contagem: preserva escolha do site, preenche distintos)", () => {
  const cv = (h: string): CopyVariant => ({ primaryText: `p-${h}`, headline: h }) as CopyVariant;
  const cvWith = (h: string, hash: string): CopyVariant => ({ primaryText: `p-${h}`, headline: h, creative: { assetId: `pin-${hash}`, format: "image", origin: "reuse", metaImageHash: hash } }) as CopyVariant;
  const primary = { imageHash: "P", assetId: "a-P", origin: "reuse" as const, source: "serving" as const };
  const pool = (hashes: string[]) => hashes.map((h) => ({ imageHash: h, assetId: `a-${h}`, origin: "reuse" as const, source: "serving" as const }));

  it("preenche slots default com distintos, NUNCA sobrescreve criativo escolhido no site", () => {
    // ad0 = escolhido no site (H_SITE); ad1/ad2 = default → recebem distintos do pool.
    const { variants } = fillDistinctCreatives([cvWith("a", "H_SITE"), cv("b"), cv("c")], primary, pool(["H1", "H2"]));
    expect(variants[0]!.creative?.metaImageHash).toBe("H_SITE"); // PRESERVADO (não clobber)
    expect(variants[1]!.creative?.metaImageHash).toBe("H1");
    expect(variants[2]!.creative?.metaImageHash).toBe("H2");
  });

  it("não repete o padrão nem o já-fixado no pool (dedupe por mídia)", () => {
    // pool contém P (=primary) e H_SITE (=fixado) → ambos pulados; só H9 é novo.
    const { variants, withoutDistinct } = fillDistinctCreatives([cvWith("a", "H_SITE"), cv("b"), cv("c")], primary, pool(["P", "H_SITE", "H9"]));
    expect(variants[1]!.creative?.metaImageHash).toBe("H9");
    expect(variants[2]!.creative).toBeUndefined(); // sem distinto sobrando → herda o padrão
    expect(withoutDistinct).toBe(1);
  });

  it("pool vazio → todos os defaults herdam o padrão (withoutDistinct conta os repetidos)", () => {
    const { variants, withoutDistinct } = fillDistinctCreatives([cv("a"), cv("b"), cv("c")], primary, []);
    expect(variants.every((v) => v.creative === undefined)).toBe(true);
    expect(withoutDistinct).toBe(3);
  });
});

describe("composeCreatives (composição: N anúncios, K distintos, resto repete)", () => {
  const c = (h: string) => ({ imageHash: h, assetId: `a-${h}`, origin: "reuse" as const, source: "serving" as const });
  const keys = (arr: ReturnType<typeof composeCreatives>) => arr.map((x) => x.imageHash ?? x.videoId);

  it("'2 iguais + 2 diferentes' = 4 anúncios, 3 distintos → um repetido", () => {
    const out = composeCreatives(4, 3, [c("A"), c("B"), c("C"), c("D")]);
    expect(keys(out)).toEqual(["A", "B", "C", "A"]); // A repetido (2 iguais), B e C únicos
    expect(new Set(keys(out)).size).toBe(3);
  });

  it("distinctCount 1 → todos iguais", () => {
    expect(keys(composeCreatives(4, 1, [c("A"), c("B")]))).toEqual(["A", "A", "A", "A"]);
  });

  it("distinctCount = adCount → todos diferentes (cap no pool)", () => {
    expect(keys(composeCreatives(3, 3, [c("A"), c("B"), c("C")]))).toEqual(["A", "B", "C"]);
  });

  it("pool insuficiente → usa os que há, cicla o resto", () => {
    expect(keys(composeCreatives(4, 4, [c("A"), c("B")]))).toEqual(["A", "B", "A", "B"]);
  });

  it("pool vazio → vazio (caller cai no criativo padrão)", () => {
    expect(composeCreatives(3, 2, [])).toEqual([]);
  });
});

describe("filterByMedia (preferência de mídia)", () => {
  const img = (h: string) => ({ imageHash: h, assetId: h, origin: "reuse" as const, source: "serving" as const });
  const vid = (v: string) => ({ videoId: v, imageHash: "cover", assetId: v, origin: "reuse" as const, source: "serving" as const });
  const pool = [img("I1"), vid("V1"), img("I2")];

  it("video → só vídeos", () => {
    expect(filterByMedia(pool, "video").map((c) => c.videoId)).toEqual(["V1"]);
  });
  it("image → só imagem estática (sem videoId)", () => {
    expect(filterByMedia(pool, "image").map((c) => c.imageHash)).toEqual(["I1", "I2"]);
  });
  it("mixed/undefined → todos", () => {
    expect(filterByMedia(pool, "mixed")).toHaveLength(3);
    expect(filterByMedia(pool, undefined)).toHaveLength(3);
  });
});

describe("interleaveMedia (mixed GARANTE vídeo+imagem entre os distintos)", () => {
  const img = (h: string) => ({ imageHash: h, assetId: h, origin: "reuse" as const, source: "serving" as const });
  const vid = (v: string) => ({ videoId: v, imageHash: "cover", assetId: v, origin: "reuse" as const, source: "serving" as const });

  it("alterna v,i,v,i → os 1ºs distintos pegam os dois tipos (não 3 vídeos seguidos)", () => {
    // pool com vídeos na frente (como veiculando) → sem interleave, os 3 1ºs seriam vídeo.
    const out = interleaveMedia([vid("V1"), vid("V2"), vid("V3"), img("I1")]);
    expect(out.ordered.map((c) => c.videoId ?? c.imageHash)).toEqual(["V1", "I1", "V2", "V3"]);
    expect(out.hasVideo && out.hasImage).toBe(true);
  });

  it("só um tipo → flag indica o que falta", () => {
    expect(interleaveMedia([vid("V1"), vid("V2")])).toMatchObject({ hasVideo: true, hasImage: false });
    expect(interleaveMedia([img("I1")])).toMatchObject({ hasVideo: false, hasImage: true });
  });
});

describe("describeCopiesBlock (mostra as copies no eco — §8)", () => {
  it("lista headline + 1ª linha do texto, numerado", () => {
    const block = describeCopiesBlock([
      { primaryText: "Linha um.\nLinha dois", headline: "Título A" },
      { primaryText: "Outro texto", headline: "Título B" },
    ] as never);
    expect(block).toContain("Copies (2)");
    expect(block).toContain("1. *Título A* — Linha um.");
    expect(block).toContain("2. *Título B* — Outro texto");
    expect(block).not.toContain("Linha dois"); // só a 1ª linha
  });
});

describe("recoverOpenDraft (fonte da verdade = banco quando o estado efêmero expira)", () => {
  const CTX = { orgId: "o1", agentId: "ag1", adAccountId: "acc1", currency: "BRL" };
  function depsWith(pending: unknown[], draftRows: unknown[]) {
    const listPendingByAgent = vi.fn(async () => pending);
    const db = {
      select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: () => draftRows }) }) }) }),
    };
    return { db, ports: { approval: { listPendingByAgent } } } as unknown as WorkerDeps;
  }

  it("acha o rascunho aberto + junta o approvalId da pendência de rascunho", async () => {
    const deps = depsWith(
      [{ kind: "draft", id: "appr1", draftId: "d1" }],
      [{ id: "d1", kind: "from_scratch", spec: { version: 1 } }],
    );
    const out = await recoverOpenDraft(deps, CTX);
    expect(out).toEqual({ draftId: "d1", approvalId: "appr1", kind: "from_scratch", spec: { version: 1 } });
  });

  it("sem pendência de rascunho → null (não recupera ação/ativação)", async () => {
    const deps = depsWith([{ kind: "action", id: "a1" }], []);
    expect(await recoverOpenDraft(deps, CTX)).toBeNull();
  });

  it("pendência existe mas o draft não está mais 'proposed' (0 linhas) → null", async () => {
    const deps = depsWith([{ kind: "draft", id: "appr1", draftId: "d1" }], []);
    expect(await recoverOpenDraft(deps, CTX)).toBeNull();
  });
});

describe("resolveProposedExplicitTargeting (nome→id + montagem compartilhada — Fatia C)", () => {
  const CTX2 = { orgId: ORG, agentId: AGENT, adAccountId: ACC, currency: "BRL" };
  function adsDeps(searchGeo: unknown[], searchInterests: unknown[]): WorkerDeps {
    return {
      ports: {
        ads: {
          searchGeo: vi.fn(async () => searchGeo),
          searchInterests: vi.fn(async () => searchInterests),
          searchBehaviors: vi.fn(async () => []),
        },
      },
    } as unknown as WorkerDeps;
  }

  it("resolve geo + interesse por NOME → explicit", async () => {
    const deps = adsDeps([{ key: "C1", name: "Belo Horizonte", kind: "city" }], [{ id: "i1", name: "Corrida" }]);
    const res = await resolveProposedExplicitTargeting(deps, CTX2, REF, { geo: ["Belo Horizonte"], interests: ["Corrida"], ageMin: 25 }, { autonomous: true });
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.targeting.geo).toEqual([{ key: "C1", name: "Belo Horizonte", kind: "city" }]);
    expect(res.targeting.interestGroups).toEqual([[{ id: "i1", name: "Corrida" }]]);
    expect(res.targeting.ageMin).toBe(25);
  });

  it("nada proposto → empty (o caller mantém consultivo, não inventa público)", async () => {
    const res = await resolveProposedExplicitTargeting(adsDeps([], []), CTX2, REF, {}, { autonomous: true });
    expect(res.kind).toBe("empty");
  });

  it("nome não resolvido em modo autônomo → descartado (dropped), não bloqueia", async () => {
    const deps = adsDeps([], []); // geo não acha nada
    const res = await resolveProposedExplicitTargeting(deps, CTX2, REF, { geo: ["Lugar Inexistente"], ageMin: 30 }, { autonomous: true });
    expect(res.kind).toBe("ok"); // ageMin ainda sustenta o explicit
    if (res.kind !== "ok") return;
    expect(res.droppedNames).toContain("Lugar Inexistente");
    expect(res.targeting.geo).toEqual([{ key: "BR", name: "Brasil", kind: "country" }]); // fallback país
  });
});

describe("scaleForbiddenRefineField (G16 — escala não edita o herdado)", () => {
  it("budget/ativação numa escala → permitido (null)", () => {
    expect(scaleForbiddenRefineField({ budgetReais: 50 })).toBeNull();
    expect(scaleForbiddenRefineField({ activation: "active" })).toBeNull();
    expect(scaleForbiddenRefineField({})).toBeNull();
  });
  it("objetivo/público/copy/nome numa escala → rótulo do campo herdado (mensagem honesta)", () => {
    expect(scaleForbiddenRefineField({ objective: "purchase" })).toBe("objective");
    expect(scaleForbiddenRefineField({ addInterests: ["estética"] })).toBe("targeting");
    expect(scaleForbiddenRefineField({ ageMin: 25 })).toBe("targeting");
    expect(scaleForbiddenRefineField({ regenerateCopy: true })).toBe("copyVariants");
    expect(scaleForbiddenRefineField({ variantsCount: 3 })).toBe("copyVariants");
    expect(scaleForbiddenRefineField({ setAdCreative: [{ index: 0, creative: "o campeão" }] })).toBe("copyVariants");
    expect(scaleForbiddenRefineField({ link: "https://loja.com" })).toBe("link");
    expect(scaleForbiddenRefineField({ setPage: "CaquiAI Loja" })).toBe("pageId");
    expect(scaleForbiddenRefineField({ campaignName: "x" })).toBe("campaignName");
    // P2: add/remover conjunto (público) também é herdado numa escala.
    expect(scaleForbiddenRefineField({ addSegment: [{ interests: ["corrida"] }] })).toBe("targeting");
    expect(scaleForbiddenRefineField({ removeSegment: [1] })).toBe("targeting");
    // F1a/F1b: Advantage e onde a verba mora (CBO/ABO) são do rascunho do zero — na escala herdados.
    expect(scaleForbiddenRefineField({ advantage: true })).toBe("advantage");
    expect(scaleForbiddenRefineField({ budgetMode: "abo" })).toBe("budgetMode");
  });
  it("regenerateCopy:false NÃO é edição (não trava)", () => {
    expect(scaleForbiddenRefineField({ regenerateCopy: false })).toBeNull();
  });
});

describe("resolveCreativeFill (política de faltante do picker — Slice 3)", () => {
  it("sem picks → o agente escolhe todos (comportamento atual)", () => {
    expect(resolveCreativeFill(0, 3, undefined)).toEqual({ decision: "agent", variants: 3 });
    expect(resolveCreativeFill(0, 1, "only_picked")).toEqual({ decision: "agent", variants: 1 });
  });
  it("picks ≥ anúncios → usa só os escolhidos (nunca completa à toa)", () => {
    expect(resolveCreativeFill(3, 3, undefined)).toEqual({ decision: "only_picked", variants: 3 });
    expect(resolveCreativeFill(5, 3, undefined)).toEqual({ decision: "only_picked", variants: 3 });
  });
  it("picks < anúncios sem decisão → PERGUNTA (não decide sozinho, §8)", () => {
    expect(resolveCreativeFill(2, 5, undefined)).toEqual({ decision: "ask" });
  });
  it("picks < anúncios, fill=agent → completa o resto pela performance (mantém o adCount)", () => {
    expect(resolveCreativeFill(2, 5, "agent")).toEqual({ decision: "agent", variants: 5 });
  });
  it("picks < anúncios, fill=only_picked → reduz os anúncios aos escolhidos", () => {
    expect(resolveCreativeFill(2, 5, "only_picked")).toEqual({ decision: "only_picked", variants: 2 });
  });
  it("adCount 0/negativo → clampa pra ≥1", () => {
    expect(resolveCreativeFill(0, 0, undefined)).toEqual({ decision: "agent", variants: 1 });
  });
});

describe("cleanPageQuery (sanitiza o `page` do LLM — incidente do lixo vazado)", () => {
  it("nome/número normal → passa (uma linha, aparado)", () => {
    expect(cleanPageQuery("  Automato ")).toBe("Automato");
    expect(cleanPageQuery("3491398")).toBe("3491398");
  });
  it("vazio/ausente → null", () => {
    expect(cleanPageQuery("")).toBeNull();
    expect(cleanPageQuery(undefined)).toBeNull();
    expect(cleanPageQuery(null)).toBeNull();
    expect(cleanPageQuery("   ")).toBeNull();
  });
  it("lixo do modelo (longo/multi-linha/JSON malformado) → null (nunca ecoa, usa a padrão)", () => {
    // o incidente real: raciocínio malformado caiu no campo `page`.
    expect(cleanPageQuery(':null}"】【 тру? JSON invalid strings? Need correct null. Tool call malformed perhaps recipient accepted? I wrote `')).toBeNull();
    expect(cleanPageQuery("linha1\nlinha2\nlinha3 com um monte de texto que claramente é alucinação do modelo e passa de oitenta caracteres")).toBeNull();
  });
  it("multi-linha curto → colapsa pra uma linha (mantém se couber)", () => {
    expect(cleanPageQuery("CaquiAI\nOficial")).toBe("CaquiAI Oficial");
  });
  it("sentinela/artefato do modelo (`:null`, `null`, `{}`, …) → null (não vira query, não pune)", () => {
    // incidente real: criação SEM Página dita → o modelo mandou ":null" → Roy puniu "não achei :null".
    expect(cleanPageQuery(":null")).toBeNull();
    expect(cleanPageQuery("null")).toBeNull();
    expect(cleanPageQuery("undefined")).toBeNull();
    expect(cleanPageQuery("none")).toBeNull();
    expect(cleanPageQuery("n/a")).toBeNull();
    expect(cleanPageQuery("{}")).toBeNull();
    expect(cleanPageQuery('":"')).toBeNull();
    // um nome de verdade que CONTÉM "null" não é sentinela (só o núcleo exato conta).
    expect(cleanPageQuery("Nullify Store")).toBe("Nullify Store");
  });
});

describe("matchPagesByQuery / pageChoiceLabel (picker de Página — W2)", () => {
  const pages: PageInfo[] = [
    { pageId: "P1", name: "CaquiAI Oficial", whatsappNumber: "5531953491398" },
    { pageId: "P2", name: "CaquiAI Loja", whatsappNumber: "5531999990000" },
    { pageId: "P3", name: "Consultório Dr. Ana" },
  ];
  it("nome (substring, case-insensitive) → casa a Página", () => {
    expect(matchPagesByQuery(pages, "loja").map((p) => p.pageId)).toEqual(["P2"]);
    expect(matchPagesByQuery(pages, "CONSULTÓRIO").map((p) => p.pageId)).toEqual(["P3"]);
  });
  it("acento não separa: 'Autômato' casa a Página 'Automato' (incidente real)", () => {
    const p: PageInfo[] = [{ pageId: "PA", name: "Automato" }];
    expect(matchPagesByQuery(p, "Autômato").map((x) => x.pageId)).toEqual(["PA"]);
    // e o inverso: query sem acento casa nome com acento.
    expect(matchPagesByQuery(pages, "consultorio").map((x) => x.pageId)).toEqual(["P3"]);
  });
  it("mesmo matcher fuzzy das outras entidades: typo/caixa toleradas (resolveNamedMatch)", () => {
    const p: PageInfo[] = [{ pageId: "PA", name: "Automato" }];
    expect(matchPagesByQuery(p, "atomato").map((x) => x.pageId)).toEqual(["PA"]); // typo (falta 'u')
    expect(matchPagesByQuery(p, "AUTOMATO").map((x) => x.pageId)).toEqual(["PA"]); // caixa
    expect(matchPagesByQuery(p, "auto").map((x) => x.pageId)).toEqual(["PA"]); // parcial (contenção)
  });
  it("número (dígitos, substring, mín. 6) → casa pela linha do WhatsApp", () => {
    expect(matchPagesByQuery(pages, "3491398").map((p) => p.pageId)).toEqual(["P1"]);
    expect(matchPagesByQuery(pages, "+55 (31) 99999-0000").map((p) => p.pageId)).toEqual(["P2"]);
  });
  it("prefixo comum → N matches (o caller pergunta, nunca chuta)", () => {
    expect(matchPagesByQuery(pages, "caquiai").map((p) => p.pageId)).toEqual(["P1", "P2"]);
  });
  it("nada bate → lista vazia (o caller lista as opções)", () => {
    expect(matchPagesByQuery(pages, "farmácia")).toEqual([]);
  });
  it("número curto (<6 dígitos) não casa fragmento à toa", () => {
    expect(matchPagesByQuery(pages, "553")).toEqual([]);
  });
  it("query vazia → lista vazia", () => {
    expect(matchPagesByQuery(pages, "  ")).toEqual([]);
  });
  it("rótulo mostra nome + WhatsApp quando há; só nome quando não", () => {
    expect(pageChoiceLabel(pages[0]!)).toBe("CaquiAI Oficial (WhatsApp +5531953491398)");
    expect(pageChoiceLabel(pages[2]!)).toBe("Consultório Dr. Ana");
    expect(pageChoiceLabel({ pageId: "PX" })).toBe("Página do Facebook");
  });
});

describe("stripGeoQualifier (retry de geo sem o sufixo)", () => {
  it("tira o estado após a vírgula", () => {
    expect(stripGeoQualifier("Belo Horizonte, MG")).toBe("Belo Horizonte");
    expect(stripGeoQualifier("Belo Horizonte, Minas Gerais")).toBe("Belo Horizonte");
  });
  it("bairro, cidade → mantém o bairro (a busca casa o lugar, não a composição)", () => {
    expect(stripGeoQualifier("Buritis, Belo Horizonte")).toBe("Buritis");
    expect(stripGeoQualifier("Buritis, Belo Horizonte, MG")).toBe("Buritis, Belo Horizonte");
  });
  it("sem vírgula ou resto vazio → undefined (nada a tirar)", () => {
    expect(stripGeoQualifier("Belo Horizonte")).toBeUndefined();
    expect(stripGeoQualifier(", MG")).toBeUndefined();
    expect(stripGeoQualifier("")).toBeUndefined();
  });
});

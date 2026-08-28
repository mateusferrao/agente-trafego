import { describe, expect, it, vi } from "vitest";
import { chooseCreative, resolveCreationTargeting } from "./draft-proposal.js";
import { creativeContentHash } from "../vision/resolver.js";
import type { WorkerDeps } from "../../composition.js";

/** deps.db falso p/ o caminho de RECÊNCIA (sem match): só o SELECT da biblioteca
 *  (from→where→orderBy→limit) devolve `libRows`. */
function fakeDeps(libRows: unknown[]) {
  const db = {
    select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: () => libRows }) }) }) }),
  };
  return { db } as unknown as WorkerDeps;
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
    const out = await chooseCreative(deps, ORG, ACC, { imageHash: "H", sourceAdId: "ad_1" });
    expect(out).toEqual({ imageHash: "H", assetId: "ad_1", origin: "reuse", source: "serving" });
    expect(select).not.toHaveBeenCalled();
  });

  it("SEM veiculando, sem match → biblioteca por recência (mais recente)", async () => {
    const deps = fakeDeps([{ id: "asset_9", imageHash: "HLIB", videoId: null }]);
    const out = await chooseCreative(deps, ORG, ACC, {});
    expect(out).toEqual({ imageHash: "HLIB", assetId: "asset_9", origin: "upload", source: "library" });
  });

  it("SEM veiculando + vídeo na biblioteca → usa metaVideoId", async () => {
    const deps = fakeDeps([{ id: "asset_v", imageHash: null, videoId: "VID1" }]);
    const out = await chooseCreative(deps, ORG, ACC, {});
    expect(out).toEqual({ videoId: "VID1", assetId: "asset_v", origin: "upload", source: "library" });
  });

  it("SEM veiculando + biblioteca vazia → null", async () => {
    expect(await chooseCreative(fakeDeps([]), ORG, ACC, {})).toBeNull();
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
    const out = await chooseCreative(deps, ORG, ACC, {}, MATCH);
    expect(llm.completeStructured).toHaveBeenCalledOnce(); // consultou o contexto
    expect(out?.assetId).toBe("b"); // escolheu pelo contexto (index 1), não a recência (a)
    expect(out?.source).toBe("library");
  });

  it("veiculando em vídeo → escolhe o vídeo veiculado", async () => {
    const deps = { db: { select: vi.fn() } } as unknown as WorkerDeps;
    const out = await chooseCreative(deps, ORG, ACC, { videoId: "SVID", sourceAdId: "ad_2" });
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

import { describe, expect, it, vi } from "vitest";
import { chooseCreative } from "./draft-proposal.js";
import type { WorkerDeps } from "../../composition.js";

/** deps.db falso: só o SELECT da biblioteca (from→where→orderBy→limit) devolve `libRows`. */
function fakeDeps(libRows: unknown[]) {
  const db = {
    select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: () => libRows }) }) }) }),
  };
  return { db } as unknown as WorkerDeps;
}

const ORG = "o1";
const ACC = "a1";

describe("chooseCreative (pool único: veiculando + biblioteca)", () => {
  it("criativo VEICULANDO presente → escolhe o veiculado (provado), NÃO consulta biblioteca", async () => {
    const select = vi.fn();
    const deps = { db: { select } } as unknown as WorkerDeps;
    const out = await chooseCreative(deps, ORG, ACC, { imageHash: "H", sourceAdId: "ad_1" });
    expect(out).toEqual({ imageHash: "H", assetId: "ad_1", origin: "reuse", source: "serving" });
    expect(select).not.toHaveBeenCalled(); // serving vence sem tocar o DB
  });

  it("SEM veiculando + biblioteca tem upload → cai no upload mais recente (fallback)", async () => {
    const deps = fakeDeps([{ id: "asset_9", imageHash: "HLIB", videoId: null }]);
    const out = await chooseCreative(deps, ORG, ACC, {});
    expect(out).toEqual({ imageHash: "HLIB", assetId: "asset_9", origin: "upload", source: "library" });
  });

  it("SEM veiculando + biblioteca com vídeo → usa metaVideoId da biblioteca", async () => {
    const deps = fakeDeps([{ id: "asset_v", imageHash: null, videoId: "VID1" }]);
    const out = await chooseCreative(deps, ORG, ACC, {});
    expect(out).toEqual({ videoId: "VID1", assetId: "asset_v", origin: "upload", source: "library" });
  });

  it("SEM veiculando + biblioteca vazia → null (nada em lugar nenhum)", async () => {
    expect(await chooseCreative(fakeDeps([]), ORG, ACC, {})).toBeNull();
  });

  it("veiculando em vídeo → escolhe o vídeo veiculado", async () => {
    const deps = { db: { select: vi.fn() } } as unknown as WorkerDeps;
    const out = await chooseCreative(deps, ORG, ACC, { videoId: "SVID", sourceAdId: "ad_2" });
    expect(out).toEqual({ videoId: "SVID", assetId: "ad_2", origin: "reuse", source: "serving" });
  });
});

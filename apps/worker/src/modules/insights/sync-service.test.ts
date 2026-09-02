import { describe, expect, it, vi } from "vitest";
import { AdsPlatformError, type AdsPlatformPort, type InsightsQuery } from "@trafego/shared/ports";
import type { EntityLevel, InsightRow } from "@trafego/shared";
import { createInsightsSyncService } from "./sync-service.js";
import type { InsightsSnapshotsRepo, SnapshotRow } from "./repo.js";

const input = {
  orgId: "o1",
  adAccountUuid: "u1",
  metaAdAccountId: "123",
  accessToken: "tok",
  today: "2026-08-18",
};

function metrics() {
  return { spend: 1, impressions: 1, clicks: 1, ctr: 1, cpc: 1, cpm: 1 };
}

function datedRow(level: EntityLevel): InsightRow {
  return { entityId: `${level}-1`, level, date: "2026-08-18", metrics: metrics() };
}

function makeRepo() {
  const upserts: SnapshotRow[] = [];
  const repo: InsightsSnapshotsRepo = {
    latestDate: async () => null, // 1º sync → janela cheia, todos os níveis rodam
    upsertMany: async (rows) => {
      upserts.push(...rows);
    },
    listWindow: async () => [],
    accountActivitySince: async () => false,
    latestSyncedAtByAccounts: async () => new Map(),
  };
  return { repo, upserts };
}

function makeService(getInsights: AdsPlatformPort["getInsights"], repo: InsightsSnapshotsRepo) {
  const ads = { getInsights } as unknown as AdsPlatformPort;
  return createInsightsSyncService({ ads, repo, refetchWindowDays: 7, retentionDays: 90 });
}

describe("createInsightsSyncService.sync", () => {
  it("grava 1 snapshot por nível (ignora linha sem date = agregado)", async () => {
    const { repo, upserts } = makeRepo();
    const getInsights = vi.fn(async (q: InsightsQuery) => [
      datedRow(q.level),
      { entityId: "agg", level: q.level, metrics: metrics() }, // sem date → não persiste
    ]);

    const res = await makeService(getInsights, repo).sync(input);

    expect(getInsights).toHaveBeenCalledTimes(4); // account/campaign/adset/ad
    expect(res).toEqual({ partial: false, tokenInvalid: false, snapshotsWritten: 4 });
    expect(upserts.map((r) => r.entityLevel)).toEqual(["account", "campaign", "adset", "ad"]);
  });

  it("S6: pede reach/inline_link_clicks/vídeo/rankings + persiste qualityRankings quando presente", async () => {
    const { repo, upserts } = makeRepo();
    let queriedFields: readonly string[] = [];
    const getInsights = vi.fn(async (q: InsightsQuery) => {
      queriedFields = q.fields;
      return [{ ...datedRow(q.level), qualityRankings: { quality: "below_average" as const } }];
    });

    await makeService(getInsights, repo).sync(input);

    expect(queriedFields).toEqual(
      expect.arrayContaining([
        "reach",
        "inline_link_clicks",
        "video_p25_watched_actions",
        "quality_ranking",
        "engagement_rate_ranking",
        "conversion_rate_ranking",
      ]),
    );
    expect(upserts[0]!.metrics.qualityRankings).toEqual({ quality: "below_average" });
  });

  it("BUG corrigido (revisão final): rankings de qualidade só são pedidos no nível AD — account/campaign/adset arriscariam o report inteiro falhar (campo só existe pro anúncio)", async () => {
    const { repo } = makeRepo();
    const fieldsByLevel = new Map<string, readonly string[]>();
    const getInsights = vi.fn(async (q: InsightsQuery) => {
      fieldsByLevel.set(q.level, q.fields);
      return [datedRow(q.level)];
    });

    await makeService(getInsights, repo).sync(input);

    for (const level of ["account", "campaign", "adset"] as const) {
      expect(fieldsByLevel.get(level)).not.toContain("quality_ranking");
      expect(fieldsByLevel.get(level)).not.toContain("engagement_rate_ranking");
      expect(fieldsByLevel.get(level)).not.toContain("conversion_rate_ranking");
    }
    expect(fieldsByLevel.get("ad")).toContain("quality_ranking");
  });

  it("S6: sem qualityRankings na linha → campo ausente no snapshot (nunca objeto vazio)", async () => {
    const { repo, upserts } = makeRepo();
    const getInsights = vi.fn(async (q: InsightsQuery) => [datedRow(q.level)]);

    await makeService(getInsights, repo).sync(input);

    expect(upserts[0]!.metrics.qualityRankings).toBeUndefined();
  });

  it("upstream num nível → partial=true e segue os demais", async () => {
    const { repo } = makeRepo();
    const getInsights = vi.fn(async (q: InsightsQuery) => {
      if (q.level === "campaign") throw new AdsPlatformError("upstream", "rate-limit");
      return [datedRow(q.level)];
    });

    const res = await makeService(getInsights, repo).sync(input);

    expect(res.partial).toBe(true);
    expect(res.tokenInvalid).toBe(false);
    expect(res.snapshotsWritten).toBe(3); // account, adset, ad
  });

  it("token inválido (190) → tokenInvalid=true e aborta", async () => {
    const { repo } = makeRepo();
    const getInsights = vi.fn(async () => {
      throw new AdsPlatformError("invalid_credential", "token inválido");
    });

    const res = await makeService(getInsights, repo).sync(input);

    expect(res.tokenInvalid).toBe(true);
    expect(res.snapshotsWritten).toBe(0);
    expect(getInsights).toHaveBeenCalledTimes(1); // aborta no 1º nível
  });
});

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

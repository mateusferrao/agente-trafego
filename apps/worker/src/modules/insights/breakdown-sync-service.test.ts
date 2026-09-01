import { describe, expect, it, vi } from "vitest";
import type { BreakdownInsightsQuery, EntityBreakdownRow } from "@trafego/shared/ports";
import type { AdsPlatformPort } from "@trafego/shared/ports";
import { createBreakdownSyncService } from "./breakdown-sync-service.js";
import type { InsightsBreakdownsRepo, StoredBreakdown } from "./breakdown-repo.js";

const NOW = Date.parse("2026-08-31T12:00:00Z");

const input = {
  orgId: "o1",
  adAccountUuid: "u1",
  metaAdAccountId: "123",
  accessToken: "tok",
  campaignIds: ["C1"],
  goals: {},
  now: NOW,
};

function makeRepo(latest: string | null = null) {
  const upserts: unknown[] = [];
  const repo: InsightsBreakdownsRepo = {
    latestDate: async () => latest,
    upsertMany: async (rows) => {
      upserts.push(...rows);
    },
    listByAccount: async (): Promise<readonly StoredBreakdown[]> => [],
  };
  return { repo, upserts };
}

function segmentRow(entityId: string, level: "account" | "campaign", key: string, spend: number): EntityBreakdownRow {
  return { entityId, level, segments: [{ key, label: key, metrics: { spend, impressions: 100, clicks: 5, ctr: 5, cpc: spend / 5, cpm: 10 } }] };
}

// Limiar realista da cadência própria (dias, não minutos) — day-granularity do watermark
// (coluna `date`) torna limiares curtos sem sentido (ver teste "ainda fresco" abaixo).
const STALE_THRESHOLD_MIN_7D = 7 * 24 * 60;

function makeService(getBreakdownInsights: AdsPlatformPort["getBreakdownInsights"], repo: InsightsBreakdownsRepo, staleThresholdMin = STALE_THRESHOLD_MIN_7D) {
  const ads = { getBreakdownInsights } as unknown as AdsPlatformPort;
  return createBreakdownSyncService({ ads, repo, staleThresholdMin });
}

describe("createBreakdownSyncService.sync", () => {
  it("ainda fresco (dentro do limiar de 7 dias) → pula o sync (cadência própria, mais lenta)", async () => {
    const freshDate = "2026-08-30"; // ontem — bem dentro dos 7 dias
    const { repo, upserts } = makeRepo(freshDate);
    const getBreakdownInsights = vi.fn();

    const res = await makeService(getBreakdownInsights, repo).sync(input);

    expect(res).toEqual({ synced: false });
    expect(getBreakdownInsights).not.toHaveBeenCalled();
    expect(upserts).toHaveLength(0);
  });

  it("nunca sincronizado (null) → sincroniza; só nível CONTA × 2 dimensões (campanha ainda sem consumidor — ver ROADMAP)", async () => {
    const { repo, upserts } = makeRepo(null);
    const getBreakdownInsights = vi.fn(async (q: BreakdownInsightsQuery) => [segmentRow("123", "account", "k1", 50)]);

    const res = await makeService(getBreakdownInsights, repo).sync(input);

    expect(res).toEqual({ synced: true });
    expect(getBreakdownInsights).toHaveBeenCalledTimes(2); // 1 nível (account) × 2 dimensões
    expect(getBreakdownInsights.mock.calls.every(([q]: [BreakdownInsightsQuery]) => q.level === "account")).toBe(true);
    const entityIds = upserts.map((r: any) => r.entityId);
    expect(entityIds).toContain("123");
  });

  it("goals.conversionGoal definido → resolve cpa/conversions por segmento", async () => {
    const { repo, upserts } = makeRepo(null);
    const getBreakdownInsights = vi.fn(async (): Promise<EntityBreakdownRow[]> => [
      {
        entityId: "123",
        level: "account",
        segments: [
          {
            key: "k1",
            label: "k1",
            metrics: { spend: 100, impressions: 1000, clicks: 20, ctr: 2, cpc: 5, cpm: 100 },
            conversions: [{ goal: "purchase", count: 10, value: 500 }],
          },
        ],
      },
    ]);

    await makeService(getBreakdownInsights, repo, 100).sync({ ...input, goals: { conversionGoal: "purchase" } });

    const seg = (upserts[0] as any).segments[0];
    expect(seg.metrics.conversions).toBe(10);
    expect(seg.metrics.cpa).toBe(10);
  });

  it("uma combinação falha (upstream) → degrada graciosamente, persiste as demais", async () => {
    const { repo, upserts } = makeRepo(null);
    const getBreakdownInsights = vi.fn(async (q: BreakdownInsightsQuery) => {
      if (q.dimension === "placement") throw new Error("upstream");
      if (q.level === "account") return [segmentRow("123", "account", "k1", 50)];
      return [segmentRow("C1", "campaign", "k1", 30)];
    });

    const res = await makeService(getBreakdownInsights, repo).sync(input);

    expect(res).toEqual({ synced: true });
    expect(upserts.length).toBeGreaterThan(0); // demographic sobreviveu
  });
});

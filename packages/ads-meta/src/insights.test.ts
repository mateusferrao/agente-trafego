import { afterEach, describe, expect, it, vi } from "vitest";
import type { InsightsQuery } from "@trafego/shared/ports";
import { MetaGraphClient } from "./client.js";
import { MetaInsightsService } from "./insights.js";
import type { MetaGovernor } from "./governor.js";

const TOKEN = "SYSTEM-USER-TOKEN";

// Governor stub: sempre concede, backoff 0, observe no-op.
const governor = {
  acquire: async () => ({ granted: true, retryAfterMs: 0, degrade: false }),
  observeUsage: async () => {},
  backoffDelayMs: () => 0,
} as unknown as MetaGovernor;

function makeService(overrides: Partial<{ maxAttempts: number; intervalMs: number }> = {}) {
  const client = new MetaGraphClient({ graphVersion: "v26.0" });
  return new MetaInsightsService(client, governor, { intervalMs: 0, maxAttempts: 2, ...overrides });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

interface Call {
  readonly method: string;
  readonly url: URL;
}

/** Stub de fetch roteado por (método, rota) — submit/poll/fetch do report job. */
function installFetch(handler: (method: string, url: URL, calls: Call[]) => Response) {
  const calls: Call[] = [];
  const spy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({ method, url });
    return handler(method, url, calls);
  });
  vi.stubGlobal("fetch", spy);
  return { calls };
}

const RUN_ID = "R1";

function makeQuery(over: Partial<InsightsQuery> = {}): InsightsQuery {
  return {
    account: { adAccountId: "123456", accessToken: TOKEN },
    level: "account",
    window: "last_7d",
    fields: ["spend", "actions"],
    ...over,
  };
}

afterEach(() => vi.unstubAllGlobals());

// rotas do report job
const isSubmit = (m: string, u: URL) => m === "POST" && u.pathname.endsWith("/insights");
const isPoll = (m: string, u: URL) => m === "GET" && u.pathname.endsWith(`/${RUN_ID}`);
const isFetch = (m: string, u: URL) => m === "GET" && u.pathname.endsWith(`/${RUN_ID}/insights`);

describe("MetaInsightsService — async report jobs", () => {
  it("happy path (preset): POST submit → poll Completed → fetch; fixa atribuição", async () => {
    let submitUrl: URL | undefined;
    installFetch((m, u) => {
      if (isSubmit(m, u)) {
        submitUrl = u;
        return json({ report_run_id: RUN_ID });
      }
      if (isPoll(m, u)) return json({ async_status: "Job Completed", async_percent_completion: 100 });
      if (isFetch(m, u)) return json({ data: [{ account_id: "123456", spend: "42.50" }] });
      return json({});
    });

    const rows = await makeService().getInsights(makeQuery());

    expect(submitUrl!.pathname).toBe("/v26.0/act_123456/insights");
    expect(submitUrl!.searchParams.get("level")).toBe("account");
    expect(submitUrl!.searchParams.get("time_increment")).toBe("1");
    expect(submitUrl!.searchParams.get("use_unified_attribution_setting")).toBe("true");
    expect(submitUrl!.searchParams.get("date_preset")).toBe("last_7d");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entityId: "act_123456", level: "account" });
    expect(rows[0]!.metrics.spend).toBe(42.5);
  });

  it("janela range → time_range JSON; entityId por nível + date + conversões normalizadas", async () => {
    let submitUrl: URL | undefined;
    installFetch((m, u) => {
      if (isSubmit(m, u)) {
        submitUrl = u;
        return json({ report_run_id: RUN_ID });
      }
      if (isPoll(m, u)) return json({ async_status: "Job Completed", async_percent_completion: 100 });
      if (isFetch(m, u))
        return json({
          data: [
            {
              ad_id: "AD9",
              date_start: "2026-08-03",
              spend: "150",
              actions: [
                { action_type: "link_click", value: "180" },
                { action_type: "offsite_conversion.fb_pixel_purchase", value: "5" },
                { action_type: "offsite_conversion.custom.777", value: "12" },
              ],
              action_values: [{ action_type: "offsite_conversion.fb_pixel_purchase", value: "900" }],
            },
          ],
        });
      return json({});
    });

    const rows = await makeService().getInsights(
      makeQuery({ level: "ad", window: "2026-08-01..2026-08-07" }),
    );

    expect(submitUrl!.searchParams.get("time_range")).toBe('{"since":"2026-08-01","until":"2026-08-07"}');
    const row = rows[0]!;
    expect(row).toMatchObject({ entityId: "AD9", level: "ad", date: "2026-08-03" });
    // link_click não é conversão (só no rawActions); purchase + custom normalizados
    expect(row.conversions).toEqual([
      { goal: "purchase", count: 5, value: 900 },
      { goal: "custom", customConversionId: "777", count: 12 },
    ]);
    expect(row.rawActions).toMatchObject({ link_click: 180, "offsite_conversion.custom.777": 12 });
  });

  it("S6: reach/inline_link_clicks/vídeo escalares + rankings normalizados (neutro, colapsa BELOW_AVERAGE_*)", async () => {
    installFetch((m, u) => {
      if (isSubmit(m, u)) return json({ report_run_id: RUN_ID });
      if (isPoll(m, u)) return json({ async_status: "Job Completed", async_percent_completion: 100 });
      if (isFetch(m, u))
        return json({
          data: [
            {
              ad_id: "AD9",
              reach: "800",
              inline_link_clicks: "37",
              video_p25_watched_actions: [{ action_type: "video_view", value: "120" }],
              quality_ranking: "BELOW_AVERAGE_20",
              engagement_rate_ranking: "ABOVE_AVERAGE",
              conversion_rate_ranking: "UNKNOWN",
            },
          ],
        });
      return json({});
    });

    const rows = await makeService().getInsights(makeQuery({ level: "ad" }));

    expect(rows[0]!.metrics.reach).toBe(800);
    expect(rows[0]!.metrics.inlineLinkClicks).toBe(37);
    expect(rows[0]!.metrics.videoP25WatchedCount).toBe(120);
    expect(rows[0]!.qualityRankings).toEqual({
      quality: "below_average",
      engagement: "above_average",
      conversion: "unknown",
    });
  });

  it("S6: sem rankings/vídeo reportados → campos ausentes (nunca zero forçado)", async () => {
    installFetch((m, u) => {
      if (isSubmit(m, u)) return json({ report_run_id: RUN_ID });
      if (isPoll(m, u)) return json({ async_status: "Job Completed", async_percent_completion: 100 });
      if (isFetch(m, u)) return json({ data: [{ account_id: "123456", spend: "1" }] });
      return json({});
    });

    const rows = await makeService().getInsights(makeQuery());

    expect(rows[0]!.metrics.reach).toBeUndefined();
    expect(rows[0]!.metrics.inlineLinkClicks).toBeUndefined();
    expect(rows[0]!.metrics.videoP25WatchedCount).toBeUndefined();
    expect(rows[0]!.qualityRankings).toBeUndefined();
  });

  it("Job Failed → re-submete fresh e conclui", async () => {
    let pollN = 0;
    const { calls } = installFetch((m, u) => {
      if (isSubmit(m, u)) return json({ report_run_id: RUN_ID });
      if (isPoll(m, u)) {
        pollN += 1;
        return pollN === 1
          ? json({ async_status: "Job Failed", async_percent_completion: 0 })
          : json({ async_status: "Job Completed", async_percent_completion: 100 });
      }
      if (isFetch(m, u)) return json({ data: [{ account_id: "123456", spend: "1" }] });
      return json({});
    });

    const rows = await makeService().getInsights(makeQuery());

    expect(rows).toHaveLength(1);
    expect(calls.filter((c) => isSubmit(c.method, c.url))).toHaveLength(2); // re-submeteu
  });

  it("1487534 (grande demais) → divide a janela e concatena", async () => {
    let submitN = 0;
    const { calls } = installFetch((m, u) => {
      if (isSubmit(m, u)) {
        submitN += 1;
        if (submitN === 1) {
          return json({ error: { code: 100, error_subcode: 1487534, message: "too big" } }, 400);
        }
        return json({ report_run_id: RUN_ID });
      }
      if (isPoll(m, u)) return json({ async_status: "Job Completed", async_percent_completion: 100 });
      if (isFetch(m, u)) return json({ data: [{ account_id: "123456", spend: "1" }] });
      return json({});
    });

    const rows = await makeService().getInsights(
      makeQuery({ window: "2026-08-01..2026-08-08" }),
    );

    // 1 submit falho (full) + 2 metades
    expect(calls.filter((c) => isSubmit(c.method, c.url))).toHaveLength(3);
    expect(rows).toHaveLength(2); // uma linha por metade
  });

  it("timeout no poll → lança (após esgotar re-submissões)", async () => {
    installFetch((m, u) => {
      if (isSubmit(m, u)) return json({ report_run_id: RUN_ID });
      if (isPoll(m, u)) return json({ async_status: "Job Running", async_percent_completion: 50 });
      return json({});
    });

    await expect(makeService({ maxAttempts: 1 }).getInsights(makeQuery())).rejects.toThrow();
  });
});

import { describe, expect, it } from "vitest";
import { buildInsightsSyncJob, INSIGHTS_SYNC_JOB, SYNC_QUEUE } from "./sync.js";

describe("buildInsightsSyncJob", () => {
  it("monta o JobSpec do sync-only com dedupe/serialize por conta", () => {
    const job = buildInsightsSyncJob({ accountId: "acc-1", orgId: "org-1", trigger: "manual" });
    expect(job).toEqual({
      queue: SYNC_QUEUE,
      name: INSIGHTS_SYNC_JOB,
      payload: { accountId: "acc-1", orgId: "org-1", trigger: "manual" },
      // manual/lazy → sufixo "-now" (distinto do sweep, não herda delay); removeOn* libera.
      idempotencyKey: "sync-acc-1-now",
      removeOnComplete: true,
      removeOnFail: true,
    });
  });

  it("cron (sweep) usa a chave base, distinta do imediato", () => {
    expect(buildInsightsSyncJob({ accountId: "acc-1", orgId: "org-1", trigger: "cron" }).idempotencyKey).toBe("sync-acc-1");
  });

  it("jobId NUNCA contém ':' — o BullMQ rejeita jobId custom com ':' (regressão do sweep)", () => {
    for (const trigger of ["cron", "manual", "on_demand"] as const) {
      const { idempotencyKey } = buildInsightsSyncJob({ accountId: "acc-1", orgId: "org-1", trigger });
      expect(idempotencyKey).not.toContain(":");
    }
  });
});

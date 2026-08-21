import { describe, expect, it } from "vitest";
import { buildInsightsSyncJob, INSIGHTS_SYNC_JOB, SYNC_QUEUE } from "./sync.js";

describe("buildInsightsSyncJob", () => {
  it("monta o JobSpec do sync-only com dedupe/serialize por conta", () => {
    const job = buildInsightsSyncJob({ accountId: "acc-1", orgId: "org-1", trigger: "manual" });
    expect(job).toEqual({
      queue: SYNC_QUEUE,
      name: INSIGHTS_SYNC_JOB,
      payload: { accountId: "acc-1", orgId: "org-1", trigger: "manual" },
      // jobId por conta → coalesce duplo-clique/lazy+sweep; removeOn* libera p/ o próximo.
      idempotencyKey: "sync:acc-1",
      removeOnComplete: true,
      removeOnFail: true,
    });
  });
});

import { describe, expect, it } from "vitest";
import { buildInsightsSyncJob, INSIGHTS_SYNC_JOB, SYNC_QUEUE } from "./sync.js";

describe("buildInsightsSyncJob", () => {
  it("monta o JobSpec do sync-only com dedupe/serialize por conta", () => {
    const job = buildInsightsSyncJob({ accountId: "acc-1", orgId: "org-1", trigger: "manual" });
    expect(job).toEqual({
      queue: SYNC_QUEUE,
      name: INSIGHTS_SYNC_JOB,
      payload: { accountId: "acc-1", orgId: "org-1", trigger: "manual" },
      // manual/lazy → jobId ":now" (distinto do sweep, não herda delay); removeOn* libera.
      idempotencyKey: "sync:acc-1:now",
      removeOnComplete: true,
      removeOnFail: true,
    });
  });
});

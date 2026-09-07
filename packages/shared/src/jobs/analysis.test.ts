import { describe, expect, it } from "vitest";
import {
  APPROVAL_APPLY_ATTEMPTS,
  APPROVAL_APPLY_BACKOFF_MS,
  APPROVAL_APPLY_JOB,
  APPROVAL_APPLY_QUEUE,
  buildApprovalApplyJob,
} from "./analysis.js";

describe("buildApprovalApplyJob (D3 — retry de rate-limit)", () => {
  it("carrega attempts + backoff (o BullMQ retenta o rate-limit) + o payload", () => {
    const job = buildApprovalApplyJob({ orgId: "o", approvalId: "a" });
    expect(job).toMatchObject({
      queue: APPROVAL_APPLY_QUEUE,
      name: APPROVAL_APPLY_JOB,
      payload: { orgId: "o", approvalId: "a" },
      attempts: APPROVAL_APPLY_ATTEMPTS,
      backoffMs: APPROVAL_APPLY_BACKOFF_MS,
    });
    expect(APPROVAL_APPLY_ATTEMPTS).toBeGreaterThan(1); // sem retry (=1) não adiantaria
  });
});

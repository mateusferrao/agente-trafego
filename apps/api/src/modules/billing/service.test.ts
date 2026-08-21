import { describe, expect, it, vi } from "vitest";
import type { Database } from "@trafego/db";
import type { OrgId } from "@trafego/shared/types";
import type { MeteringPort } from "@trafego/shared/ports";
import { createBillingService } from "./service.js";

/** DB falso: cadeia select→from→innerJoin(×n)→where→(orderBy→limit | groupBy) → `rows`. */
function makeDb(rows: unknown[]): Database {
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => rows,
    groupBy: async () => rows,
  };
  return { select: () => chain } as unknown as Database;
}

const metering = { summarize: vi.fn() } as unknown as MeteringPort;
const ORG = "o1" as OrgId;
const DEPS = { costCapUsd: 5 };

describe("billingService.accessStatus", () => {
  it("devolve o status do grant do owner", async () => {
    const service = createBillingService({ db: makeDb([{ status: "active" }]), metering, ...DEPS });
    expect(await service.accessStatus(ORG)).toEqual({ status: "active" });
  });

  it("default pending quando não há grant", async () => {
    const service = createBillingService({ db: makeDb([]), metering, ...DEPS });
    expect(await service.accessStatus(ORG)).toEqual({ status: "pending" });
  });
});

describe("billingService.costs", () => {
  it("rollup por conta + não-atribuído (chat) + cap", async () => {
    const summarize = vi.fn(async () => ({
      orgId: ORG,
      period: "2026-08",
      totalCostUsd: 30,
      byType: { unit: 20, conversation: 10 },
    }));
    const service = createBillingService({
      db: makeDb([{ accountId: "a1", accountName: "Loja A", total: "20" }]),
      metering: { summarize } as unknown as MeteringPort,
      costCapUsd: 5,
    });

    const out = await service.costs(ORG, "2026-08");
    expect(out.totalCostUsd).toBe(30);
    expect(out.byAccount).toEqual([{ accountId: "a1", accountName: "Loja A", costUsd: 20 }]);
    expect(out.unattributedCostUsd).toBe(10); // 30 total - 20 atribuído (chat = run_id null)
    expect(out.capUsd).toBe(5);
  });
});

import { describe, expect, it, vi } from "vitest";
import type { Database } from "@trafego/db";
import type { OrgId } from "@trafego/shared/types";
import type { MeteringPort } from "@trafego/shared/ports";
import { createBillingService } from "./service.js";

/**
 * DB fake por FILA: cada `select(...)` inicia uma query que consome o próximo
 * resultado; from/innerJoin/where/groupBy/orderBy/limit encadeiam; o nó é thenable
 * (await resolve o resultado). costs() faz 3 queries (byType → byDay → byAccount).
 */
function fakeDb(queue: unknown[][]): Database {
  let i = 0;
  const make = () => {
    const result = queue[i++] ?? [];
    const chain: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") return (res: (v: unknown) => void) => res(result);
          return () => chain;
        },
      },
    );
    return chain;
  };
  return new Proxy({}, { get: () => make }) as unknown as Database;
}

const metering = { summarize: vi.fn() } as unknown as MeteringPort;
const ORG = "o1" as OrgId;
const DEPS = { costCapUsd: 5 };

describe("billingService.accessStatus", () => {
  it("devolve o status do grant do owner", async () => {
    const service = createBillingService({ db: fakeDb([[{ status: "active" }]]), metering, ...DEPS });
    expect(await service.accessStatus(ORG)).toEqual({ status: "active" });
  });

  it("default pending quando não há grant", async () => {
    const service = createBillingService({ db: fakeDb([[]]), metering, ...DEPS });
    expect(await service.accessStatus(ORG)).toEqual({ status: "pending" });
  });
});

describe("billingService.costs (range por dia)", () => {
  it("total + série diária + por conta + não-atribuído + cap", async () => {
    const db = fakeDb([
      // 1) byType (cobre todas as linhas → total)
      [
        { type: "unit", total: "20" },
        { type: "conversation", total: "10" },
      ],
      // 2) byDay
      [
        { date: "2026-08-01", total: "12" },
        { date: "2026-08-02", total: "18" },
      ],
      // 3) byAccount (só linhas com run→conta)
      [{ accountId: "a1", accountName: "Loja A", total: "20" }],
    ]);
    const service = createBillingService({ db, metering, costCapUsd: 5 });

    const out = await service.costs(ORG, "2026-08-01", "2026-08-31");
    expect(out.since).toBe("2026-08-01");
    expect(out.until).toBe("2026-08-31");
    expect(out.totalCostUsd).toBe(30);
    expect(out.byDay).toEqual([
      { date: "2026-08-01", costUsd: 12 },
      { date: "2026-08-02", costUsd: 18 },
    ]);
    expect(out.byType).toEqual({ unit: 20, conversation: 10 });
    expect(out.byAccount).toEqual([{ accountId: "a1", accountName: "Loja A", costUsd: 20 }]);
    expect(out.unattributedCostUsd).toBe(10); // 30 total - 20 atribuído (chat = run_id null)
    expect(out.capUsd).toBe(5);
  });
});

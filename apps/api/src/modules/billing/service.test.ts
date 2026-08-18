import { describe, expect, it, vi } from "vitest";
import type { Database } from "@trafego/db";
import type { OrgId } from "@trafego/shared/types";
import type { MeteringPort } from "@trafego/shared/ports";
import { createBillingService } from "./service.js";

/** DB falso: cadeia select→from→innerJoin(×n)→where→limit devolve `rows`. */
function makeDb(rows: unknown[]): Database {
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => rows,
  };
  return { select: () => chain } as unknown as Database;
}

const metering = { summarize: vi.fn() } as unknown as MeteringPort;
const ORG = "o1" as OrgId;

describe("billingService.accessStatus", () => {
  it("devolve o status do grant do owner", async () => {
    const service = createBillingService({ db: makeDb([{ status: "active" }]), metering });
    expect(await service.accessStatus(ORG)).toEqual({ status: "active" });
  });

  it("default pending quando não há grant", async () => {
    const service = createBillingService({ db: makeDb([]), metering });
    expect(await service.accessStatus(ORG)).toEqual({ status: "pending" });
  });
});

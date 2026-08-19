import { describe, expect, it, vi } from "vitest";
import type { OrgId } from "@trafego/shared/types";
import type { AccountsRepo, AdAccountRow } from "./repo.js";
import { createAccountsService } from "./service.js";

const ORG = "o1" as OrgId;

function makeRepo(overrides: Partial<AccountsRepo> = {}): AccountsRepo {
  return {
    listByOrg: vi.fn(async () => []),
    ...overrides,
  };
}

function sampleRow(): AdAccountRow {
  return {
    id: "a1",
    adAccountId: "1",
    name: "Conta A",
    currency: "BRL",
    status: "active",
    tokenStatus: "valid",
    lastValidatedAt: new Date("2026-08-18T00:00:00.000Z"),
  };
}

describe("accountsService.list", () => {
  it("mapeia as linhas do repo p/ output", async () => {
    const repo = makeRepo({ listByOrg: vi.fn(async () => [sampleRow()]) });
    const service = createAccountsService({ repo });

    const out = await service.list(ORG);

    expect(out).toEqual([
      {
        id: "a1",
        adAccountId: "1",
        name: "Conta A",
        currency: "BRL",
        status: "active",
        tokenStatus: "valid",
        lastValidatedAt: "2026-08-18T00:00:00.000Z",
      },
    ]);
  });
});

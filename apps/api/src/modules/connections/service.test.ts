import { describe, expect, it, vi } from "vitest";
import type { OrgId } from "@trafego/shared/types";
import type { AccessibleAccount } from "@trafego/shared";
import { createConnectionsService } from "./service.js";
import type { ConnectionsRepo, ConnectionWithToken } from "./repo.js";

const ORG = "org-1" as OrgId;
const CONNECTION_ID = "conn-1";

const TOKEN_CRIPTO = { ciphertext: "c", iv: "i", tag: "t", keyVersion: 1 };

function makeConnection(): ConnectionWithToken {
  return { id: CONNECTION_ID, externalBusinessId: "biz-1", tokenCripto: TOKEN_CRIPTO };
}

function makeAvailable(): AccessibleAccount[] {
  return [
    { id: "act-1", name: "Conta 1", currency: "BRL" },
    { id: "act-2", name: "Conta 2", currency: "BRL" },
  ];
}

/** Repo fake: só os métodos usados por `select()`; o resto lança se chamado. */
function makeRepo(overrides: Partial<ConnectionsRepo> = {}): ConnectionsRepo {
  return {
    create: vi.fn(),
    findByExternalBusinessId: vi.fn(),
    updateToken: vi.fn(),
    list: vi.fn(),
    get: vi.fn(async () => makeConnection()),
    listManaged: vi.fn(async () => []),
    managedElsewhereIds: vi.fn(async () => []),
    applySelect: vi.fn(async () => ["internal-act-1", "internal-act-2"]),
    applySync: vi.fn(),
    markTokenStatus: vi.fn(),
    ...overrides,
  } as unknown as ConnectionsRepo;
}

describe("connections.select", () => {
  it("garante o agente (ensureAgent) de cada conta recém-ativada — zero-config (CLAUDE.md §10)", async () => {
    const repo = makeRepo();
    const ensureAgent = vi.fn(async () => ({ agentId: "ag-x" }));
    const service = createConnectionsService({
      repo,
      adsPlatform: { listAccessibleAccounts: vi.fn(async () => makeAvailable()) } as never,
      vault: { encrypt: vi.fn((v: string) => v), decrypt: vi.fn(() => "token") } as never,
      ensureAgent,
    });

    await service.select(ORG, CONNECTION_ID, { adAccountIds: ["act-1", "act-2"] });

    expect(ensureAgent).toHaveBeenCalledTimes(2);
    expect(ensureAgent).toHaveBeenCalledWith(ORG, "internal-act-1");
    expect(ensureAgent).toHaveBeenCalledWith(ORG, "internal-act-2");
  });

  it("nenhuma conta ativada (só desmarcou) → não chama ensureAgent", async () => {
    const repo = makeRepo({ applySelect: vi.fn(async () => []) });
    const ensureAgent = vi.fn(async () => ({ agentId: "ag-x" }));
    const service = createConnectionsService({
      repo,
      adsPlatform: { listAccessibleAccounts: vi.fn(async () => makeAvailable()) } as never,
      vault: { encrypt: vi.fn((v: string) => v), decrypt: vi.fn(() => "token") } as never,
      ensureAgent,
    });

    await service.select(ORG, CONNECTION_ID, { adAccountIds: [] });

    expect(ensureAgent).not.toHaveBeenCalled();
  });
});

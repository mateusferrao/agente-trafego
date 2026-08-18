import { describe, expect, it, vi } from "vitest";
import type { OrgId, AccessibleAccount as AdsAccount } from "@trafego/shared/types";
import type { AdsPlatformPort, CredentialVaultPort } from "@trafego/shared/ports";
import { AdsPlatformError } from "@trafego/shared/ports";
import type { AccountsRepo, AdAccountRow } from "./repo.js";
import { createAccountsService } from "./service.js";

const ORG = "o1" as OrgId;
const TOKEN = "system-user-token-1234567890";

const ENCRYPTED = { ciphertext: "c", iv: "i", tag: "t", keyVersion: 1 } as const;

function makeVault(): CredentialVaultPort {
  return { encrypt: vi.fn(() => ENCRYPTED), decrypt: vi.fn(() => TOKEN) };
}

function makeAds(overrides: Partial<AdsPlatformPort> = {}): AdsPlatformPort {
  return {
    listAccessibleAccounts: vi.fn(async (): Promise<AdsAccount[]> => []),
    getAdAccount: vi.fn(async (): Promise<AdsAccount> => ({ id: "1", name: "Conta A" })),
    listEntities: vi.fn(),
    getInsights: vi.fn(),
    getCreatives: vi.fn(),
    mutate: vi.fn(),
    ...overrides,
  } as unknown as AdsPlatformPort;
}

function makeRepo(overrides: Partial<AccountsRepo> = {}): AccountsRepo {
  return {
    listByOrg: vi.fn(async () => []),
    upsert: vi.fn(async () => sampleRow()),
    ...overrides,
  };
}

function sampleRow(): AdAccountRow {
  return {
    id: "a1",
    adAccountId: "1",
    name: "Conta A",
    currency: "BRL",
    tokenStatus: "valid",
    lastValidatedAt: new Date("2026-08-18T00:00:00.000Z"),
  };
}

describe("accountsService.connectToken", () => {
  it("token válido → lista contas (sem expor businessId)", async () => {
    const ads = makeAds({
      listAccessibleAccounts: vi.fn(async () => [
        { id: "1", name: "Conta A", currency: "BRL", businessId: "b1" },
      ]),
    });
    const service = createAccountsService({ repo: makeRepo(), adsPlatform: ads, vault: makeVault() });

    const accounts = await service.connectToken(ORG, { token: TOKEN });

    expect(accounts).toEqual([{ id: "1", name: "Conta A", currency: "BRL" }]);
    expect(ads.listAccessibleAccounts).toHaveBeenCalledWith(TOKEN);
  });

  it("token inválido → propaga AdsPlatformError (mapeado p/ HTTP na casca)", async () => {
    const ads = makeAds({
      listAccessibleAccounts: vi.fn(async () => {
        throw new AdsPlatformError("invalid_credential", "Invalid OAuth access token");
      }),
    });
    const service = createAccountsService({ repo: makeRepo(), adsPlatform: ads, vault: makeVault() });

    await expect(service.connectToken(ORG, { token: TOKEN })).rejects.toBeInstanceOf(AdsPlatformError);
  });
});

describe("accountsService.selectAccount", () => {
  it("cifra o token, persiste via repo e devolve o output", async () => {
    const ads = makeAds({
      getAdAccount: vi.fn(async () => ({ id: "1", name: "Conta A", currency: "BRL", businessId: "b1" })),
    });
    const vault = makeVault();
    const repo = makeRepo();
    const service = createAccountsService({ repo, adsPlatform: ads, vault });

    const out = await service.selectAccount(ORG, { token: TOKEN, adAccountId: "1" });

    expect(vault.encrypt).toHaveBeenCalledWith(TOKEN);
    expect(repo.upsert).toHaveBeenCalledWith(ORG, {
      metaBusinessId: "b1",
      adAccountId: "1",
      name: "Conta A",
      currency: "BRL",
      tokenCripto: ENCRYPTED,
    });
    expect(out).toEqual({
      id: "a1",
      adAccountId: "1",
      name: "Conta A",
      currency: "BRL",
      tokenStatus: "valid",
      lastValidatedAt: "2026-08-18T00:00:00.000Z",
    });
  });
});

describe("accountsService.list", () => {
  it("mapeia as linhas do repo p/ output", async () => {
    const repo = makeRepo({ listByOrg: vi.fn(async () => [sampleRow()]) });
    const service = createAccountsService({ repo, adsPlatform: makeAds(), vault: makeVault() });

    const out = await service.list(ORG);

    expect(out).toEqual([
      {
        id: "a1",
        adAccountId: "1",
        name: "Conta A",
        currency: "BRL",
        tokenStatus: "valid",
        lastValidatedAt: "2026-08-18T00:00:00.000Z",
      },
    ]);
  });
});

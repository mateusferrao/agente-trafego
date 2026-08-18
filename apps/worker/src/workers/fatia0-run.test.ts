import { describe, expect, it, vi } from "vitest";
import { formatSpendMessage } from "@trafego/shared";
import type { ChannelInstanceRef, OutboundMessage } from "@trafego/shared/ports";
import type { EncryptedPayload } from "@trafego/shared/types";
import type { WorkerDeps } from "../composition.js";
import { runAnalysis } from "./fatia0-run.js";

const TOKEN_CRIPTO: EncryptedPayload = { ciphertext: "ct", iv: "iv", tag: "tg", keyVersion: 1 };

interface AccountRow {
  id: string;
  adAccountId: string;
  name: string | null;
  currency: string | null;
  tokenCripto: EncryptedPayload;
}

function makeDeps(account: AccountRow | undefined) {
  const vault = { decrypt: vi.fn(() => "DECRYPTED-TOKEN"), encrypt: vi.fn() };
  const ads = {
    getInsights: vi.fn(async () => [
      { entityId: "act_123", level: "account", metrics: { spend: 42.5, impressions: 0, clicks: 0, ctr: 0, cpc: 0, cpm: 0 } },
    ]),
  };
  const messaging = {
    sendMessage: vi.fn(async (_instance: ChannelInstanceRef, _msg: OutboundMessage) => undefined),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
  const db = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => (account ? [account] : []) }) }) }),
  };
  const deps = {
    db,
    logger,
    ports: { vault, ads, messaging, scheduler: {}, llm: {}, metering: {}, approval: {} },
    checkpointer: undefined,
    fatia0: { evolutionInstance: "inst-1", recipientPhone: "5511999999999" },
  } as unknown as WorkerDeps;
  return { deps, vault, ads, messaging, logger };
}

const ACCOUNT: AccountRow = {
  id: "acct-1",
  adAccountId: "123",
  name: "Minha Conta",
  currency: "BRL",
  tokenCripto: TOKEN_CRIPTO,
};

describe("runAnalysis (fio da Fatia 0)", () => {
  it("decripta token → getInsights(spend/7d) → envia mensagem formatada", async () => {
    const { deps, vault, ads, messaging } = makeDeps(ACCOUNT);

    await runAnalysis(deps, { accountId: "acct-1", orgId: "org-1", trigger: "manual" });

    expect(vault.decrypt).toHaveBeenCalledWith(TOKEN_CRIPTO);
    expect(ads.getInsights).toHaveBeenCalledWith({
      account: { adAccountId: "123", accessToken: "DECRYPTED-TOKEN" },
      level: "account",
      window: "last_7d",
      fields: ["spend"],
    });
    const expected = formatSpendMessage({
      accountName: "Minha Conta",
      currency: "BRL",
      spend: 42.5,
      windowLabel: "nos últimos 7 dias",
    });
    expect(messaging.sendMessage).toHaveBeenCalledWith(
      { instanceId: "inst-1" },
      { to: "5511999999999", text: expected },
    );
  });

  it("usa fallbacks quando name/currency são nulos", async () => {
    const { deps, messaging } = makeDeps({ ...ACCOUNT, name: null, currency: null });

    await runAnalysis(deps, { accountId: "acct-1", orgId: "org-1", trigger: "manual" });

    const sent = messaging.sendMessage.mock.calls[0]![1];
    expect(sent.text).toContain("Conta 123:"); // fallback p/ adAccountId
    expect(sent.text).toContain("BRL"); // fallback de moeda
  });

  it("conta não encontrada → não envia e loga aviso", async () => {
    const { deps, messaging, logger } = makeDeps(undefined);

    await runAnalysis(deps, { accountId: "sumiu", orgId: "org-1", trigger: "manual" });

    expect(messaging.sendMessage).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from "vitest";
import { agents, type Database } from "@trafego/db";
import { configToolsFor, deliverReply, resolveFocusedAgent } from "./turn.js";
import type { SendToConversation } from "../notify/send-to-contact.js";
import { CONFIG_CHAT_TOOL_NAMES } from "../../graphs/whatsapp-conversation/tools.js";

const REF = { kind: "contact" as const, contactId: "contact-1" };

function fakeLogger() {
  return { info: vi.fn(), error: vi.fn() };
}

/** DB falso: devolve UMA linha de agente (autonomyPolicy) na leitura. */
function fakeDb(autonomyPolicy: unknown) {
  return {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ autonomyPolicy }] }) }) }),
  } as unknown as Database;
}

describe("configToolsFor (kill-switch da auto-config por chat, S2.3)", () => {
  it("ausente (default) → ON: liga TODAS as tools de config", async () => {
    const r = await configToolsFor(fakeDb({ bySource: { playbook: "suggest", llm: "suggest" } }), "org-1", "ag-1");
    expect(r.enabled).toBe(true);
    expect(new Set(r.tools)).toEqual(CONFIG_CHAT_TOOL_NAMES);
  });

  it("autoConfigViaChat=true → ON", async () => {
    const r = await configToolsFor(fakeDb({ bySource: { playbook: "suggest", llm: "suggest" }, autoConfigViaChat: true }), "o", "a");
    expect(r.enabled).toBe(true);
    expect(r.tools.length).toBeGreaterThan(0);
  });

  it("autoConfigViaChat=false → OFF: nenhuma tool de config entra na allowlist", async () => {
    const r = await configToolsFor(fakeDb({ bySource: { playbook: "suggest", llm: "suggest" }, autoConfigViaChat: false }), "o", "a");
    expect(r.enabled).toBe(false);
    expect(r.tools).toEqual([]);
  });
});

describe("resolveFocusedAgent (staleness do foco, S4 — último uso)", () => {
  const TTL = 12;
  const MS_H = 3_600_000;
  const AGENT_ROW = [{ agentId: "ag-B", adAccountId: "acc-B", accountName: "Clínica B" }];

  function focusDb(conv: { focusedAccountId: string | null; focusedAt: Date | null }) {
    const updateSet = vi.fn();
    let target: unknown[] = [];
    const chain: Record<string, unknown> = {
      select: () => chain,
      from: (t: unknown) => {
        target = t === agents ? AGENT_ROW : [conv];
        return chain;
      },
      innerJoin: () => chain,
      where: () => chain,
      limit: () => chain,
      then: (resolve: (v: unknown[]) => unknown) => resolve(target),
      update: () => ({
        set: (v: unknown) => {
          updateSet(v);
          return { where: async () => {} };
        },
      }),
    };
    return { db: chain as unknown as Database, updateSet };
  }

  it("foco fresco → resolve o agente E renova o carimbo (bump de último uso)", async () => {
    const { db, updateSet } = focusDb({ focusedAccountId: "acc-B", focusedAt: new Date() });
    const r = await resolveFocusedAgent(db, "org-1", "cv-1", TTL);
    expect(r?.agentId).toBe("ag-B");
    expect(updateSet).toHaveBeenCalledWith({ focusedAt: expect.any(Date) });
  });

  it("foco velho (> TTL) → null (perde precedência), sem bump", async () => {
    const { db, updateSet } = focusDb({ focusedAccountId: "acc-B", focusedAt: new Date(Date.now() - 20 * MS_H) });
    expect(await resolveFocusedAgent(db, "org-1", "cv-1", TTL)).toBeNull();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("foco sem carimbo (focusedAt null) → null (legado/desconhecido perde precedência)", async () => {
    const { db } = focusDb({ focusedAccountId: "acc-B", focusedAt: null });
    expect(await resolveFocusedAgent(db, "org-1", "cv-1", TTL)).toBeNull();
  });

  it("sem foco (focusedAccountId null) → null", async () => {
    const { db } = focusDb({ focusedAccountId: null, focusedAt: null });
    expect(await resolveFocusedAgent(db, "org-1", "cv-1", TTL)).toBeNull();
  });
});

describe("deliverReply (robustez de envio, F2)", () => {
  it("envio ok → loga replied", async () => {
    const send = vi.fn(async () => true) as unknown as SendToConversation;
    const logger = fakeLogger();
    await deliverReply(send, REF, "oi", logger, "org-1");
    expect(logger.info).toHaveBeenCalledOnce();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("envio falha (Evolution fora) → NÃO propaga (não relança o grafo), só loga error", async () => {
    const send = vi.fn(async () => {
      throw new Error("evolution 500");
    }) as unknown as SendToConversation;
    const logger = fakeLogger();
    // não deve rejeitar — propagar faria o BullMQ re-invocar o grafo e re-gastar LLM
    await expect(deliverReply(send, REF, "oi", logger, "org-1")).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledOnce();
  });
});

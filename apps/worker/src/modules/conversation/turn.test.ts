import { describe, expect, it, vi } from "vitest";
import type { Database } from "@trafego/db";
import { configToolsFor, deliverReply } from "./turn.js";
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

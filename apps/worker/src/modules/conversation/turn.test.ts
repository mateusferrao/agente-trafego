import { describe, expect, it, vi } from "vitest";
import { agents, type Database } from "@trafego/db";
import { buildInContextAllow, configToolsFor, deliverReply, GROUP_CONCIERGE_ALLOW, resolveExplicitFocus, resolveFocusedAgent } from "./turn.js";
import { isDeliberateAccountReference } from "./account-focus.js";
import type { SendToConversation } from "../notify/send-to-contact.js";
import {
  AGENT_TOOL_NAMES,
  CONFIG_CHAT_TOOL_NAMES,
  GROUP_CONCIERGE_TOOL_NAMES,
  REFINE_TOOL_NAMES,
  WRITE_TOOL_NAMES,
} from "../../graphs/whatsapp-conversation/tools.js";

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

describe("GROUP_CONCIERGE_ALLOW (fix same-turn: focar+configurar no mesmo papo)", () => {
  it("binda config (set_notifications/set_goal) além dos reads e do set_focus", () => {
    expect(GROUP_CONCIERGE_ALLOW.has("set_notifications")).toBe(true);
    expect(GROUP_CONCIERGE_ALLOW.has("set_goal")).toBe(true);
    expect(GROUP_CONCIERGE_ALLOW.has("set_focus")).toBe(true);
    expect(GROUP_CONCIERGE_ALLOW.has("get_account_status")).toBe(true);
  });
  it("é superconjunto do concierge de grupo + config", () => {
    for (const t of GROUP_CONCIERGE_TOOL_NAMES) expect(GROUP_CONCIERGE_ALLOW.has(t)).toBe(true);
    for (const t of CONFIG_CHAT_TOOL_NAMES) expect(GROUP_CONCIERGE_ALLOW.has(t)).toBe(true);
  });
});

describe("buildInContextAllow (kill-switch da escrita conversacional de ads, v1)", () => {
  const writeTools = [...WRITE_TOOL_NAMES, "create_campaign", "copy_campaign", "scale_winner"];
  const configTools = [...CONFIG_CHAT_TOOL_NAMES];

  it("chatAdsWrites OFF (freio de emergência) → NENHUMA tool de escrita/criação/refino entra", () => {
    const allow = buildInContextAllow({ writeTools, configTools, chatAdsWrites: false });
    // escrita Meta + criação + refino fora
    for (const t of [...writeTools, ...REFINE_TOOL_NAMES]) expect(allow.has(t)).toBe(false);
    // base (leitura + approve/reject + revert + confirm/cancel) e config seguem
    expect(allow.has("approve")).toBe(true);
    expect(allow.has("reject")).toBe(true);
    expect(allow.has("revert_action")).toBe(true);
    expect(allow.has("confirm_write")).toBe(true);
    expect(allow.has("get_account_status")).toBe(true);
    expect(allow.has("set_goal")).toBe(true);
  });

  it("chatAdsWrites ON → escrita/criação/refino voltam ao toolset (reverso da flag)", () => {
    const allow = buildInContextAllow({ writeTools, configTools, chatAdsWrites: true });
    for (const t of [...writeTools, ...REFINE_TOOL_NAMES]) expect(allow.has(t)).toBe(true);
    expect(allow.has("approve")).toBe(true);
  });

  it("base sempre-ligada = AGENT_TOOL_NAMES, independente da flag", () => {
    const off = buildInContextAllow({ writeTools, configTools: [], chatAdsWrites: false });
    for (const t of AGENT_TOOL_NAMES) expect(off.has(t)).toBe(true);
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

describe("resolveExplicitFocus (S6b — foco por menção explícita na mensagem, pré-grafo)", () => {
  type Cand = { id: string; name: string | null; adAccountId: string; agentId: string | null };
  function explicitDb(candidates: Cand[]) {
    const updateSet = vi.fn();
    const chain: Record<string, unknown> = {
      select: () => chain,
      from: () => chain,
      leftJoin: () => chain,
      where: () => chain,
      orderBy: () => chain,
      then: (resolve: (v: unknown[]) => unknown) => resolve(candidates),
      update: () => ({
        set: (v: unknown) => {
          updateSet(v);
          return { where: async () => {} };
        },
      }),
    };
    return { db: chain as unknown as Database, updateSet };
  }
  const TWO: Cand[] = [
    { id: "acc-A", name: "Automato", adAccountId: "act_1", agentId: "ag-A" },
    { id: "acc-B", name: "Loja do João", adAccountId: "act_2", agentId: "ag-B" },
  ];

  it("nome inequívoco na frase → resolve o agente E persiste o foco", async () => {
    const { db, updateSet } = explicitDb(TWO);
    const r = await resolveExplicitFocus(db, "org-1", "cv-1", "ativa a campanha X da conta Automato");
    expect(r).toEqual({ agentId: "ag-A", adAccountId: "acc-A", accountName: "Automato" });
    expect(updateSet).toHaveBeenCalledWith({ focusedAccountId: "acc-A", focusedAt: expect.any(Date) });
  });

  it("dois nomes de conta citados → ambíguo → null (mantém concierge), sem persistir", async () => {
    const cands: Cand[] = [
      { id: "acc-A", name: "Automato", adAccountId: "act_1", agentId: "ag-A" },
      { id: "acc-C", name: "CaquiAI", adAccountId: "act_3", agentId: "ag-C" },
    ];
    const { db, updateSet } = explicitDb(cands);
    expect(await resolveExplicitFocus(db, "org-1", "cv-1", "ativa a CaquiAI na conta Automato")).toBeNull();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("nenhuma conta nomeada → null (concierge pergunta a conta)", async () => {
    const { db, updateSet } = explicitDb(TWO);
    expect(await resolveExplicitFocus(db, "org-1", "cv-1", "ativa a campanha de lead")).toBeNull();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("conta nomeada SEM agente ativo → null (não dá pra operar nela), sem persistir", async () => {
    const { db, updateSet } = explicitDb([{ id: "acc-A", name: "Automato", adAccountId: "act_1", agentId: null }]);
    expect(await resolveExplicitFocus(db, "org-1", "cv-1", "ativa algo na conta Automato")).toBeNull();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("org sem contas focáveis → null (sem chamar o match)", async () => {
    const { db } = explicitDb([]);
    expect(await resolveExplicitFocus(db, "org-1", "cv-1", "ativa a conta Automato")).toBeNull();
  });

  it("nome curto de palavra COMUM coincidindo com a frase → NÃO foca (defere pro set_focus), sem persistir", async () => {
    // conta chamada "Vendas" (6 < min) e a frase menciona "vendas" sem se referir à conta.
    const { db, updateSet } = explicitDb([{ id: "acc-V", name: "Vendas", adAccountId: "act_9", agentId: "ag-V" }]);
    expect(await resolveExplicitFocus(db, "org-1", "cv-1", "sobe o budget das campanhas de vendas de inverno")).toBeNull();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("nome MULTI-palavra (mesmo com tokens curtos) → foca (sinal forte, contenção de 2+ tokens)", async () => {
    const { db, updateSet } = explicitDb([{ id: "acc-L", name: "Loja do João", adAccountId: "act_2", agentId: "ag-L" }]);
    const r = await resolveExplicitFocus(db, "org-1", "cv-1", "pausa a campanha da loja do joão");
    expect(r).toEqual({ agentId: "ag-L", adAccountId: "acc-L", accountName: "Loja do João" });
    expect(updateSet).toHaveBeenCalledOnce();
  });
});

describe("isDeliberateAccountReference (guarda anti-foco-espúrio, S6b)", () => {
  const cand = (name: string | null, adAccountId = "act_1") => ({ name, adAccountId });
  it("id externo no texto → true (referência inequívoca)", () => {
    expect(isDeliberateAccountReference(cand("Ads", "act_9"), "roda na act_9")).toBe(true);
  });
  it("nome multi-palavra → true", () => {
    expect(isDeliberateAccountReference(cand("BM - Automato"), "algo na bm automato")).toBe(true);
  });
  it("nome de palavra única distintivo (≥ min) → true", () => {
    expect(isDeliberateAccountReference(cand("Automato"), "ativa na conta automato")).toBe(true);
  });
  it("nome de palavra única curto/comum → false (defere)", () => {
    expect(isDeliberateAccountReference(cand("Lead"), "gera lead")).toBe(false);
    expect(isDeliberateAccountReference(cand("Vendas"), "de vendas")).toBe(false);
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

import { describe, expect, it } from "vitest";
import { buildChatRules } from "./system-prompt.js";

describe("buildChatRules — S0a: procedimento-por-tool migrou pra tools.ts", () => {
  it("chatAdsWrites ON: mantém a regra CROSS-CUTTING de escrita (eco+confirma, id antes do nome)", () => {
    const rules = buildChatRules(false, true);
    expect(rules).toContain("Escrita na conta");
    expect(rules).toContain("ECO concreto");
    expect(rules).toContain("get_campaign_analysis");
  });

  it("chatAdsWrites ON: NÃO duplica mais o procedimento de create_campaign (agora só na description da tool)", () => {
    const rules = buildChatRules(false, true);
    expect(rules).not.toContain("Nº de ANÚNCIOS: se o usuário disser quantos");
    expect(rules).not.toContain("COMPOSIÇÃO de criativo: o usuário pode dizer");
  });

  it("chatAdsWrites ON: NÃO duplica mais o procedimento de copy_campaign (agora só na description da tool)", () => {
    const rules = buildChatRules(false, true);
    expect(rules).not.toContain("Para trocar o público (remarketing/exclusões): passe includeAudiences");
  });

  it("chatAdsWrites ON: NÃO duplica mais o procedimento de adjust_draft (agora só na description da tool)", () => {
    const rules = buildChatRules(false, true);
    expect(rules).not.toContain("Ajustes LEVES do rascunho pelo chat (adjust_draft)");
    expect(rules).not.toContain("REGRA GERAL do rascunho:");
  });

  it("chatAdsWrites ON: NÃO duplica mais o procedimento de scale_winner (agora só na description da tool)", () => {
    const rules = buildChatRules(false, true);
    expect(rules).not.toContain("Escalar vencedor (budget novo × crescer)");
  });

  it("chatAdsWrites ON: mantém a nota de 'modelo de mensagem' (não é procedimento de 1 tool só)", () => {
    const rules = buildChatRules(false, true);
    expect(rules.toLowerCase()).toContain("modelo de mensagem");
  });

  it("chatAdsWrites OFF: cauda de escrita desligada não muda (plataforma cria/edita)", () => {
    const rules = buildChatRules(false, false);
    expect(rules).toContain("Como a criação/edição/ação funciona no v1");
    expect(rules).toContain("NÃO diga \"vá criar no site\"");
  });
});

describe("buildChatRules — escolha de criativo por chat (kill-switch chatCreativePicker)", () => {
  it("picker OFF (v1 default): o AGENTE escolhe; NÃO oferece escolher; trocar é no site", () => {
    const rules = buildChatRules(false, true, false);
    expect(rules).toContain("EU escolho o criativo");
    expect(rules).toContain("NÃO ofereça ao usuário escolher os criativos");
    expect(rules).toContain("no site");
    // não deve pedir os nomes / oferecer a escolha
    expect(rules).not.toContain("quer escolher os criativos");
  });

  it("picker ON: volta a oferecer a escolha por nome (fast-follow ligado)", () => {
    const rules = buildChatRules(false, true, true);
    expect(rules).toContain("quer escolher os criativos");
    expect(rules).not.toContain("NÃO ofereça ao usuário escolher os criativos");
  });
});

describe("buildChatRules — config: needs-focus (concierge) × kill-switch OFF (site-only)", () => {
  // Concierge (org multi-conta sem foco): config NÃO está desligada — só precisa de foco.
  // Roy deve ROTEAR pra focar a conta, nunca remeter ao site (que era a confusão da BM - Automato).
  it("needsFocusForConfig ON: roteia pra FOCAR a conta, NÃO remete ao site", () => {
    const rules = buildChatRules(false, false, false, true);
    expect(rules).toContain("precisa de uma conta em foco");
    expect(rules).not.toContain("está desligada por aqui");
  });

  // In-context com kill-switch de auto-config OFF: aí SIM é pelo site (comportamento preservado).
  it("needsFocusForConfig ausente (default) + configViaChat OFF: mantém o site-only", () => {
    const rules = buildChatRules(false, false);
    expect(rules).toContain("está desligada por aqui");
    expect(rules).not.toContain("precisa de uma conta em foco");
  });
});

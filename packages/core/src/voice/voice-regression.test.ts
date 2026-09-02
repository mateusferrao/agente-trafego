// Regressão de VOZ: garante que os templates determinísticos do core não carregam o
// registro "de bot" (emoji fora da allowlist, plural robótico, jargão de IA) e que o
// pós-processador limpa o resto. Cinto contra regressão futura.
import { describe, expect, it } from "vitest";
import { WHATSAPP_ALLOWED_EMOJI } from "@trafego/shared";
import { buildMessageFallback } from "../message/index.js";
import { enforceVoice } from "../message/enforce-voice.js";
import { describeAccountHealthAlert } from "../account-health/index.js";
import { AI_JARGON_BLOCKLIST } from "./index.js";

const BANNED_EMOJI = ["📊", "🚀", "🙂", "🤖", "🔔", "✅", "🧪", "✨", "🎉", "👍", "🔥"];

/** Extrai qualquer emoji da string (faixas pictográficas comuns). */
function hasBannedEmoji(text: string): boolean {
  return BANNED_EMOJI.some((e) => text.includes(e));
}

describe("regressão de voz — templates determinísticos do core", () => {
  const fallback = buildMessageFallback({
    accountName: "Loja X",
    currency: "BRL",
    headline: "CPA acima da meta.",
    summary: "resumo",
    recommendations: [{ title: "Pausar A" }],
    money: { wastedSpend: 500, wastedPct: 20 },
  });

  it("buildMessageFallback: sem emoji de bot, mas mantém 💸 (money shot)", () => {
    expect(hasBannedEmoji(fallback)).toBe(false);
    expect(fallback).toContain("💸"); // âncora de valor permitida
  });

  it("account-health: sem emoji de bot; só ⚠️/💸 se algum", () => {
    const msg = describeAccountHealthAlert({ kind: "spend_cap", spendCapMajor: 100 }, "Loja X", "BRL");
    expect(hasBannedEmoji(msg)).toBe(false);
  });

  it("AI_JARGON_BLOCKLIST: nenhuma frase proibida vaza nos templates", () => {
    for (const phrase of AI_JARGON_BLOCKLIST) {
      expect(fallback.toLowerCase()).not.toContain(phrase.toLowerCase());
    }
  });

  it("allowlist de emoji é a fonte única (⚠️ + 💸)", () => {
    expect([...WHATSAPP_ALLOWED_EMOJI]).toEqual(["⚠️", "💸"]);
  });
});

describe("regressão de voz — pós-processador limpa saída do LLM", () => {
  it("remove abertura de assistente e capitaliza", () => {
    expect(enforceVoice("claro! seguem os números.")).toBe("Seguem os números.");
  });
});

import { describe, expect, it } from "vitest";
import { buildGroupTranscript, type GroupTranscriptEntry, type GroupTranscriptOptions } from "./index.js";

const NOW = new Date("2026-08-24T18:00:00Z");
const OPTS: GroupTranscriptOptions = {
  now: NOW,
  windowHours: 24,
  maxMessages: 25,
  maxTokens: 1500,
  botLabel: "Assistente",
  tz: "UTC",
};

function entry(over: Partial<GroupTranscriptEntry> = {}): GroupTranscriptEntry {
  return {
    authorPhone: "+5511999999999",
    authorName: "João",
    body: "oi",
    at: new Date("2026-08-24T17:00:00Z"),
    fromBot: false,
    ...over,
  };
}

describe("buildGroupTranscript", () => {
  it("vazio → string vazia (nenhum bloco injetado)", () => {
    expect(buildGroupTranscript([], OPTS)).toBe("");
  });

  it("formata 'Autor [dd/mm HH:MM]: texto' em UTC + cabeçalho com o agora", () => {
    const out = buildGroupTranscript([entry({ at: new Date("2026-08-24T14:32:00Z") })], OPTS);
    expect(out).toContain("João [24/08 14:32]: oi");
    expect(out).toContain("Agora: 24/08 18:00.");
    expect(out).toContain("NÃO é a mensagem atual");
  });

  it("exibe data/hora no fuso configurado (BRT), não em UTC", () => {
    const out = buildGroupTranscript([entry({ at: new Date("2026-08-24T14:32:00Z") })], { ...OPTS, tz: "America/Sao_Paulo" });
    expect(out).toContain("João [24/08 11:32]: oi"); // 14:32 UTC = 11:32 BRT
  });

  it("ordena cronologicamente (antiga → nova)", () => {
    const out = buildGroupTranscript(
      [
        entry({ body: "segunda", at: new Date("2026-08-24T17:30:00Z") }),
        entry({ body: "primeira", at: new Date("2026-08-24T17:00:00Z") }),
      ],
      OPTS,
    );
    expect(out.indexOf("primeira")).toBeLessThan(out.indexOf("segunda"));
  });

  it("filtra mensagens fora da janela de tempo", () => {
    const out = buildGroupTranscript(
      [
        entry({ body: "recente", at: new Date("2026-08-24T17:00:00Z") }),
        entry({ body: "velha", at: new Date("2026-08-22T17:00:00Z") }), // > 24h
      ],
      OPTS,
    );
    expect(out).toContain("recente");
    expect(out).not.toContain("velha");
  });

  it("mantém só as últimas maxMessages", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      entry({ body: `m${i}`, at: new Date(NOW.getTime() - (30 - i) * 60_000) }),
    );
    const out = buildGroupTranscript(many, { ...OPTS, maxMessages: 5 });
    expect(out).toContain("m29");
    expect(out).toContain("m25");
    expect(out).not.toContain("m24");
  });

  it("corta ao teto de tokens derrubando as mais antigas", () => {
    const big = Array.from({ length: 10 }, (_, i) =>
      entry({ body: "x".repeat(40), at: new Date(NOW.getTime() - (10 - i) * 60_000) }),
    );
    // teto minúsculo → sobra só a mais recente.
    const out = buildGroupTranscript(big, { ...OPTS, maxTokens: 20 });
    expect(out.split("\n").filter((l) => l.includes("]: xxxx")).length).toBeLessThan(10);
  });

  it("atribuição: pushName > fallback Participante-XXXX; bot usa botLabel", () => {
    const out = buildGroupTranscript(
      [
        entry({ authorName: null, authorPhone: "+5511987654321", body: "sem nome" }),
        entry({ fromBot: true, authorName: null, authorPhone: null, body: "resposta" }),
      ],
      OPTS,
    );
    expect(out).toContain("Participante-4321 [");
    expect(out).toContain("Assistente [");
  });

  it("body nulo → placeholder [mídia]", () => {
    const out = buildGroupTranscript([entry({ body: null })], OPTS);
    expect(out).toContain("]: [mídia]");
  });

  it("reply: mostra '↳ resp. a <autor>: \"trecho\"' e resolve o nome do autor citado pelas entradas", () => {
    const out = buildGroupTranscript(
      [
        entry({ authorName: "Thiago", authorPhone: "+5511777777777", body: "Oi", at: new Date("2026-08-24T17:00:00Z") }),
        entry({ authorName: "João", authorPhone: "+5511999999999", body: "e aí", at: new Date("2026-08-24T17:05:00Z"), quotedAuthorPhone: "+5511777777777", quotedSnippet: "Oi" }),
      ],
      OPTS,
    );
    expect(out).toContain('João [24/08 17:05] (↳ resp. a Thiago: "Oi"): e aí');
  });

  it("reply ao BOT → rotula como o assistente (não telefone)", () => {
    const out = buildGroupTranscript(
      [entry({ authorName: "João", body: "e a Y?", quotedFromBot: true, quotedSnippet: "pausei a X" })],
      OPTS,
    );
    expect(out).toContain('(↳ resp. a Assistente: "pausei a X")');
  });

  it("reply a autor fora da janela → fallback Participante-XXXX", () => {
    const out = buildGroupTranscript(
      [entry({ authorName: "João", body: "e aí", quotedAuthorPhone: "+5511777777777", quotedSnippet: "Oi" })],
      OPTS,
    );
    expect(out).toContain("(↳ resp. a Participante-7777");
  });
});

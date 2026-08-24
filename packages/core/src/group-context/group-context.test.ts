import { describe, expect, it } from "vitest";
import { buildGroupTranscript, type GroupTranscriptEntry, type GroupTranscriptOptions } from "./index.js";

const NOW = new Date("2026-08-24T18:00:00Z");
const OPTS: GroupTranscriptOptions = {
  now: NOW,
  windowHours: 24,
  maxMessages: 25,
  maxTokens: 1500,
  botLabel: "Assistente",
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
    expect(out).toContain("Agora: 24/08 18:00 (UTC).");
    expect(out).toContain("NÃO é a mensagem atual");
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
});

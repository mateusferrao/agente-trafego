import { describe, expect, it } from "vitest";
import { sanitizeWhatsappText } from "./whatsapp-format.js";

describe("sanitizeWhatsappText", () => {
  it("converte negrito markdown ** em * (WhatsApp)", () => {
    expect(sanitizeWhatsappText("isto é **importante** agora")).toBe("isto é *importante* agora");
  });

  it("colapsa 3+ asteriscos (***x***) em um só", () => {
    expect(sanitizeWhatsappText("olha ***isso*** aqui")).toBe("olha *isso* aqui");
  });

  it("remove títulos markdown no início de linha", () => {
    expect(sanitizeWhatsappText("# Título\ncorpo")).toBe("Título\ncorpo");
    expect(sanitizeWhatsappText("### Sub\ntexto")).toBe("Sub\ntexto");
  });

  it("converte bullets markdown estritos (- , * ) em •", () => {
    expect(sanitizeWhatsappText("- primeiro\n- segundo")).toBe("• primeiro\n• segundo");
    expect(sanitizeWhatsappText("* um\n* dois")).toBe("• um\n• dois");
  });

  it("não confunde hífen de valor no início de linha com bullet", () => {
    // sem espaço após o hífen → não é bullet
    expect(sanitizeWhatsappText("-R$ 50 economizados")).toBe("-R$ 50 economizados");
  });

  it("não confunde negrito de linha (*x*) com bullet", () => {
    expect(sanitizeWhatsappText("*destaque* na linha")).toBe("*destaque* na linha");
  });

  it("achata link markdown em texto (url)", () => {
    expect(sanitizeWhatsappText("veja [o site](https://x.com/a) hoje")).toBe("veja o site (https://x.com/a) hoje");
  });

  it("preserva URL crua intacta", () => {
    expect(sanitizeWhatsappText("Ver no site: https://x.com/a")).toBe("Ver no site: https://x.com/a");
  });

  it("normaliza tachado ~~ em ~", () => {
    expect(sanitizeWhatsappText("isso ~~não~~ vale")).toBe("isso ~não~ vale");
  });

  it("colapsa 3+ quebras de linha em uma linha em branco", () => {
    expect(sanitizeWhatsappText("a\n\n\n\nb")).toBe("a\n\nb");
  });

  it("faz trim das pontas", () => {
    expect(sanitizeWhatsappText("  oi\n")).toBe("oi");
  });

  it("não toca em itálico _x_ nem em monospace ```", () => {
    expect(sanitizeWhatsappText("_ênfase_ e ```cod```")).toBe("_ênfase_ e ```cod```");
  });

  it("é idempotente (aplicar 2× = 1×)", () => {
    const inputs = [
      "**b** e _i_ e ~~s~~",
      "# Título\n- item\n- outro",
      "veja [link](https://x.com) e ***forte***",
      "linha\n\n\n\noutra",
    ];
    for (const input of inputs) {
      const once = sanitizeWhatsappText(input);
      expect(sanitizeWhatsappText(once)).toBe(once);
    }
  });

  it("remove régua horizontal (---/***/___) — vira parágrafo, não '---' literal", () => {
    expect(sanitizeWhatsappText("bloco 1\n\n---\n\nbloco 2")).toBe("bloco 1\n\nbloco 2");
    expect(sanitizeWhatsappText("a\n\n***\n\nb")).toBe("a\n\nb");
    expect(sanitizeWhatsappText("a\n\n___\n\nb")).toBe("a\n\nb");
    expect(sanitizeWhatsappText("a\n- - -\nb")).toBe("a\nb");
  });

  it("NÃO confunde régua com negrito inline nem com hífen de valor", () => {
    expect(sanitizeWhatsappText("olha ***isso*** aqui")).toBe("olha *isso* aqui");
    expect(sanitizeWhatsappText("corta -- R$ 50")).toBe("corta -- R$ 50"); // 2 hífens, não é régua
    expect(sanitizeWhatsappText("• corta R$ 120")).toBe("• corta R$ 120");
  });

  it("deixa texto já-correto do WhatsApp inalterado", () => {
    const ok = "Vou pausar a campanha *Lançamento*.\n\n• corta R$ 120\n\nConfirma?";
    expect(sanitizeWhatsappText(ok)).toBe(ok);
  });

  it("passa os textos verbatim intactos (no-op sobre eco/capabilities já formatados)", () => {
    // formatos reais emitidos verbatim (echo/index.ts, tools.ts, notify) — a
    // sanitização NUNCA pode corrompê-los.
    const verbatim = [
      "Vou pausar a campanha *Lançamento Turma 8*. Confirma?",
      "Vou fazer:\n1. pausar a campanha *A*\n2. reativar o anúncio *B*\n\nConfirma as 2?",
      "📊 Ler: status, métricas, campanha\n✏️ Mexer: pausar, reativar, budget\n⚡ Analisar agora",
      "✅ Pausei *Campanha X*.",
      "🔔 2 ação(ões) aguardando seu OK. Responda por aqui pra aprovar/rejeitar, ou veja no site.",
    ];
    for (const v of verbatim) expect(sanitizeWhatsappText(v)).toBe(v);
  });
});

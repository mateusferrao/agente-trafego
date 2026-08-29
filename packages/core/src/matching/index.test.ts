import { describe, expect, it } from "vitest";
import { diceSimilarity, normalizeName, resolveNamedMatch } from "./index.js";

interface Row {
  readonly id: string;
  readonly name: string | null;
}
const byName = { name: (r: Row) => r.name, keys: (r: Row) => [r.id] };

describe("normalizeName", () => {
  it("acento/caixa/espaço/zero-à-esquerda irrelevantes; código numérico preservado", () => {
    expect(normalizeName("  Clínica   BH  ")).toBe("clinica bh");
    expect(normalizeName("Conta 01")).toBe("conta 1");
    expect(normalizeName("[1398 CAPTACAO]")).toContain("1398"); // código identity-bearing intacto
  });
});

describe("diceSimilarity", () => {
  it("idênticos = 1; não relacionados baixos", () => {
    expect(diceSimilarity("abc", "abc")).toBe(1);
    expect(diceSimilarity("loja norte", "clinica bh")).toBeLessThan(0.2);
  });
});

describe("resolveNamedMatch", () => {
  const campaigns: Row[] = [
    { id: "1", name: "[1398 CAPTACAO] [BLEFARO] [LEAD] [CBO] ESCALA - BH home-only" },
    { id: "2", name: "[1398 CAPTACAO] [BLEFARO] [LEAD] [CBO] ESCALA - BH home-only — Cópia 01" },
    { id: "3", name: "[1398 CAPTACAO] [BLEFARO] [LEAD] [CBO] ESCALA - BH home-only — Cópia 02" },
    { id: "9", name: "[CLAUDE OPUS] TOP 6 — WHATS 95349-1166" },
  ];

  it("nome ambíguo (3 ESCALA quase-iguais) → ambiguous com as linhas (id preservado p/ âncora)", () => {
    const m = resolveNamedMatch(campaigns, "ESCALA BH home-only", byName);
    expect(m.kind).toBe("ambiguous");
    if (m.kind !== "ambiguous") return;
    expect(m.rows.map((r) => r.id).sort()).toEqual(["1", "2", "3"]);
  });

  it("match exato por id cru → one", () => {
    const m = resolveNamedMatch(campaigns, "9", byName);
    expect(m).toEqual({ kind: "one", row: campaigns[3] });
  });

  it("nome bem distinto (folga clara) → autoescolhe", () => {
    const m = resolveNamedMatch(campaigns, "CLAUDE OPUS TOP 6", byName);
    expect(m).toEqual({ kind: "one", row: campaigns[3] });
  });

  it("query sem match plausível → none", () => {
    expect(resolveNamedMatch(campaigns, "campanha inexistente xyz", byName).kind).toBe("none");
  });

  it("lista vazia → none", () => {
    expect(resolveNamedMatch([], "qualquer", byName).kind).toBe("none");
  });

  it("cap de sugestões + omittedCount", () => {
    const many: Row[] = Array.from({ length: 8 }, (_, i) => ({ id: String(i), name: `Remarketing Loja ${i}` }));
    const m = resolveNamedMatch(many, "Remarketing Loja", byName);
    expect(m.kind).toBe("ambiguous");
    if (m.kind !== "ambiguous") return;
    expect(m.rows.length).toBe(5);
    expect(m.omittedCount).toBe(3);
  });
});

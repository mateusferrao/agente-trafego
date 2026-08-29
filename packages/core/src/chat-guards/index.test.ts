import { describe, expect, it } from "vitest";
import { checkPhoneAttribution, collectGroundedNumbers, flagUngroundedNumbers, parseNumberCandidates } from "./index.js";

describe("parseNumberCandidates (BR × US, leniente)", () => {
  it("US 1234.56 e BR 1.234,56 colapsam no mesmo valor", () => {
    expect(parseNumberCandidates("1234.56")).toContain(1234.56);
    expect(parseNumberCandidates("1.234,56")).toContain(1234.56);
  });
  it("percentual 2,06 vira 2.06", () => {
    expect(parseNumberCandidates("2,06")).toContain(2.06);
  });
});

describe("collectGroundedNumbers + flagUngroundedNumbers (soft, dinheiro+%)", () => {
  it("número da CONFIG do usuário (guidance) é ancorado — não sinaliza", () => {
    const known = collectGroundedNumbers({ toolResults: [], configText: ["CPL alvo ≤ R$ 7,00; teto R$ 14,00; CTR ≥ 2,0%"] });
    expect(flagUngroundedNumbers("Seu CPL alvo é R$ 7,00 e o teto R$ 14,00.", known)).toEqual([]);
  });

  it("número vindo de TOOL (JSON US) casa com a resposta em BR — sem falso-positivo de formato", () => {
    const known = collectGroundedNumbers({ toolResults: ['{"spend":1234.56,"ctr":2.06}'], configText: [] });
    expect(flagUngroundedNumbers("Gastou R$ 1.234,56 com CTR de 2,06%.", known)).toEqual([]);
  });

  it("valor de dinheiro INVENTADO (não está em fonte nenhuma) → sinaliza", () => {
    const known = collectGroundedNumbers({ toolResults: ['{"spend":100}'], configText: [] });
    const issues = flagUngroundedNumbers("Na verdade gastou R$ 987,65 ontem.", known);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ kind: "money" });
  });

  it("percentual inventado → sinaliza", () => {
    const known = collectGroundedNumbers({ toolResults: ['{"ctr":2.06}'], configText: [] });
    expect(flagUngroundedNumbers("O CTR foi 9,99%.", known)).toHaveLength(1);
  });

  it("contagem inteira solta NÃO é checada (fast-follow; evita falso-positivo)", () => {
    const known = collectGroundedNumbers({ toolResults: [], configText: [] });
    expect(flagUngroundedNumbers("Você tem 5 campanhas e 3 anúncios.", known)).toEqual([]);
  });

  it("histórico conta como fonte", () => {
    const known = collectGroundedNumbers({ toolResults: [], configText: [], history: ['{"spend":500.00}'] });
    expect(flagUngroundedNumbers("Como falei, R$ 500,00.", known)).toEqual([]);
  });
});

describe("checkPhoneAttribution (estrutural — a raiz do bug)", () => {
  it("telefone que NÃO veio de tool → suspeito (misatribuição)", () => {
    const allowed = new Set<string>(["5531983745587"]);
    expect(checkPhoneAttribution("O número é 95349-1166 na campanha TOP 6.", allowed)).toEqual(["953491166"]);
  });
  it("telefone que veio de tool → ok", () => {
    const allowed = new Set<string>(["953491166"]);
    expect(checkPhoneAttribution("O número é 95349-1166.", allowed)).toEqual([]);
  });
  it("sem telefone no texto → nada", () => {
    expect(checkPhoneAttribution("Rodei a análise e está tudo certo.", new Set())).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { brPhoneVariants, extractPhoneFromName, extractPhoneFromUrl } from "./phone.js";

describe("brPhoneVariants", () => {
  it("celular BR com o 9º dígito → inclui a variante sem o 9", () => {
    expect(brPhoneVariants("+5531983745587")).toEqual(["+5531983745587", "+553183745587"]);
  });

  it("celular BR sem o 9º dígito (quirk do WhatsApp/lid) → inclui a variante com o 9", () => {
    expect(brPhoneVariants("+553183745587")).toEqual(["+553183745587", "+5531983745587"]);
  });

  it("número não-BR → devolve só ele mesmo, sem variante", () => {
    expect(brPhoneVariants("+13115552368")).toEqual(["+13115552368"]);
  });

  it("BR mas comprimento fora do padrão de celular (ex: fixo, 8 dígitos com DDD de 3) → só ele mesmo", () => {
    expect(brPhoneVariants("+55113456")).toEqual(["+55113456"]);
  });
});

describe("extractPhoneFromUrl", () => {
  it("wa.me/<dígitos> → só dígitos", () => {
    expect(extractPhoneFromUrl("https://wa.me/5531953491166")).toBe("5531953491166");
  });

  it("api.whatsapp.com/send?phone=<dígitos> → extrai o phone", () => {
    expect(extractPhoneFromUrl("https://api.whatsapp.com/send?phone=5531953491166&text=oi")).toBe("5531953491166");
  });

  it("wa.me com query text → ignora o text", () => {
    expect(extractPhoneFromUrl("https://wa.me/5531953491166?text=ol%C3%A1")).toBe("5531953491166");
  });

  it("URL que não é de WhatsApp (site comum) → null", () => {
    expect(extractPhoneFromUrl("https://clinica.com.br/agende")).toBeNull();
  });

  it("string vazia / lixo → null", () => {
    expect(extractPhoneFromUrl("")).toBeNull();
    expect(extractPhoneFromUrl("not a url")).toBeNull();
  });

  it("wa.me com poucos dígitos (não é telefone) → null", () => {
    expect(extractPhoneFromUrl("https://wa.me/1398")).toBeNull();
  });
});

describe("extractPhoneFromName", () => {
  it("nome de campanha com WHATS <número completo> → extrai só dígitos", () => {
    expect(extractPhoneFromName("[CLAUDE OPUS] [BLEFARO] [LEAD] [CBO] TOP 6 — WHATS 95349-1166 — BH home-only")).toBe(
      "953491166",
    );
  });

  it("token curto/parcial ('1398') NÃO é telefone completo → null (o bug reportado)", () => {
    expect(extractPhoneFromName("[1398 CAPTACAO] [BLEFARO] [LEAD] [CBO] ESCALA - BH home-only")).toBeNull();
  });

  it("número com DDD e país no nome → dígitos", () => {
    expect(extractPhoneFromName("Remarketing WhatsApp +55 31 95349-1166")).toBe("5531953491166");
  });

  it("nome sem nenhum número plausível → null", () => {
    expect(extractPhoneFromName("Campanha de Remarketing — BH")).toBeNull();
  });

  it("nome com número curto irrelevante (TOP 6) mas sem telefone → null", () => {
    expect(extractPhoneFromName("[BLEFARO] TOP 6 - BH home-only")).toBeNull();
  });
});

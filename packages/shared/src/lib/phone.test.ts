import { describe, expect, it } from "vitest";
import { brPhoneVariants } from "./phone.js";

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

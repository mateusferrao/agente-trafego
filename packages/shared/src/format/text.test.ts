import { describe, expect, it } from "vitest";
import { plural, WHATSAPP_ALLOWED_EMOJI } from "./text.js";

describe("plural", () => {
  it("1 vira 'uma X'; N vira 'N Xs'", () => {
    expect(plural(1, "sugestão", "sugestões")).toBe("uma sugestão");
    expect(plural(4, "sugestão", "sugestões")).toBe("4 sugestões");
    expect(plural(0, "sugestão", "sugestões")).toBe("0 sugestões");
  });
  it("masculino via one='um'", () => {
    expect(plural(1, "ação", "ações", "uma")).toBe("uma ação");
    expect(plural(1, "resultado", "resultados", "um")).toBe("um resultado");
  });
});

describe("WHATSAPP_ALLOWED_EMOJI", () => {
  it("só marcadores funcionais (alerta + money)", () => {
    expect(WHATSAPP_ALLOWED_EMOJI).toEqual(["⚠️", "💸"]);
  });
});

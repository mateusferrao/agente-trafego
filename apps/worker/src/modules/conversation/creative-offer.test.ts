import { describe, expect, it } from "vitest";
import { isSimpleAffirmation } from "./creative-offer.js";

describe("isSimpleAffirmation (só o 'sim' puro resolve a oferta; o resto vai pro turno normal)", () => {
  it("aceita afirmações simples e inequívocas", () => {
    for (const t of ["sim", "Sim!", "pode", "usa", "cria", "quero", "bora", "ok", "beleza", "👍", " sim. "]) {
      expect(isSimpleAffirmation(t)).toBe(true);
    }
  });

  it("recusa frases compostas/ambíguas (vão pro turno normal, não resolvem no automático)", () => {
    for (const t of ["sim, mas muda o budget pra 80", "não", "usa o outro criativo", "qual público?", "cria uma de venda com público X", ""]) {
      expect(isSimpleAffirmation(t)).toBe(false);
    }
  });
});

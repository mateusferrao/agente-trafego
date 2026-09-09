import { describe, expect, it } from "vitest";
import { AdsPlatformError } from "@trafego/shared/ports";
import { metaUserMessage, permanentMetaReason } from "./meta-failure.js";

describe("metaUserMessage", () => {
  it("erro com userMessage → 'A Meta informou: …'", () => {
    expect(metaUserMessage(new AdsPlatformError("not_accessible", "tech", "Público inválido"))).toBe("A Meta informou: Público inválido");
  });
  it("sem userMessage / não-AdsPlatformError → undefined (nunca vaza message técnico)", () => {
    expect(metaUserMessage(new AdsPlatformError("upstream", "Internal error"))).toBeUndefined();
    expect(metaUserMessage(new Error("boom"))).toBeUndefined();
  });
});

describe("permanentMetaReason", () => {
  it("not_accessible (rejeição determinística) → razão honesta, não null", () => {
    const r = permanentMetaReason(new AdsPlatformError("not_accessible", "Invalid parameter", "Falta o pixel"));
    expect(r).toBe("a Meta recusou: Falta o pixel");
  });
  it("not_accessible sem texto legível → razão genérica honesta (não 'tenta de novo')", () => {
    const r = permanentMetaReason(new AdsPlatformError("not_accessible", "Invalid parameter"));
    expect(r).toContain("a Meta recusou");
    expect(r).not.toContain("Invalid parameter"); // não vaza jargão técnico em inglês
  });
  it("B3: recusa de idade+Advantage → voz do Roy + próximo passo (não repassa o texto cru)", () => {
    const r = permanentMetaReason(
      new AdsPlatformError("not_accessible", "tech", "Em vez disso, você pode adicionar uma idade mínima maior como sugestão ao criar ou editar um conjunto de anúncios."),
    );
    expect(r).toContain("otimização automática"); // fala da otimização (Advantage), não da Meta crua
    expect(r?.toLowerCase()).toContain("idade");
    expect(r).not.toContain("Em vez disso"); // não repassa o texto literal da Meta
  });
  it("invalid_credential → reconecte o token (não retry)", () => {
    expect(permanentMetaReason(new AdsPlatformError("invalid_credential", "190"))).toContain("reconecte o token");
  });
  it("not_duplicable → determinístico (razão honesta)", () => {
    expect(permanentMetaReason(new AdsPlatformError("not_duplicable", "x"))).toContain("a Meta recusou");
  });
  it("rate_limited / upstream / rede → null (transiente, retry vale)", () => {
    expect(permanentMetaReason(new AdsPlatformError("rate_limited", "throttle"))).toBeNull();
    expect(permanentMetaReason(new AdsPlatformError("upstream", "500"))).toBeNull();
    expect(permanentMetaReason(new Error("network"))).toBeNull();
  });
});

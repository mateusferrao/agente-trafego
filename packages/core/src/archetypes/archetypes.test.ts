import { describe, expect, it } from "vitest";
import { AGENT_NAME } from "@trafego/shared";
import {
  ARCHETYPE_DEFAULTS,
  DEFAULT_ARCHETYPE_KEY,
  archetypeCatalog,
  archetypeDefaults,
  composeAgentPrompt,
  composeAgentVoice,
  composeMethodologyPrompt,
} from "./index.js";

describe("archetypeDefaults", () => {
  it("expõe o conservador como default", () => {
    expect(DEFAULT_ARCHETYPE_KEY).toBe("conservador");
    expect(ARCHETYPE_DEFAULTS.conservador).toBeDefined();
  });

  it("conservador nunca aplica sozinho (só sugere) — coerente com read-only", () => {
    const a = archetypeDefaults("conservador");
    expect(a.autonomyPolicy.bySource.playbook).toBe("suggest");
    expect(a.autonomyPolicy.bySource.llm).toBe("suggest");
  });

  it("cai no conservador p/ chave desconhecida", () => {
    expect(archetypeDefaults("inexistente").key).toBe("conservador");
    expect(archetypeDefaults().key).toBe("conservador");
  });

  it("traz systemPrompt e goals vazio p/ zero-config", () => {
    const a = archetypeDefaults();
    expect(a.systemPrompt.length).toBeGreaterThan(0);
    expect(a.goals).toEqual({});
  });

  it("otimizador age no seguro no playbook; LLM pede OK (Fatia 6c)", () => {
    const a = archetypeDefaults("otimizador");
    expect(a.autonomyPolicy.bySource.playbook).toBe("act_safe");
    expect(a.autonomyPolicy.bySource.llm).toBe("suggest");
    expect(a.defaultCadence).toEqual({ kind: "daily", hour: 8 });
  });

  it("vigia intensivo: sugere+OK, cadência 2×/dia", () => {
    const a = archetypeDefaults("vigia_intensivo");
    expect(a.autonomyPolicy.bySource.playbook).toBe("suggest");
    expect(a.autonomyPolicy.bySource.llm).toBe("suggest");
    expect(a.defaultCadence).toEqual({ kind: "twice_daily", hours: [8, 18] });
  });

  it("semeia notify policy por arquétipo (F4): conservador quieto, vigia vigilante", () => {
    const conservador = archetypeDefaults("conservador");
    expect(conservador.defaultNotifyPolicy.pulse.enabled).toBe(false);
    expect(conservador.defaultNotifyPolicy.alerts.enabled).toBe(false);
    expect(conservador.defaultNotifyPolicy.runPush.enabled).toBe(true);

    const otimizador = archetypeDefaults("otimizador");
    expect(otimizador.defaultNotifyPolicy.pulse).toEqual({ enabled: true, cadence: { kind: "daily", hour: 8 } });
    expect(otimizador.defaultNotifyPolicy.alerts.sensitivity).toBe("normal");

    const vigia = archetypeDefaults("vigia_intensivo");
    expect(vigia.defaultNotifyPolicy.pulse.cadence).toEqual({ kind: "twice_daily", hours: [8, 18] });
    expect(vigia.defaultNotifyPolicy.alerts.sensitivity).toBe("high");
    expect(vigia.defaultNotifyPolicy.alerts.throttleHours).toBe(3);
  });

  it("catálogo expõe os 3 arquétipos com textos amigáveis", () => {
    const cat = archetypeCatalog();
    expect(cat.map((c) => c.key)).toEqual(["conservador", "otimizador", "vigia_intensivo"]);
    for (const c of cat) {
      expect(c.label.length).toBeGreaterThan(0);
      expect(c.description.length).toBeGreaterThan(0);
      expect(c.whenToUse.length).toBeGreaterThan(0);
    }
  });
});

describe("identidade: persona = papel, tom = afeto, stance = prioridade (sem overlap com postura)", () => {
  it("persona é papel/caráter, não método", () => {
    expect(archetypeDefaults("conservador").persona).toBe("Gestor de tráfego sênior, cauteloso e didático.");
    expect(archetypeDefaults("otimizador").persona).toBe("Gestor de tráfego sênior, obcecado por eficiência.");
  });

  it("tom é afeto/registro — não codifica diretividade/jargão (isso é postura)", () => {
    expect(archetypeDefaults("conservador").tone).toBe("acolhedor e paciente");
    expect(archetypeDefaults("otimizador").tone).toBe("firme e objetivo");
    // o afeto não deve reproduzir os termos da postura (consultivo/direto/sem jargão)
    for (const key of ["conservador", "otimizador", "vigia_intensivo"]) {
      const tone = archetypeDefaults(key).tone.toLowerCase();
      expect(tone).not.toContain("jargão");
      expect(tone).not.toContain("consultivo");
    }
  });

  it("methodology.stance é prioridade analítica, sem prosa de tom", () => {
    const s = archetypeDefaults("otimizador").methodology.stance;
    expect(s).toContain("Eficiência primeiro");
    expect(s.toLowerCase()).not.toContain("linguagem de dono");
  });

  it("composeMethodologyPrompt emite 'Prioridade analítica', não 'Postura:'", () => {
    const out = composeMethodologyPrompt(archetypeDefaults("conservador"));
    expect(out).toContain("Prioridade analítica:");
    expect(out).not.toContain("Postura:");
  });
});

describe("composeAgentPrompt", () => {
  const base = "PROMPT BASE";

  it("sem extras → devolve a base intacta", () => {
    expect(composeAgentPrompt(base)).toBe(base);
    expect(composeAgentPrompt(base, {})).toBe(base);
  });

  it("anexa contexto do negócio como bloco rotulado, preservando a base", () => {
    const out = composeAgentPrompt(base, { businessContext: "Lançamento até 30/08; público médico." });
    expect(out.startsWith(base)).toBe(true);
    expect(out).toContain("Contexto do negócio");
    expect(out).toContain("público médico");
  });

  it("anexa orientações como bloco rotulado", () => {
    const out = composeAgentPrompt(base, { guidance: "Não sugira pausar nos 3 primeiros dias." });
    expect(out).toContain("Orientações do dono");
    expect(out).toContain("3 primeiros dias");
  });

  it("ordem estável: base → contexto → orientações", () => {
    const out = composeAgentPrompt(base, { guidance: "GUIA", businessContext: "CTX" });
    expect(out.indexOf(base)).toBeLessThan(out.indexOf("CTX"));
    expect(out.indexOf("CTX")).toBeLessThan(out.indexOf("GUIA"));
  });

  it("ignora texto só-espaços (tratado como ausente)", () => {
    expect(composeAgentPrompt(base, { businessContext: "   ", guidance: "\n\t" })).toBe(base);
  });
});

describe("composeAgentVoice", () => {
  const input = {
    systemPrompt: null,
    archetype: "conservador",
    persona: null,
    tone: null,
    businessContext: null,
    guidance: null,
  };

  it("injeta o nome fixo Roy no início da identidade", () => {
    const out = composeAgentVoice(input);
    expect(out).toContain(`Você é ${AGENT_NAME}`);
    expect(out.startsWith(`Você é ${AGENT_NAME}`)).toBe(true); // nome vem primeiro
  });

  it("o nome PRECEDE a metodologia/persona (identidade acima do tom customizável)", () => {
    const out = composeAgentVoice({ ...input, persona: "Analista cauteloso", tone: "consultivo" });
    expect(out.indexOf(`Você é ${AGENT_NAME}`)).toBeLessThan(out.indexOf("Persona: Analista cauteloso"));
    expect(out).toContain("Tom da comunicação: consultivo");
  });

  it("preserva persona/tom/contexto do dono (não substitui, só antepõe o nome)", () => {
    const out = composeAgentVoice({ ...input, businessContext: "e-commerce de moda", guidance: "priorize leads" });
    expect(out).toContain("e-commerce de moda");
    expect(out).toContain("priorize leads");
  });
});

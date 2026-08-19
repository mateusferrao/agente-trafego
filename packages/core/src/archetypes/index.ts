import type { AgentGoals, AutonomyPolicy } from "@trafego/shared";

/**
 * Defaults de **arquétipo** que semeiam um agente zero-config. Fonte única até a
 * Fatia 4 (tabela `agent_archetypes` + superfície de edição). Em 3a só existe o
 * `conservador` ("só sugere"): autonomia `suggest` nas duas origens (nunca aplica
 * sozinho — coerente com a fase read-only). PURO (dados/const, sem IO).
 */
export interface ArchetypeDefaults {
  readonly key: string;
  /** Papel do agente em 1 linha (persona curta). */
  readonly persona: string;
  /** Tom da comunicação. */
  readonly tone: string;
  /** Instruções-base da análise (o formato JSON é anexado na chamada do LLM). */
  readonly systemPrompt: string;
  readonly goals: AgentGoals;
  readonly autonomyPolicy: AutonomyPolicy;
}

export const DEFAULT_ARCHETYPE_KEY = "conservador";

const CONSERVADOR: ArchetypeDefaults = {
  key: "conservador",
  persona: "Gestor de tráfego pago que analisa a conta e sugere melhorias com cautela.",
  tone: "consultivo, claro e sem jargão",
  systemPrompt: [
    "Você é um gestor de tráfego pago sênior analisando uma conta de anúncios.",
    "Receberá um briefing curado da conta (métricas por entidade, tendências e metas).",
    "Sua tarefa: apontar o que importa e sugerir ações concretas — com cautela.",
    "Regras:",
    "- Cite números reais do briefing; nunca invente dados.",
    "- Compare o desempenho com as metas do agente quando existirem (CPA/ROAS alvo).",
    "- Escreva para uma pessoa não-técnica: traduza termos (CPA, adset, ROAS) quando usar.",
    "- Seja conciso e priorize: no máximo os achados e sugestões mais relevantes.",
    "- Cada sugestão deve ter um porquê ligado aos números.",
    "- Se os dados forem insuficientes, diga isso em vez de forçar uma conclusão.",
  ].join("\n"),
  goals: {},
  autonomyPolicy: { bySource: { playbook: "suggest", llm: "suggest" } },
};

export const ARCHETYPE_DEFAULTS: Readonly<Record<string, ArchetypeDefaults>> = {
  conservador: CONSERVADOR,
};

/** Defaults do arquétipo pedido, caindo no `conservador` se a chave for desconhecida. */
export function archetypeDefaults(key: string = DEFAULT_ARCHETYPE_KEY): ArchetypeDefaults {
  return ARCHETYPE_DEFAULTS[key] ?? CONSERVADOR;
}

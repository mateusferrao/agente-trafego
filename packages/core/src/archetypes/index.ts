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
  /**
   * Metodologia estruturada (adaptada do "Qualificador consultivo" do automato).
   * DADO (não prompt hardcoded) — a Fatia 4 expõe a edição; o prompt é composto
   * a partir daqui. Extensível: nova regra = 1 entrada.
   */
  readonly methodology: {
    readonly tonePosture: string;
    readonly evidenceRules: readonly string[];
    readonly actionRules: readonly string[];
    readonly antiPatterns: readonly string[];
  };
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
  methodology: {
    tonePosture: "Consultivo, direto e sem jargão; explica o porquê em linguagem de dono do negócio.",
    evidenceRules: [
      "Use só números do briefing; cite o valor real ao lado de cada afirmação.",
      "Compare com a meta e com o período anterior quando existir.",
      "Não infira causa (criativo cansado, público saturado) sem um sinal no dado.",
    ],
    actionRules: [
      "Sugira a ação de menor risco que resolve o problema (pausar > cortar budget > investigar).",
      "Só proponha mexer em budget/status quando o dado sustenta; na dúvida, investigar.",
      "Uma recomendação por problema; não empilhe mudanças arriscadas.",
    ],
    antiPatterns: [
      "Conselho genérico sem número.",
      "Escalar o que ainda não provou CPA/qualidade.",
      "Tratar volume de conversas como sucesso ignorando a taxa de resposta/profundidade.",
    ],
  },
};

export const ARCHETYPE_DEFAULTS: Readonly<Record<string, ArchetypeDefaults>> = {
  conservador: CONSERVADOR,
};

/** Defaults do arquétipo pedido, caindo no `conservador` se a chave for desconhecida. */
export function archetypeDefaults(key: string = DEFAULT_ARCHETYPE_KEY): ArchetypeDefaults {
  return ARCHETYPE_DEFAULTS[key] ?? CONSERVADOR;
}

/**
 * Trata um campo de identidade SEMEADO pelo arquétipo como "não configurado" (null)
 * quando ainda igual ao default — assim "vazio = usa o arquétipo" vale mesmo p/ agentes
 * criados antes (semeados). Valor editado (≠ default) é preservado. PURO.
 */
export function unseedIdentity(
  field: "persona" | "tone" | "systemPrompt",
  value: string | null,
  archetypeKey: string,
): string | null {
  if (value === null) return null;
  return value === archetypeDefaults(archetypeKey)[field] ? null : value;
}

/** Compõe o system prompt do analista a partir da metodologia (dado → texto). PURO. */
export function composeMethodologyPrompt(d: ArchetypeDefaults): string {
  const bullets = (label: string, items: readonly string[]): string =>
    items.length > 0 ? `${label}:\n${items.map((i) => `- ${i}`).join("\n")}` : "";
  return [
    d.systemPrompt,
    `Postura: ${d.methodology.tonePosture}`,
    bullets("Regras de evidência", d.methodology.evidenceRules),
    bullets("Regras para ações", d.methodology.actionRules),
    bullets("Evite", d.methodology.antiPatterns),
  ]
    .filter((s) => s.length > 0)
    .join("\n\n");
}

/** Personalização por texto do dono do agente (Fatia 4) — camada ADITIVA sobre a base. */
export interface AgentPromptExtras {
  /** Fatos do negócio (público, oferta, momento de lançamento, ticket). */
  readonly businessContext?: string;
  /** Orientações de comportamento (prioridades, o que evitar). */
  readonly guidance?: string;
}

const BUSINESS_CONTEXT_LABEL = "Contexto do negócio informado pelo dono (trate como verdade factual)";
const GUIDANCE_LABEL = "Orientações do dono (siga como prioridade, sem violar as regras acima)";

/**
 * Anexa os blocos de personalização do dono ao prompt-base (metodologia do
 * arquétipo ou override) de forma **aditiva**: a base é sempre preservada, cada
 * bloco entra só quando há texto (trim não-vazio), ordem estável (contexto →
 * orientações). A distinção fato × instrução vive nos rótulos. PURO.
 */
export function composeAgentPrompt(base: string, extras: AgentPromptExtras = {}): string {
  const blocks: string[] = [base];
  const ctx = extras.businessContext?.trim();
  const guide = extras.guidance?.trim();
  if (ctx) blocks.push(`${BUSINESS_CONTEXT_LABEL}:\n${ctx}`);
  if (guide) blocks.push(`${GUIDANCE_LABEL}:\n${guide}`);
  return blocks.join("\n\n");
}

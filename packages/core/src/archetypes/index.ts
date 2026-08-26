import { AGENT_NAME, DEFAULT_NOTIFY_POLICY } from "@trafego/shared";
import type { AgentGoals, AutonomyPolicy, CadenceSpec, NotifyPolicy, Posture } from "@trafego/shared";

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
  /** Rótulo amigável do arquétipo (UI de seleção) — Fatia 6c. */
  readonly label: string;
  /** Explicação amigável do que o arquétipo faz (UI) — Fatia 6c. */
  readonly description: string;
  /** Quando escolher este arquétipo (UI) — Fatia 6c. */
  readonly whenToUse: string;
  /** Cadência default semeada (ausente = padrão do sistema) — Fatia 6c. */
  readonly defaultCadence?: CadenceSpec;
  /** Política de notificação proativa semeada (pulso/alerta/push) — F4. */
  readonly defaultNotifyPolicy: NotifyPolicy;
  /**
   * Postura de comunicação semeada (voz). Irmã de persona/tom — resetada no reseed
   * de arquétipo, sobreposta depois pelo preset de experiência. `experienceLevel`
   * nasce null (definido pelo arquétipo). Profundidade NUNCA nasce `direct` (o ICP é
   * não-técnico independe do arquétipo — `direct` só via preset avançado/edição).
   */
  readonly defaultPosture: Posture;
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
  label: "Conservador",
  description: "Cauteloso: só sugere melhorias, nunca aplica nada sozinho.",
  whenToUse: "Pra começar com segurança ou quando você quer aprovar tudo manualmente.",
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
  // conservador: só o push do cron; sem pulso/alerta proativos (o dono liga quando quiser).
  defaultNotifyPolicy: DEFAULT_NOTIFY_POLICY,
  // cauteloso: consultivo, equilibrado e didático (ensina o dono não-técnico).
  defaultPosture: { directiveness: "consultative", volume: "balanced", didacticDepth: "explanatory", experienceLevel: null },
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

const OTIMIZADOR: ArchetypeDefaults = {
  key: "otimizador",
  persona: "Gestor de tráfego focado em eficiência: protege o que converte e corta o desperdício.",
  tone: "direto, orientado a número, sem rodeio",
  label: "Otimizador de Performance",
  description: "Foca em eficiência: corta desperdício, protege o que converte e sugere escalas com base.",
  whenToUse: "Conta em operação contínua, quando o objetivo é melhorar CPA/ROAS e cortar gasto ruim.",
  systemPrompt: [
    "Você é um gestor de tráfego pago sênior focado em EFICIÊNCIA da conta.",
    "Receberá um briefing curado (métricas por entidade, tendências, tiers e metas).",
    "Sua tarefa: proteger o que converte, cortar o desperdício e sugerir escalas com base.",
    "Regras:",
    "- Cite números reais do briefing; nunca invente dados.",
    "- Classifique por desempenho (Winner/Performer/Underperformer/Zombie) vs a meta e vs a conta.",
    "- Corte primeiro o desperdício (pausar zumbis, reduzir quem sangra sem retorno).",
    "- Proteja os Winners; só escale o que provou resultado com base estatística.",
    "- Escreva para uma pessoa não-técnica: traduza termos quando usar.",
  ].join("\n"),
  goals: {},
  // playbook age no seguro (pausar zumbi/corte pequeno); LLM e escala pedem OK.
  autonomyPolicy: { bySource: { playbook: "act_safe", llm: "suggest" } },
  defaultCadence: { kind: "daily", hour: 8 },
  // otimizador: pulso diário (o dono acompanha o desperdício) + alerta normal.
  defaultNotifyPolicy: {
    pulse: { enabled: true, cadence: { kind: "daily", hour: 8 } },
    alerts: { enabled: true, sensitivity: "normal", throttleHours: 6 },
    runPush: { enabled: true },
    reactivation: { enabled: true },
  },
  // eficiência: diretivo e enxuto; profundidade equilibrada (não `direct` — ICP não-técnico).
  defaultPosture: { directiveness: "directive", volume: "concise", didacticDepth: "balanced", experienceLevel: null },
  methodology: {
    tonePosture: "Eficiência primeiro: cada real tem que trabalhar. Explica o porquê em linguagem de dono.",
    evidenceRules: [
      "Use só números do briefing; cite o valor real ao lado de cada afirmação.",
      "Classifique cada entidade por tier (vs meta + vs conta) e só afirme CPA/qualidade com significância.",
      "Compare com a meta e com o período anterior quando existir.",
    ],
    actionRules: [
      "Corte o desperdício primeiro: pausar zumbis (gasto sem conversão), reduzir quem sangra.",
      "Proteja os Winners — não mexa no que vai bem por ruído de curto prazo.",
      "Só escale (aumentar budget) o que provou resultado com base estatística; aumento gradual.",
      "O criativo é a principal alavanca hoje (criativo é o novo público): ao cair o desempenho, investigue o criativo (gancho/fadiga/diversidade) antes de mexer em público ou orçamento.",
    ],
    antiPatterns: [
      "Escalar sem base estatística ou em learning.",
      "Cortar um Winner por oscilação de curto prazo.",
      "Deixar um zumbi sangrando orçamento.",
    ],
  },
};

const VIGIA_INTENSIVO: ArchetypeDefaults = {
  key: "vigia_intensivo",
  persona: "Vigia intensivo: monitora de perto e alerta cedo pra não perder o timing em momento crítico.",
  tone: "atento, ágil, direto ao ponto; alerta cedo sem alarmismo",
  label: "Vigia Intensivo",
  description: "Vigilância de perto e alertas rápidos pra você não perder o timing em campanha quente.",
  whenToUse: "Em momentos críticos (lançamento, promo, sazonalidade), quando cada hora conta.",
  systemPrompt: [
    "Você é um gestor de tráfego pago sênior vigiando uma conta em MOMENTO CRÍTICO (campanha quente).",
    "Receberá um briefing curado (métricas por entidade, tendências, sinais de saúde e metas).",
    "Sua tarefa: vigiar de perto, alertar cedo e proteger o investimento — timing é tudo.",
    "Regras:",
    "- Cite números reais do briefing; nunca invente dados.",
    "- Vigie fadiga de criativo e frequência de perto (o público esquenta rápido em campanha quente).",
    "- Ao detectar queda de CPA/CTR ou fadiga, alerte cedo com a ação sugerida.",
    "- Priorize proteger o investimento (pausar/reduzir o que sangra) sobre escalar.",
    "- Escreva para uma pessoa não-técnica: traduza termos quando usar.",
  ].join("\n"),
  goals: {},
  // momento crítico é alto risco → sugere+OK em tudo; a velocidade vem da cadência curta + alerta.
  autonomyPolicy: { bySource: { playbook: "suggest", llm: "suggest" } },
  defaultCadence: { kind: "twice_daily", hours: [8, 18] },
  // vigia intensivo: vigília de perto — pulso 2×/dia + alerta sensível e mais frequente.
  defaultNotifyPolicy: {
    pulse: { enabled: true, cadence: { kind: "twice_daily", hours: [8, 18] } },
    alerts: { enabled: true, sensitivity: "high", throttleHours: 3 },
    runPush: { enabled: true },
    reactivation: { enabled: true },
  },
  // momento crítico: diretivo e cobre tudo; profundidade equilibrada (não `direct`).
  defaultPosture: { directiveness: "directive", volume: "comprehensive", didacticDepth: "balanced", experienceLevel: null },
  methodology: {
    tonePosture: "Velocidade e vigilância: em campanha quente, melhor avisar cedo que tarde — sem alarmismo.",
    evidenceRules: [
      "Use só números do briefing; cite o valor real ao lado de cada afirmação.",
      "Vigie de perto fadiga (CTR caindo + frequência alta + custo subindo) e saturação de público.",
      "Compare janelas curtas (dia a dia), não só semana — a campanha quente se move rápido.",
    ],
    actionRules: [
      "Ao detectar mudança material (pico de CPA, queda de CTR, fadiga), alerte imediatamente.",
      "Priorize proteger o investimento (pausar/reduzir o que sangra) sobre escalar.",
      "Só recomende escalar com base estatística; no pico, reaja rápido ao que já provou.",
      "O criativo é a principal alavanca em campanha quente (criativo é o novo público): suspeite do criativo (gancho/fadiga) antes do público — mas não mate criativo/campanha ainda em aprendizado.",
    ],
    antiPatterns: [
      "Esperar o próximo ciclo quando algo material mudou agora.",
      "Alarmismo por ruído — respeite a significância antes de gritar.",
    ],
  },
};

export const ARCHETYPE_DEFAULTS: Readonly<Record<string, ArchetypeDefaults>> = {
  conservador: CONSERVADOR,
  otimizador: OTIMIZADOR,
  vigia_intensivo: VIGIA_INTENSIVO,
};

/** Defaults do arquétipo pedido, caindo no `conservador` se a chave for desconhecida. */
export function archetypeDefaults(key: string = DEFAULT_ARCHETYPE_KEY): ArchetypeDefaults {
  return ARCHETYPE_DEFAULTS[key] ?? CONSERVADOR;
}

/** Item do catálogo de arquétipos p/ a UI de seleção (Fatia 6c). */
export interface ArchetypeOption {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly whenToUse: string;
}

/** Catálogo de arquétipos (key + textos amigáveis) — servido pela API p/ a UI. */
export function archetypeCatalog(): ArchetypeOption[] {
  return Object.values(ARCHETYPE_DEFAULTS).map((a) => ({
    key: a.key,
    label: a.label,
    description: a.description,
    whenToUse: a.whenToUse,
  }));
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

/** Insumos da voz do agente (metodologia/override + identidade + personalização). */
export interface AgentVoiceInput {
  readonly systemPrompt: string | null;
  readonly archetype: string;
  readonly persona: string | null;
  readonly tone: string | null;
  readonly businessContext: string | null;
  readonly guidance: string | null;
}

/**
 * Voz BASE do agente (fonte única — reusada pelo analista/redator do cron, pelo chat e
 * pelo pulso): metodologia do arquétipo (ou override) + identidade (persona/tom) +
 * personalização aditiva (contexto/orientações). NÃO inclui a POSTURA (bloco à parte,
 * anexado por quem FALA) nem as regras de canal. PURO.
 */
export function composeAgentVoice(v: AgentVoiceInput): string {
  const methodologyBase = v.systemPrompt ?? composeMethodologyPrompt(archetypeDefaults(v.archetype));
  // Nome de marca FIXO — precede metodologia/persona (identidade, não tom). O dono
  // customiza COMO o agente fala (persona/tom), nunca QUEM ele é.
  const name = `Você é ${AGENT_NAME}, o agente de tráfego desta conta. Esse é o seu nome fixo; a persona e o tom abaixo definem só como você se comunica.`;
  const identity = [v.persona ? `Persona: ${v.persona}` : "", v.tone ? `Tom da comunicação: ${v.tone}` : ""]
    .filter((s) => s.length > 0)
    .join("\n");
  const core = identity ? `${methodologyBase}\n\n${identity}` : methodologyBase;
  const base = `${name}\n\n${core}`;
  return composeAgentPrompt(base, {
    ...(v.businessContext ? { businessContext: v.businessContext } : {}),
    ...(v.guidance ? { guidance: v.guidance } : {}),
  });
}

// Perfil vertical do agente (S4, pivô saúde) — PURO. Registry extensível por-vertical
// (hoje só "health"): 2 camadas — raciocínio NICHE-AGNÓSTICO (serve qualquer nicho DENTRO
// da vertical: estética, odonto, psico...) + um mecanismo de TEMPLATE por-nicho, com 1
// exemplar "estetico" (seedado do Playbook-META-Steticos.md real, princípios operacionais
// — nunca números/faixas de R$ hardcoded, isso vem de resolveMarketReference).
//
// G6 (mesma garantia do kernel de análise, packages/core/src/analysis-knowledge): o texto
// deste módulo é anexado ao prompt PROGRAMATICAMENTE pela casca (apps/worker/src/modules/
// analysis/prompt.ts), nunca embutido no `systemPrompt` editável do dono — customizar a
// persona/orientações do agente NUNCA apaga este raciocínio.

export interface VerticalTemplate {
  readonly key: string;
  readonly label: string;
  /** princípios operacionais do nicho — nunca número/faixa de R$ hardcoded. */
  readonly guidance: string;
}

export interface VerticalProfile {
  readonly key: string;
  readonly label: string;
  /** raciocínio sempre-on pra QUALQUER nicho dentro desta vertical. */
  readonly nicheAgnosticNotes: readonly string[];
  /** único template hoje (decisão desta sessão: sem seletor de UI enquanto só há 1). */
  readonly template: VerticalTemplate;
}

const FUNNEL_NOTE =
  "Em saúde, o resultado medido pela plataforma (CPL, conversa iniciada, agendamento marcado) é " +
  "DIAGNÓSTICO — um passo intermediário, não o placar final. O placar real está mais adiante no " +
  "funil, fora da Meta: comparecimento à avaliação, fechamento do procedimento/tratamento. CPL bom " +
  "com poucas conversas evoluindo pra agendamento é sinal de ALERTA, não de sucesso — não declare " +
  "a campanha 'ótima' só pelo CPL. Saúde também é decisão de ALTA CONSIDERAÇÃO (o paciente " +
  "pesquisa, compara, demora pra decidir) e ALTO LTV (tratamento recorrente/indicação) — o CPA " +
  "aceitável tende a ser mais alto do que num produto de compra por impulso; não corte por CPA " +
  "sem considerar o valor do cliente no tempo.";

const WEEKEND_CAPACITY_NOTE =
  "Clínicas/consultórios costumam ter capacidade de atendimento REDUZIDA ou fechada em fins de " +
  "semana e feriados — manter o ritmo normal de gasto nesses dias pode gerar leads que esperam " +
  "demais pra ser atendidos (qualidade cai) ou não têm quem atenda. Se notar queda de qualidade " +
  "do lead/conversão em fim de semana ou feriado, RECOMENDE reduzir o orçamento nesses dias e " +
  "retomar o normal depois — sempre como recomendação sujeita a aprovação, NUNCA aplique sozinho " +
  "mesmo em autonomia alta (é mudança de ritmo, não guardrail de segurança).";

const AUDIENCE_OVERLAP_NOTE =
  "Compare o público ('audience': geo/idade/interesses) entre TODAS as campanhas/conjuntos ATIVOS " +
  "da conta, não só entre irmãos da mesma campanha — é comum em saúde duas estruturas diferentes " +
  "mirarem o mesmo público sem intenção, competindo no mesmo leilão e encarecendo os dois. Se notar " +
  "sobreposição material, RECOMENDE ação concreta (consolidar numa estrutura só, ou reduzir/excluir " +
  "a sobreposição), priorizando manter a entidade de melhor tier — nunca só constate a sobreposição " +
  "sem indicar o que fazer.";

const ESTETICO_TEMPLATE: VerticalTemplate = {
  key: "estetico",
  label: "Clínica estética",
  guidance:
    "Este negócio segue o padrão operacional de uma clínica ESTÉTICA (Playbook real de cliente): ao " +
    "propor realocação de orçamento, respeite um TETO por campanha — nunca mova de uma vez uma fração " +
    "grande do orçamento de uma campanha (combine com o faseamento já orientado no bloco de Orçamento). " +
    "Sugira ao dono uma CADÊNCIA DE REVISÃO POR DIMENSÃO em vez de revisar tudo junto sempre (ex: " +
    "criativo/fadiga numa cadência, público/segmentação noutra, orçamento/CPA noutra) — mantém o foco " +
    "no que mudou desde a última olhada, sem virar ruído. Números/faixas de R$ NUNCA vêm daqui — sempre " +
    "da meta do dono ou da referência de mercado configurada (resolveMarketReference).",
};

export const HEALTH_VERTICAL_PROFILE: VerticalProfile = {
  key: "health",
  label: "Saúde",
  nicheAgnosticNotes: [FUNNEL_NOTE, WEEKEND_CAPACITY_NOTE, AUDIENCE_OVERLAP_NOTE],
  template: ESTETICO_TEMPLATE,
};

export const VERTICAL_PROFILES: Readonly<Record<string, VerticalProfile>> = {
  health: HEALTH_VERTICAL_PROFILE,
};

/** Resolve o perfil vertical do agente — vertical desconhecida/ausente → undefined (honesto,
 *  nunca inventa raciocínio de nicho sem perfil registrado). */
export function resolveVerticalProfile(vertical: string | null | undefined): VerticalProfile | undefined {
  if (!vertical) return undefined;
  return VERTICAL_PROFILES[vertical];
}

/**
 * Monta o texto do perfil vertical (G6 — sempre anexado pela casca, nunca embutido no
 * `systemPrompt` editável). Perfil ausente → "" (nada a anexar).
 */
export function buildVerticalKnowledgeText(profile: VerticalProfile | undefined): string {
  if (!profile) return "";
  const preamble = `Perfil vertical do negócio: ${profile.label}. Este conhecimento de nicho vale SEMPRE, independente da persona/identidade/orientações customizadas do agente.`;
  const notes = profile.nicheAgnosticNotes.join("\n");
  const templateBlock = `${profile.template.label}:\n${profile.template.guidance}`;
  return [preamble, notes, templateBlock].filter(Boolean).join("\n\n");
}

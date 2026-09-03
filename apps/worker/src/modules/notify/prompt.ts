// Redator dedicado do WhatsApp (papel dedicado, inspirado no mission.conversation.write
// do automato): recebe o resultado CURADO e devolve só o texto da mensagem. Grounded
// (só números da síntese), voz do arquétipo, WhatsApp-first. Saída {text} mínima.

import type { AnalysisOutput } from "@trafego/shared/schemas";
import type { FunnelSummary, Posture, WasteReport } from "@trafego/shared";
import type { LLMMessage } from "@trafego/shared/ports";
import { hasLeadQualityCaveat, kindForRecommendation } from "@trafego/core";
import { GROUNDING_RULE } from "../analysis/prompt.js";

/** Vertical em que o caveat de qualidade do lead lidera a mensagem (S8) — CPL bom com lead
 *  frio é a armadilha clássica de saúde (Playbook Steticos, item 5); fora dela, fica de fora
 *  por ora (escopo do plano do pivô saúde). */
const LEAD_QUALITY_CAVEAT_VERTICAL = "health";

/** Structured output do redator — um único campo de texto. */
export const MESSAGE_OUTPUT_JSON_SCHEMA: Readonly<Record<string, unknown>> = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
  additionalProperties: false,
};
export const MESSAGE_OUTPUT_SCHEMA_NAME = "whatsapp_message";

// A voz da marca (kernel), a diretividade/volume/profundidade (POSTURA) e a contagem de
// sugestões (volume) já vêm no `speakingPrompt` — aqui ficam só as regras de FORMATO do
// canal e o que é específico do redator do push.
const VOICE_RULES = [
  "Escreva a mensagem de WhatsApp para o dono da conta.",
  "Comece pelo diagnóstico em 1 frase, depois AGRUPE as sugestões em até 3 blocos, cada um com cabeçalho próprio e itens em LINHA NOVA começando com '- ' (nunca inline). Só inclua um bloco se ele tiver item:",
  "1) 'posso_fazer' → o que você CONSEGUE aplicar agora: liste cada um e OFEREÇA aplicar — deixe explícito que basta o dono responder 'pode' (ou aprovar no site). Se o item tiver 'ressalvas', diga o porém em linguagem de dono ANTES de oferecer (honestidade: dá pra fazer, mas...).",
  "2) 'sua_direcao' → direções que o DONO aplica na mão (você não consegue fazer sozinho): liste com honestidade, sem prometer aplicar.",
  "3) 'observei' → leituras sem ação: mencione curto, sem inflar.",
  "Não inclua IDs internos, JSON, nem markdown pesado. Não invente números nem ações: use SOMENTE o que está no resultado.",
  "Se houver 'waste' (wastedSpend > 0 ou 'misallocated'), ABRA pela mensagem em reais (o dono quer ver o dinheiro primeiro): quanto está parado e onde está mal alocado.",
  "Se 'trackingSuspect' for true, ressalve que a medição de vendas pode estar incompleta antes de sugerir cortes por CPA de venda.",
  "Se 'atBudgetCeilingCampaigns' vier preenchido, mencione que essas campanhas estão SEM FOLGA de orçamento — subir o orçamento é o próximo passo pra elas continuarem escalando (não invente valor de aumento, só sinalize a falta de folga).",
  "Se 'leadQualityCaveat' for true, ressalve ANTES de qualquer CPL/CPA/custo bom: a taxa de resposta dos leads está baixa — comemorar custo baixo com lead frio é a armadilha clássica. Diga isso primeiro, depois o resto.",
].join(" ");

/** Resumo compacto do desperdício p/ o redator (não despeja o Pareto inteiro). */
function curateWaste(waste: WasteReport | undefined): Record<string, unknown> | undefined {
  if (!waste) return undefined;
  const misallocated = (waste.pareto?.misallocated ?? []).slice(0, 2).map((m) => ({
    name: m.name,
    spendPct: m.spendPct,
    ...(m.resultPct !== undefined ? { resultPct: m.resultPct } : {}),
  }));
  if (waste.wastedSpend <= 0 && misallocated.length === 0) return undefined;
  return { wastedSpend: waste.wastedSpend, wastedPct: waste.wastedPct, misallocated };
}

/** Uma pendência aprovável p/ o redator (Fatia B) — "posso fazer isso" com oferta. */
export interface ApprovableForMessage {
  readonly reason: string;
  readonly ressalvas?: readonly string[];
}

/** Monta as mensagens do redator. `speakingPrompt` = voz de fala completa (voz-base +
 *  kernel de marca + postura), fonte única com o chat/pulso. Fatia B: detalha TODAS as
 *  sugestões agrupadas (posso fazer / sua direção / observei) + oferta do que dá pra aplicar. */
export function buildMessageMessages(
  speakingPrompt: string,
  accountName: string,
  output: AnalysisOutput,
  _posture: Posture,
  extras?: {
    readonly waste?: WasteReport;
    readonly trackingSuspect?: boolean;
    /** nomes de campanhas ATIVAS sem folga de orçamento (S1) — `campaignsAtBudgetCeiling`. */
    readonly atBudgetCeilingCampaigns?: readonly string[];
    /** funil de messaging da CONTA (S8) — insumo do caveat de qualidade do lead. */
    readonly funnel?: FunnelSummary;
    /** pendências aprováveis deste run (Fatia B) — o grupo "posso fazer isso" com oferta. */
    readonly approvable?: readonly ApprovableForMessage[];
  },
  /** perfil vertical do agente (S4) — só liga o caveat de lead frio em `health` (ver constante). */
  vertical?: string,
): LLMMessage[] {
  const system = [speakingPrompt, VOICE_RULES, GROUNDING_RULE].join("\n\n");
  const waste = curateWaste(extras?.waste);
  const leadQualityCaveat = vertical === LEAD_QUALITY_CAVEAT_VERTICAL && hasLeadQualityCaveat(extras?.funnel);
  const curated = {
    accountName,
    scorecard: output.scorecard,
    summary: output.summary,
    ...(waste ? { waste } : {}),
    ...(extras?.trackingSuspect ? { trackingSuspect: true } : {}),
    ...(extras?.atBudgetCeilingCampaigns && extras.atBudgetCeilingCampaigns.length > 0
      ? { atBudgetCeilingCampaigns: extras.atBudgetCeilingCampaigns }
      : {}),
    ...(leadQualityCaveat ? { leadQualityCaveat: true } : {}),
    // Fatia B: detalha TODAS agrupadas (sem cap de volume) + oferta do aprovável. Reusa a
    // fonte única kindForRecommendation (não re-deriva à mão).
    posso_fazer: (extras?.approvable ?? []).map((a) => ({
      acao: a.reason,
      ...(a.ressalvas && a.ressalvas.length > 0 ? { ressalvas: a.ressalvas } : {}),
    })),
    sua_direcao: output.recommendations
      .filter((r) => kindForRecommendation(r.actionType) === "human_direction")
      .map((r) => ({ title: r.title, rationale: r.rationale })),
    observei: output.recommendations
      .filter((r) => kindForRecommendation(r.actionType) === "insight")
      .map((r) => ({ title: r.title })),
  };
  const user = [
    "Resultado curado da análise (base da mensagem):",
    "```json",
    JSON.stringify(curated),
    "```",
    "",
    'Responda SOMENTE com JSON no formato { "text": "..." } — o texto pronto p/ enviar no WhatsApp.',
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

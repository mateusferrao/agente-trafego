// Crítica-estrategista do criativo escolhido (núcleo PURO) — o "não só faz": depois de a seleção
// escolher o melhor disponível, ISTO decide se o Roy OPINA e RECOMENDA. Determinístico sobre os sinais
// já computados (fit S1 + fadiga + decomposição de visão em cache). Três vereditos, mapeados no MESMO
// modelo de honestidade que já governa a escala (§8/Fatia A):
//   - solid       → o pick é bom → sem crítica (respeita o fluxo).
//   - caveat      → o pick serve MAS tem fraqueza real → devolve uma `Ressalva` (o "porém + recomendação").
//   - recommend_new → nada casa bem / o pick já morreu → recomenda criar um novo (nunca auto-cria).
// Onde a Ressalva do `caveat` ENTRA hoje: na criação-do-zero ela é a MENSAGEM honesta do eco (o auto-apply
// já é travado pelo modelo de rascunho — criação SEMPRE exige aprovação, nasce pausada + 2ª aprovação; ver
// RESSALVA_CODES). Anexá-la a uma `Action` de auto-create futura ligaria o gate literal do `isAutoApplicable`
// (mesma régua da Fatia A). A prosa aterrada no squad (`CREATIVE_CRITIQUE_KNOWLEDGE`) é enriquecida na casca;
// aqui mora o veredito + a mensagem determinística (o backbone honesto, como `computeScaleRessalvas`).

import type { AudienceStage, CreativeProofStrength, Ressalva } from "@trafego/shared";

/** Densidade de persuasão (0-7 gatilhos) igual/abaixo disto = prova/persuasão fraca. Nomeado. */
export const WEAK_PERSUASION_MAX = 1;

export type CreativeCritiqueVerdict = "solid" | "caveat" | "recommend_new";
export type CreativeCritiqueReason = "fatigued" | "aging_winner" | "cross_stage" | "weak_proof" | "no_fit";

/** Sinais do pick escolhido (a casca deriva do fit S1 + `isFatigued`/`isAging` + visão em cache). */
export interface CreativePickSignals {
  /** `isFatigued` (fadiga OU aging) do criativo/entidade de origem. */
  readonly fatigued: boolean;
  /** `isAging` (desgastando MAS ainda entrega) — distingue "prepare o próximo" de "já caiu". */
  readonly aging: boolean;
  /** o pick veio de um público de estágio OPOSTO ao da campanha nova (do fit S1). */
  readonly stageMismatch: boolean;
  /** estágio da campanha NOVA (pra frasear o cross-stage). */
  readonly campaignStage?: AudienceStage;
  readonly proofStrength?: CreativeProofStrength;
  readonly persuasionSignals?: number;
  /** nenhum candidato do pool tem fit aceitável (pool vazio, ou o melhor score do fit < 0). */
  readonly poolHasNoAcceptableFit: boolean;
}

export interface CreativeCritique {
  readonly verdict: CreativeCritiqueVerdict;
  readonly reason?: CreativeCritiqueReason;
  /** anexar à ação quando `caveat` (trava o auto-apply, mantém aprovável). Ausente em solid/recommend_new. */
  readonly ressalva?: Ressalva;
  /** o "e eu recomendaria Y" — presente em caveat e recommend_new; ausente em solid. */
  readonly recommendation?: string;
}

const STAGE_LABEL_PT: Readonly<Record<AudienceStage, string>> = {
  prospecting: "prospecção (gente que ainda não te conhece)",
  remarketing: "remarketing (gente que já te conhece)",
  unknown: "esse público",
};

function crossStageMessage(campaignStage: AudienceStage | undefined): string {
  const alvo = campaignStage ? STAGE_LABEL_PT[campaignStage] : "esse público";
  return `esse criativo veio de um público de estágio diferente — pra ${alvo} a mensagem costuma pedir outro ângulo, então considere um criativo específico pra ele.`;
}

/** Mensagem determinística ("porém + recomendação") por motivo. Reusa o vocabulário do squad
 *  (aging = prepare o próximo × fatigue = já caiu). */
function critiqueMessage(reason: CreativeCritiqueReason, s: CreativePickSignals): string {
  switch (reason) {
    case "aging_winner":
      return "esse criativo ainda entrega, mas já dá sinais de desgaste — vale deixar o próximo pronto e trocar antes do resultado cair.";
    case "cross_stage":
      return crossStageMessage(s.campaignStage);
    case "weak_proof":
      return "esse criativo tem prova fraca pro que a campanha promete — um com prova (depoimento, antes-depois, autoridade) tende a segurar melhor.";
    case "fatigued":
      return "seu melhor criativo já perdeu força (o resultado caiu) — recomendo um criativo novo com um ângulo diferente.";
    case "no_fit":
      return "não achei um criativo que combine bem com essa campanha — o mais forte seria criar um novo alinhado à oferta.";
  }
}

/** Avalia o pick escolhido → veredito + (quando cabe) Ressalva/recomendação. PURO. */
export function assessCreativePick(s: CreativePickSignals): CreativeCritique {
  // 1) nada casa OU o pick já MORREU (fadiga dura, não aging) → recomenda criar novo (nunca auto-cria).
  if (s.poolHasNoAcceptableFit || (s.fatigued && !s.aging)) {
    const reason: CreativeCritiqueReason = s.poolHasNoAcceptableFit ? "no_fit" : "fatigued";
    return { verdict: "recommend_new", reason, recommendation: critiqueMessage(reason, s) };
  }
  // 2) fraquezas que mantêm o pick aprovável mas travam auto-apply (Ressalva), por severidade.
  const weakProof = s.proofStrength === "weak" || (s.persuasionSignals !== undefined && s.persuasionSignals <= WEAK_PERSUASION_MAX);
  const reason: CreativeCritiqueReason | undefined = s.aging ? "aging_winner" : s.stageMismatch ? "cross_stage" : weakProof ? "weak_proof" : undefined;
  if (reason) {
    const message = critiqueMessage(reason, s);
    return { verdict: "caveat", reason, ressalva: { code: "weak_creative_pick", message }, recommendation: message };
  }
  // 3) tudo certo — sem crítica, respeita a autonomia.
  return { verdict: "solid" };
}

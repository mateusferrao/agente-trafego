import type { CreationOpportunity, EntityLevel, PerformanceTier } from "@trafego/shared";

/** Entidade curada p/ detectar oportunidade de criação (vem da camada de qualidade 6c). */
export interface OpportunityEntity {
  readonly id: string;
  readonly level: EntityLevel;
  readonly name?: string;
  readonly tier?: PerformanceTier;
  /** significância de negócio (conversões/cliques + baseline) — 6c. */
  readonly significant: boolean;
  /**
   * Gasto encostando no teto de budget (capado → dá pra escalar). Três estados:
   * `false` = tem folga de budget (não precisa de gasto novo — pula); `true` = confirmado
   * no teto (sinal forte); `undefined` = desconhecido (o caller não computa o sinal ainda) —
   * um vencedor provado ainda vale propor pro humano revisar. Só `false` bloqueia.
   */
  readonly atBudgetCeiling?: boolean;
  /** DESGASTE de criativo — precisa de anúncio novo (que não geramos) → só recomendação. Inclui
   *  o aging (ainda entrega): o caller passa `isFatigued` (fonte única, cobre fatigue + aging). */
  readonly fatigued: boolean;
  /** o desgaste é do tipo AGING (ainda entrega): gradua a recomendação de "troque já" pra "prepare
   *  o sucessor". O caller passa `isAging`. Ausente/false = fadiga real (já não entrega) → troque. */
  readonly aging?: boolean;
  /** SATURAÇÃO de público — o público atual esgotou → vale nova prospecção (público novo, criativo
   *  reusado). Distinto de `fatigued` (criativo). O caller mapeia `audience_saturation` → aqui. */
  readonly saturated?: boolean;
  /** ainda gastando de verdade (não zumbi). */
  readonly spending: boolean;
}

export interface DetectOpportunitiesInput {
  /** a conta tem campanha ativa? (false → cold_start). */
  readonly hasActiveCampaigns: boolean;
  /** a conta tem público salvo de CONVERTIDOS/ENGAJADOS (nível-conta)? → habilita remarketing
   *  (incluir engajados / excluir compradores). O caller deriva de `listCustomAudiences` +
   *  `isConverterAudienceName`. Ausente = false. */
  readonly hasConverterAudience?: boolean;
  readonly entities: readonly OpportunityEntity[];
}

/** Prioridade (top-1): escalar provado > remarketing > replicar vencedor > nova prospecção >
 *  refrescar fadiga (só recomendação) > começar do zero (só quando nada ativo). */
const PRIORITY: Readonly<Record<CreationOpportunity["kind"], number>> = {
  scale_winner: 0,
  remarketing: 1,
  replicate_winner: 2,
  prospecting_expansion: 3,
  refresh_fatigued: 4,
  cold_start: 5,
};

/**
 * Detecta oportunidades de criação (determinístico, PURO) — o QUÊ/porquê; o COMO (o público) é a LLM
 * quem propõe depois (resolvido determinístico, autônomo-safe). Nunca "alucina": só o que os sinais
 * confirmam. Ordena por prioridade; o caller pega o top-1 (throttle 1/conta).
 *
 * - `scale_winner`: vencedor significativo no teto de budget (ou teto desconhecido) → subir budget.
 * - `remarketing`: a conta tem público de convertidos/engajados + tráfego ativo → remarketing.
 * - `replicate_winner`: vencedor com FOLGA de budget → replicar a oferta pra um público NOVO.
 * - `prospecting_expansion`: ativa, sem vencedor/remarketing claros → nova prospecção por interesses.
 * - `refresh_fatigued`: entidade fatigada gastando → só recomendação (não geramos criativo novo).
 * - `cold_start`: conta sem campanha ativa → campanha inicial.
 */
export function detectCreationOpportunities(input: DetectOpportunitiesInput): CreationOpportunity[] {
  const out: CreationOpportunity[] = [];
  const winner = input.entities.find((e) => e.tier === "winner" && e.significant);

  // gap real corrigido (pivô saúde): um vencedor FATIGADO não pode virar `scale_winner`
  // (subir budget no MESMO criativo já cansado) — isso é "escalar sem pipeline de criativo
  // pronto" (veto do squad traffic-masters). `refresh_fatigued` (abaixo, no loop) já cobre
  // essa entidade com prioridade menor, então some do topo sem sumir da lista.
  if (winner && !winner.fatigued && winner.atBudgetCeiling !== false) {
    out.push({
      kind: "scale_winner",
      entityLevel: winner.level,
      entityId: winner.id,
      ...(winner.name ? { entityName: winner.name } : {}),
      rationale: `"${winner.name ?? winner.id}" é seu melhor em custo por resultado — dá pra escalar.`,
    });
  }

  if (input.hasConverterAudience && input.hasActiveCampaigns) {
    out.push({
      kind: "remarketing",
      rationale: "você tem público de convertidos/engajados e tráfego rodando — vale um remarketing (mira quem engajou, exclui quem já comprou).",
    });
  }

  // vencedor com FOLGA de budget: não é hora de subir budget (scale) — é hora de replicar a oferta
  // provada pra um público NOVO (só quando scale_winner não pegou, i.e. atBudgetCeiling === false).
  if (winner && winner.atBudgetCeiling === false) {
    out.push({
      kind: "replicate_winner",
      entityLevel: winner.level,
      entityId: winner.id,
      ...(winner.name ? { entityName: winner.name } : {}),
      rationale: `"${winner.name ?? winner.id}" está provado e com folga — dá pra replicar a oferta pra um público novo.`,
    });
  }

  for (const e of input.entities) {
    // saturação de PÚBLICO → nova prospecção (público novo, criativo reusado — acionável).
    if (e.saturated && e.spending) {
      out.push({
        kind: "prospecting_expansion",
        entityLevel: e.level,
        entityId: e.id,
        ...(e.name ? { entityName: e.name } : {}),
        rationale: `"${e.name ?? e.id}" saturou o público atual — vale abrir uma nova prospecção por interesses/comportamentos.`,
      });
    }
    // DESGASTE de criativo → precisa de anúncio novo (não geramos) → só recomendação (human_direction).
    // Gradua a direção pelo resultado: AGING (ainda entrega) = prepare o sucessor, não troque um
    // vencedor provado antes de cair; FADIGA real (já não entrega) = troque, teste um ângulo novo.
    if (e.fatigued && e.spending) {
      out.push({
        kind: "refresh_fatigued",
        entityLevel: e.level,
        entityId: e.id,
        ...(e.name ? { entityName: e.name } : {}),
        rationale: e.aging
          ? `"${e.name ?? e.id}" ainda entrega, mas já dá sinais de desgaste — deixe o próximo criativo pronto e troque quando o resultado começar a cair, não antes.`
          : `"${e.name ?? e.id}" está com sinais de fadiga de criativo e o resultado já caiu — vale testar um ângulo novo.`,
      });
    }
  }

  if (!input.hasActiveCampaigns) {
    out.push({
      kind: "cold_start",
      rationale: "a conta está sem campanha ativa — posso montar uma campanha inicial pra não deixar parada.",
    });
  }

  return out.sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind]);
}

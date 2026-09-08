import type { Action, CuratedEntitySnapshot, DecisionEligibility, HealthSignal, Ressalva } from "@trafego/shared";
import { ACTION_PARAM_MODE, BUDGET_MODE_INCREASE } from "@trafego/shared";
import type { LessonGuard } from "../learning/index.js";
import {
  type AudienceCeilingThresholds,
  type AudienceHeadroom,
  type MarginalCpaThresholds,
  DEFAULT_AUDIENCE_CEILING_THRESHOLDS,
  DEFAULT_MARGINAL_CPA_THRESHOLDS,
  firstFatigueSignal,
} from "../analysis-guards/index.js";

/**
 * Passe PURO nível-Action que anexa RESSALVAS de escala (Fatia A) — a versão canônica dos
 * antigos guards de escala, agora sobre a `Action` (não a recomendação do LLM). Roda em cada
 * ponto de CRIAÇÃO de candidato de escala — `build_recommendations` (LLM) e `propose_drafts`
 * (determinística) — com a MESMA função, então os dois são tratados igual (fonte única, zero
 * divergência de lógica). A ressalva NÃO rebaixa/remove a ação: mantém
 * aprovável e apenas trava o auto-apply (`isAutoApplicable`). Só escala (reativar / aumentar
 * orçamento) é avaliada; corte/pausa têm os guards de SEGURANÇA próprios (nível-recomendação).
 */

/**
 * Formatador ÚNICO das ressalvas p/ texto (chat/push/eco) — evita divergência de apresentação
 * entre superfícies (§13). `⚠️` está na allowlist de emoji do WhatsApp. "" quando não há ressalva.
 */
export function renderRessalvas(ressalvas: readonly Ressalva[] | undefined): string {
  if (!ressalvas || ressalvas.length === 0) return "";
  return ressalvas.map((r) => `⚠️ ${r.message}`).join(" ");
}

/** Uma ação é de ESCALA (reativar OU aumentar orçamento). PURA. */
export function isScaleAction(action: Action): boolean {
  if (action.type === "resume_entity") return true;
  if (action.type === "adjust_budget") return action.params[ACTION_PARAM_MODE] === BUDGET_MODE_INCREASE;
  return false;
}

/** Contexto por-entidade já resolvido (IO feito no worker) — os passes são PUROS. */
export interface ScaleRessalvaContext {
  readonly eligibility: ReadonlyMap<string, DecisionEligibility>;
  /** `%` de alta do CPA (atual vs baseline; positivo = piorou) por entidade. */
  readonly marginalRisePct: ReadonlyMap<string, number | undefined>;
  readonly marginal: MarginalCpaThresholds;
  readonly headroom: ReadonlyMap<string, AudienceHeadroom>;
  readonly ceiling: AudienceCeilingThresholds;
  readonly signals: ReadonlyMap<string, readonly HealthSignal[]>;
  readonly lessonGuards: readonly LessonGuard[];
}

/**
 * Ressalvas de escala a partir do SNAPSHOT PERSISTIDO da entidade (`entity_analyses.curatedJson`) —
 * o caminho ON-DEMAND (chat/site pediram escalar um vencedor) não tem o brief fresco do run. Popula
 * o contexto com o que o snapshot carrega (elegibilidade + sinais de saúde → significância + fadiga);
 * os gates que exigem dado fresco (CPA marginal, teto de audiência, aprendizado) são pulados
 * GRACIOSAMENTE (mapas vazios). Reusa `computeScaleRessalvas` (fonte única, zero divergência de
 * lógica com o proativo). PURA. Vazio = sem ressalva conhecida (ou a ação não é escala).
 */
export function ressalvasFromSnapshot(
  action: Action,
  entityId: string,
  snapshot: Pick<CuratedEntitySnapshot, "eligibility" | "healthSignals"> | null | undefined,
): readonly Ressalva[] {
  if (!snapshot) return [];
  const ctx: ScaleRessalvaContext = {
    eligibility: snapshot.eligibility ? new Map([[entityId, snapshot.eligibility]]) : new Map(),
    marginalRisePct: new Map(),
    marginal: DEFAULT_MARGINAL_CPA_THRESHOLDS,
    headroom: new Map(),
    ceiling: DEFAULT_AUDIENCE_CEILING_THRESHOLDS,
    signals: snapshot.healthSignals ? new Map([[entityId, snapshot.healthSignals]]) : new Map(),
    lessonGuards: [],
  };
  return computeScaleRessalvas(action, ctx);
}

/** Anexa as ressalvas de escala aplicáveis à ação. PURA. Vazio = escala limpa (ou não é escala). */
export function computeScaleRessalvas(action: Action, ctx: ScaleRessalvaContext): readonly Ressalva[] {
  if (!isScaleAction(action)) return [];
  const id = action.target.id;
  const out: Ressalva[] = [];

  // 1. significância / learning (o guard de significância)
  const elig = ctx.eligibility.get(id);
  if (elig && !(elig.hasSignificance && !elig.inLearning)) {
    out.push({
      code: "no_significance",
      message: elig.inLearning
        ? "ainda em aprendizado (sem base comparável no período anterior) — escalar agora pode bagunçar o aprendizado; melhor esperar estabilizar."
        : `sem base estatística ainda (${elig.conversions} conversões) — o resultado pode ser variação; confirme com mais dado antes de escalar.`,
    });
  }

  // 2. CPA marginal piorando (limiar malformado → inerte, nunca confia num teto quebrado)
  if (Number.isFinite(ctx.marginal.worsenPct) && ctx.marginal.worsenPct > 0) {
    const rise = ctx.marginalRisePct.get(id);
    if (rise !== undefined && rise >= ctx.marginal.worsenPct) {
      out.push({
        code: "worsening_marginal_cpa",
        message: `CPA marginal piorando (+${rise.toFixed(0)}% vs período anterior) — o CPA médio parece bom, mas o incremento mais recente já está mais caro.`,
      });
    }
  }

  // 3. teto de audiência
  const hr = ctx.headroom.get(id);
  if (hr && hr.monthlyReach !== undefined) {
    const cap = hr.monthlyReach * hr.frequencyCap;
    if (cap > 0 && hr.currentMonthlyImpressions / cap >= ctx.ceiling.nearSaturationRatio) {
      out.push({
        code: "audience_ceiling",
        message: `o público (~${Math.round(hr.monthlyReach)} pessoas/mês) já está perto do teto de frequência saudável — mais orçamento tende a aumentar a frequência (mesma gente vendo mais vezes), não alcançar gente nova.`,
      });
    }
  }

  // 4. fadiga de criativo (fonte única `firstFatigueSignal`)
  const hit = firstFatigueSignal(ctx.signals.get(id));
  if (hit) {
    out.push({
      code: "creative_fatigue",
      message: `sinal de fadiga de criativo (${hit}) — renove o gancho/criativo antes de subir o orçamento, senão o incremento tende a piorar o CPA/CPM em vez de alcançar gente nova.`,
    });
  }

  // 5. hipótese de aprendizado não-confirmada (só rebaixa; assimétrica)
  const lower = ctx.lessonGuards.filter((g) => g.key.direction === "lower");
  const accountCaution = lower.some((g) => g.key.scope === "account");
  const entityCaution = lower.some((g) => g.key.scope === "entity" && g.key.subjectId === id);
  if (accountCaution || entityCaution) {
    out.push({
      code: "unconfirmed_hypothesis",
      message: accountCaution
        ? "um aprendizado desta conta (hipótese ainda não confirmada) sugere cautela ao escalar por aqui."
        : "um aprendizado desta conta (hipótese ainda não confirmada) sugere cautela nesta entidade.",
    });
  }

  return out;
}

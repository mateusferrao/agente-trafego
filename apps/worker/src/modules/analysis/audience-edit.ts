// Edição de PÚBLICO (adjust_audience, Fatia C): transforma recomendações `review_audience` de ADSET
// em AÇÕES reais quando o agente tem a capacidade ligada (opt-in) e dá pra propor+resolver um público
// concreto. O QUÊ é o analista (o público está errado); o COMO (o público novo) é a LLM
// (`proposeAudienceEdit`), resolvida nome→id de forma autônomo-safe (descarta o inexistente). SEMPRE
// exige OK humano — adjust_audience nunca auto-aplica (§8). Recomendação não-upgradada fica consultiva.

import type { Action, ConversionGoal } from "@trafego/shared";
import { ACTION_PARAM_TARGETING } from "@trafego/shared";
import { riskForAction } from "@trafego/core";
import type { WorkerDeps } from "../../composition.js";
import {
  loadAccountAudiences,
  loadAgentContext,
  resolveProposedExplicitTargeting,
  type AgentContext,
  type DraftProposalContext,
} from "../conversation/draft-proposal.js";
import { proposeAudienceEdit, proposedTargetingToArgs } from "../conversation/propose-targeting.js";

/** Capacidade do catálogo que habilita a edição de público (opt-in, default OFF). */
const ADJUST_AUDIENCE_TOOL_KEY = "adjust_audience";

/** Recomendação `review_audience` candidata a virar `adjust_audience` (alvo = adset conhecido). */
export interface AudienceEditCandidate {
  readonly recId: string;
  readonly adsetId: string;
  readonly rationale: string;
}

export interface AudienceEditContext {
  readonly ctx: DraftProposalContext;
  readonly conversionGoal?: ConversionGoal | undefined;
  readonly runId?: string;
}

/**
 * Constrói as ações `adjust_audience` das recomendações candidatas. Carrega o contexto do agente 1x;
 * se a capacidade está DESLIGADA (default) OU não há contexto, devolve vazio (tudo fica consultivo —
 * honesto sobre o que NÃO dá pra fazer). Retorna `Map recId→Action` p/ o caller fazer o upgrade da linha.
 */
export async function buildAudienceEditActions(
  deps: WorkerDeps,
  candidates: readonly AudienceEditCandidate[],
  actx: AudienceEditContext,
): Promise<Map<string, Action>> {
  const out = new Map<string, Action>();
  if (candidates.length === 0) return out;
  const ac = await loadAgentContext(deps, actx.ctx);
  if (!ac || !ac.enabled.has(ADJUST_AUDIENCE_TOOL_KEY)) return out;

  let savedAudienceNames: readonly string[] = [];
  try {
    savedAudienceNames = (await loadAccountAudiences(deps, actx.ctx, ac.ref)).map((a) => a.name);
  } catch {
    /* best-effort: sem públicos salvos ainda dá pra refinar por primitivos */
  }

  for (const c of candidates) {
    try {
      const action = await buildOne(deps, ac, actx, c, savedAudienceNames);
      if (action) out.set(c.recId, action);
    } catch (err) {
      deps.logger.debug({ recId: c.recId, err: String(err) }, "audience_edit:pulado");
    }
  }
  return out;
}

/** Propõe (LLM) + resolve (nome→id) o público refinado de UM adset → `adjust_audience` Action.
 *  `null` = sem público concreto (LLM vazia/inválida ou nada resolveu) → mantém consultivo. */
async function buildOne(
  deps: WorkerDeps,
  ac: AgentContext,
  actx: AudienceEditContext,
  c: AudienceEditCandidate,
  savedAudienceNames: readonly string[],
): Promise<Action | null> {
  // público ATUAL do adset (base do refinamento) — best-effort (falhar não bloqueia a proposta).
  const currentAudience = (await deps.ports.ads.getAudienceProfile(ac.ref, c.adsetId).catch(() => null)) ?? undefined;
  const proposed = await proposeAudienceEdit(deps.ports.llm, {
    rationale: c.rationale,
    model: ac.model,
    ...(currentAudience ? { currentAudience } : {}),
    savedAudienceNames,
    businessContext: ac.businessContext,
    guidance: ac.guidance,
    ...(actx.conversionGoal ? { conversionGoal: actx.conversionGoal } : {}),
    meta: { orgId: actx.ctx.orgId, ...(actx.runId ? { runId: actx.runId } : {}) },
  });
  if (!proposed) return null;
  // resolução nome→id + montagem do explicit — MESMA da criação (autônomo-safe: descarta inexistente).
  const res = await resolveProposedExplicitTargeting(deps, actx.ctx, ac.ref, proposedTargetingToArgs(proposed), { autonomous: true });
  if (res.kind !== "ok") return null; // empty/blocked → não inventa público (mantém consultivo)
  return {
    id: c.recId,
    type: "adjust_audience",
    target: { level: "adset", id: c.adsetId },
    params: { [ACTION_PARAM_TARGETING]: res.targeting },
    source: "llm",
    riskLevel: riskForAction("adjust_audience"),
    reason: c.rationale,
  };
}

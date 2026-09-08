import type {
  Action,
  ActionTarget,
  CampaignDraft,
  CandidateAction,
  EntityStatus,
  GuardrailConfig,
} from "@trafego/shared";
import {
  ACTION_PARAM_AMOUNT_MINOR,
  ACTION_PARAM_MODE,
  ACTION_PARAM_PCT,
  ACTION_PARAM_STATUS,
  BUDGET_MODE_SET,
  DEFAULT_MAX_NEW_CAMPAIGNS_PER_DAY,
  DEFAULT_MAX_NEW_DAILY_BUDGET_MINOR,
} from "@trafego/shared";

export interface DroppedAction {
  readonly action: Action;
  readonly reason: string;
}

export interface GuardrailResult {
  readonly allowed: Action[];
  readonly dropped: DroppedAction[];
}

/**
 * Contexto CROSS-RUN passado pela casca (worker) — mantém o guardrail PURO enquanto
 * a rede vale entre runs do dia. Tudo keyed por `${level}:${id}`.
 */
export interface GuardrailContext {
  /** entidades já tocadas hoje (runs anteriores) — contam no cap de entidades/dia. */
  readonly touchedToday?: ReadonlySet<string>;
  /** entidades cujo budget já mudou hoje — bloqueia recompor no mesmo dia. */
  readonly budgetChangedToday?: ReadonlySet<string>;
  /** `${level}:${id}` → o nível-alvo tem budget? (pré-check de `adjust_budget`). */
  readonly budgetByEntity?: ReadonlyMap<string, boolean>;
  /** `${level}:${id}` → budget atual (unidade mínima) — clamp de `adjust_budget` set-absoluto (5c). */
  readonly budgetAmountByEntity?: ReadonlyMap<string, number>;
  /** `${level}:${id}` → status atual da entidade (no-op de pause/resume/set_status). */
  readonly statusByEntity?: ReadonlyMap<string, EntityStatus>;
}

/**
 * Status-alvo neutro de uma ação de mudança de estado (para o no-op). `null` = a ação
 * não mexe em status. `set_status` normaliza `params.status` pro vocabulário do domínio.
 */
export function targetStatusOf(action: Action): EntityStatus | null {
  switch (action.type) {
    case "pause_entity":
      return "paused";
    case "resume_entity":
      return "active";
    case "set_status": {
      const raw = String(action.params[ACTION_PARAM_STATUS] ?? "").toLowerCase();
      return raw === "active" || raw === "paused" || raw === "deleted" || raw === "archived"
        ? (raw as EntityStatus)
        : null;
    }
    default:
      return null;
  }
}

/** Chave estável de entidade (nível + id). */
export function entityKeyOf(target: ActionTarget): string {
  return `${target.level}:${target.id}`;
}

/**
 * Rede de segurança sobre as candidatas (playbook + LLM). Sempre roda, mesmo
 * no caminho autônomo — é a ÚNICA rede quando não há eco+confirma.
 *
 * Ordem: killSwitch → allowedActions → pré-check de nível de budget → anti-compounding
 * de budget (cross-run) → clamp de % → cap de entidades/dia (cross-run). Função PURA —
 * o contexto cross-run vem da casca (dado passado in).
 *
 * `opts.exemptEntityCap`: pula SÓ o cap de entidades/dia (passo 5) — usado pela ativação
 * em cadeia CONFIRMADA (uma intenção única do dono, como a ativação de criação já faz),
 * pra não deixar a árvore meio-ligada. Todas as outras redes (killSwitch, allowedActions,
 * budget) seguem valendo. Default false → nenhuma outra chamada é afetada.
 */
export function applyGuardrails(
  actions: readonly CandidateAction[],
  cfg: GuardrailConfig,
  ctx: GuardrailContext = {},
  opts: { readonly exemptEntityCap?: boolean } = {},
): GuardrailResult {
  const allowed: Action[] = [];
  const dropped: DroppedAction[] = [];

  // kill-switch: nada passa
  if (cfg.killSwitch) {
    return { allowed: [], dropped: actions.map((a) => ({ action: a, reason: "kill switch ativo" })) };
  }

  // cap de entidades/dia conta o que já foi tocado hoje (cross-run).
  const seenEntities = new Set<string>(ctx.touchedToday ?? []);

  for (const action of actions) {
    const entityKey = entityKeyOf(action.target);

    // 1) tipo de ação permitido?
    if (!cfg.allowedActions.includes(action.type)) {
      dropped.push({ action, reason: `ação ${action.type} não permitida` });
      continue;
    }

    // 1b) no-op: entidade já está no estado-alvo (evita pedir OK / mexer à toa numa
    //     entidade já pausada/ativa — cobre playbook e LLM). Só quando temos o status.
    const targetStatus = targetStatusOf(action);
    if (targetStatus !== null && ctx.statusByEntity?.get(entityKey) === targetStatus) {
      dropped.push({ action, reason: "entidade já está neste estado" });
      continue;
    }

    // 2) pré-check de budget: só ajusta onde o nível-alvo tem budget (evita bater na
    //    Meta à toa quando a regra dispara num nível sem daily/lifetime — ex: CBO).
    if (action.type === "adjust_budget" && ctx.budgetByEntity?.get(entityKey) === false) {
      dropped.push({ action, reason: "budget não está neste nível" });
      continue;
    }

    // 3) anti-compounding: não muda o budget da mesma entidade 2× no dia (cross-run).
    if (action.type === "adjust_budget" && ctx.budgetChangedToday?.has(entityKey)) {
      dropped.push({ action, reason: "budget já ajustado hoje" });
      continue;
    }

    // 4) clamp de mudança de budget (não descarta, limita). Set-absoluto (chat, 5c)
    //    precisa do budget atual p/ traduzir o teto de % — sem ele, não arrisca (dropa).
    let clamped: Action;
    if (action.type === "adjust_budget" && action.params[ACTION_PARAM_MODE] === BUDGET_MODE_SET) {
      const current = ctx.budgetAmountByEntity?.get(entityKey);
      if (current === undefined) {
        dropped.push({ action, reason: "não foi possível verificar o budget atual" });
        continue;
      }
      clamped = clampSetBudget(action, cfg.maxBudgetChangePct, current);
    } else {
      clamped = clampBudgetChange(action, cfg.maxBudgetChangePct);
    }

    // 5) cap de entidades/dia — conta entidades distintas afetadas. Isento na ativação em
    //    cadeia confirmada (intenção única do dono; o eco lista tudo + killSwitch/budget seguem).
    if (!opts.exemptEntityCap && !seenEntities.has(entityKey)) {
      if (seenEntities.size >= cfg.maxEntitiesPerDay) {
        dropped.push({ action: clamped, reason: "limite de entidades/dia atingido" });
        continue;
      }
      seenEntities.add(entityKey);
    }

    allowed.push(clamped);
  }

  // NOTA: `cfg.dryRun` não descarta ações aqui — é aplicado na casca (nó
  // apply_actions), que só simula a mutação. `cfg.llmCostCapUsd` é checado no
  // metering antes de chamar o LLM, fora do guardrail de ações.
  return { allowed, dropped };
}

/**
 * Clampa um budget ABSOLUTO (`mode:'set'`, chat 5c) à faixa [current−maxPct%, current+maxPct%],
 * traduzindo o teto de blast-radius (que é em %) pro valor exato pedido. `clampedFrom` guarda
 * o valor original p/ o eco honesto ("você pediu X, seu teto é Y% → vou pra Z").
 */
function clampSetBudget(action: Action, maxPct: number, currentMinor: number): Action {
  const target = Number(action.params[ACTION_PARAM_AMOUNT_MINOR]);
  if (!Number.isFinite(target) || currentMinor <= 0) return action;
  const upper = Math.round(currentMinor * (1 + maxPct / 100));
  const lower = Math.round(currentMinor * (1 - maxPct / 100));
  const clampedTarget = Math.min(upper, Math.max(lower, target));
  if (clampedTarget === target) return action;
  return {
    ...action,
    params: { ...action.params, [ACTION_PARAM_AMOUNT_MINOR]: clampedTarget, clampedFrom: target },
  };
}

/** Limita a magnitude de mudança de budget ao teto configurado. `pct` = magnitude (≥0). */
function clampBudgetChange(action: Action, maxPct: number): Action {
  if (action.type !== "adjust_budget") return action;
  const pct = action.params[ACTION_PARAM_PCT];
  if (typeof pct !== "number") return action;
  const magnitude = Math.abs(pct);
  if (magnitude <= maxPct) return action;
  return {
    ...action,
    params: { ...action.params, [ACTION_PARAM_PCT]: maxPct, clampedFrom: pct },
  };
}

// ─── Aviso de OPORTUNIDADE de guardrail (v3, "sinal vivo") ────────────────
// NÃO é aprendizado — é oportunidade. Detectado no momento da ANÁLISE: quando a magnitude que
// o analista QUIS propor excede o teto do guardrail (o clamp deixou R$ na mesa) E há um prior
// MEDIDO de que escalar compensa nesta conta E o R$ bloqueado é material → emite um flag. Só
// APONTA pra config (a UI faz o deep-link); NUNCA muta o guardrail (hard-wall). Detecção PURA
// (proposto vs teto), sem instrumentar o apply-service.

/** Uma escala de budget que o guardrail clampou (o analista queria mais que o teto). */
export interface ClampedBudgetRaise {
  /** magnitude % que o analista PEDIU (antes do clamp). */
  readonly wantedPct: number;
  /** teto de blast-radius do guardrail (%). */
  readonly cappedPct: number;
  /** budget diário atual da entidade (unidade mínima) — base do R$ bloqueado. */
  readonly currentBudgetMinor: number;
}

export interface GuardrailOpportunityInput {
  readonly clampedRaises: readonly ClampedBudgetRaise[];
  /** há prior MEDIDO de que escalar o que tem base compensa nesta conta (`account_scale_pays`)? */
  readonly hasScalePaysPrior: boolean;
  /** R$ mínimo (unidade mínima) bloqueado p/ valer o aviso (materialidade). */
  readonly minMaterialMinor: number;
}

export interface GuardrailOpportunity {
  readonly threshold: "maxBudgetChangePct";
  readonly wantedPct: number;
  readonly cappedPct: number;
  /** R$ (unidade mínima) que o teto está deixando na mesa (estimativa por dia). */
  readonly foregoneMinor: number;
}

/**
 * Detecta a oportunidade de afrouxar o teto de budget do guardrail (só APONTA — nunca muta).
 * Só nasce com as TRÊS condições: (1) o guardrail clampou uma escala real (proposto > teto);
 * (2) há prior medido de que escalar compensa nesta conta; (3) o R$ bloqueado é material.
 * Escolhe a maior oportunidade (mais R$ na mesa). Pura. `null` = nada a sinalizar.
 */
export function detectGuardrailOpportunity(input: GuardrailOpportunityInput): GuardrailOpportunity | null {
  if (!input.hasScalePaysPrior) return null;
  let best: GuardrailOpportunity | null = null;
  for (const c of input.clampedRaises) {
    if (c.wantedPct <= c.cappedPct || c.currentBudgetMinor <= 0) continue;
    const foregoneMinor = Math.round(c.currentBudgetMinor * ((c.wantedPct - c.cappedPct) / 100));
    if (foregoneMinor < input.minMaterialMinor) continue;
    if (!best || foregoneMinor > best.foregoneMinor) {
      best = { threshold: "maxBudgetChangePct", wantedPct: c.wantedPct, cappedPct: c.cappedPct, foregoneMinor };
    }
  }
  return best;
}

// ─── Guardrail de GASTO NOVO (Fatia 7 — criação) ─────────────────────────
// Rede de segurança sobre a CRIAÇÃO (rascunho), irmã de `applyGuardrails` (que age
// sobre `Action[]`). Criação não é `Action` → função separada. PURA; o contexto
// cross-run (nº de campanhas criadas hoje) vem da casca.

/** Contexto cross-run da criação (dado pela casca). */
export interface CreationGuardrailContext {
  /** nº de campanhas novas já criadas hoje (conta no cap/dia). */
  readonly createdCampaignsToday?: number;
}

export interface CreationGuardrailResult {
  /** rascunho liberado (possivelmente com budget clampado); `null` = barrado. */
  readonly allowed: CampaignDraft | null;
  /** motivo do bloqueio; `null` = passou. */
  readonly dropped: { readonly reason: string } | null;
  /** budget diário original quando houve clamp (p/ o eco honesto). */
  readonly clampedFromMinor?: number;
}

/**
 * Rede de segurança do gasto novo. Ordem: killSwitch → cap de campanhas novas/dia →
 * clamp do budget diário novo. Clamp NÃO descarta (limita); cap e killSwitch barram.
 */
export function applyCreationGuardrails(
  draft: CampaignDraft,
  cfg: GuardrailConfig,
  ctx: CreationGuardrailContext = {},
): CreationGuardrailResult {
  if (cfg.killSwitch) {
    return { allowed: null, dropped: { reason: "kill switch ativo" } };
  }

  const maxPerDay = cfg.maxNewCampaignsPerDay ?? DEFAULT_MAX_NEW_CAMPAIGNS_PER_DAY;
  const createdToday = ctx.createdCampaignsToday ?? 0;
  if (createdToday >= maxPerDay) {
    return {
      allowed: null,
      // nomeia a config EXATA a ajustar (não a de entidades) — o usuário caía na config errada.
      dropped: { reason: `você atingiu o limite de campanhas novas por dia (${maxPerDay}). Aumente em Segurança › Limites de criação › “Máx. campanhas novas/dia” e aprove de novo` },
    };
  }

  const maxBudget = cfg.maxNewDailyBudgetMinor ?? DEFAULT_MAX_NEW_DAILY_BUDGET_MINOR;
  const requested = draft.spec.dailyBudgetMinor;
  if (requested > maxBudget) {
    const clamped: CampaignDraft = {
      ...draft,
      spec: { ...draft.spec, dailyBudgetMinor: maxBudget },
    };
    return { allowed: clamped, dropped: null, clampedFromMinor: requested };
  }

  return { allowed: draft, dropped: null };
}

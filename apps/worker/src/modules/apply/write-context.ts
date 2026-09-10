// Contexto de escrita para o chat (5c-3): resolve conta + guardrail config + contexto
// cross-run E lê o estado FRESCO de cada entidade-alvo (status + budget) p/ o guardrail
// poder detectar no-op (statusByEntity) e clampar budget set-absoluto (budgetAmountByEntity)
// ANTES do eco — assim o eco reflete o que de fato vai acontecer. IO na casca; o guardrail
// segue puro. Diferente do `applyConfirmedAction` (approval-apply), que só precisa do
// contexto diário (as aprovações nunca carregam budget set-absoluto).

import { and, eq } from "drizzle-orm";
import { agents, guardrailConfigs } from "@trafego/db";
import { entityKeyOf, type GuardrailContext } from "@trafego/core";
import { DEFAULT_CURRENCY, toGuardrailConfig } from "@trafego/shared";
import type { ActionTarget, EntityStatus, GuardrailConfig } from "@trafego/shared";
import type { AdAccountRef } from "@trafego/shared/ports";
import { mapStatus } from "@trafego/ads-meta";
import type { WorkerDeps } from "../../composition.js";
import { createAnalysisRepo, loadDailyToolContext } from "../analysis/repo.js";
import { loadEnabledTools, enabledActionTypes } from "../tools/enabled.js";

/** Tipo do orçamento da entidade: diário (por dia) ou vitalício (total do período). */
export type BudgetPeriodKind = "daily" | "lifetime";

/**
 * Compatibilidade de tipo de orçamento entre as duas pernas de uma realocação. Mover "X/dia" de um
 * diário pra um vitalício (ou vice-versa) não é coerente (um é por dia, o outro é o total) →
 * incompatível. Mesmo tipo → devolve o rótulo de período pro eco. PURA (testável sem IO).
 */
export function reallocKindPeriod(
  fromKind: BudgetPeriodKind,
  toKind: BudgetPeriodKind,
): { readonly ok: true; readonly period: string } | { readonly ok: false } {
  if (fromKind !== toKind) return { ok: false };
  return { ok: true, period: fromKind === "lifetime" ? " no total" : "/dia" };
}

export interface WriteContext {
  readonly account: AdAccountRef;
  /** moeda da conta (ISO) — formata o budget no eco de escrita. */
  readonly currency: string;
  readonly cfg: GuardrailConfig;
  readonly ctx: GuardrailContext;
  /** tipo do orçamento (diário/vitalício) por entidade — rotula o eco (não confunde /dia com total). */
  readonly budgetKindByEntity: Map<string, BudgetPeriodKind>;
}

/** Budget do estado (daily preferido) em unidade mínima + o TIPO, ou null se o nível não tem. */
function budgetAmountOf(state: Record<string, unknown>): { amountMinor: number; kind: BudgetPeriodKind } | null {
  const daily = Number(state["daily_budget"]);
  if (Number.isFinite(daily) && daily > 0) return { amountMinor: daily, kind: "daily" };
  const lifetime = Number(state["lifetime_budget"]);
  if (Number.isFinite(lifetime) && lifetime > 0) return { amountMinor: lifetime, kind: "lifetime" };
  return null;
}

/**
 * Monta o contexto de escrita do chat: conta/token (via agente), guardrail config,
 * contexto diário (cap/dia + anti-compounding) e — por leitura FRESCA de cada alvo —
 * status/budget atuais. Conta indisponível → null (o chamador recusa com clareza).
 */
export async function loadWriteContext(
  deps: WorkerDeps,
  orgId: string,
  agentId: string,
  targets: readonly ActionTarget[],
): Promise<WriteContext | null> {
  const { db, ports, logger } = deps;
  const repo = createAnalysisRepo(db);

  const [ag] = await db
    .select({ adAccountId: agents.adAccountId })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  const account = ag ? await repo.loadAccount(orgId, ag.adAccountId) : null;
  if (!account) return null;
  const accessToken = ports.vault.decrypt(account.tokenCripto);
  const ref: AdAccountRef = { adAccountId: account.metaAdAccountId, accessToken };

  const [guardrailRow] = await db
    .select()
    .from(guardrailConfigs)
    .where(and(eq(guardrailConfigs.agentId, agentId), eq(guardrailConfigs.orgId, orgId)))
    .limit(1);
  // A2: allowedActions do guardrail vem AUTORITATIVA dos bindings (mesma fonte do gate do chat) —
  // senão a tool passa no chat e barra aqui (ou vice-versa). Fallback preserva o comportamento.
  const baseCfg = toGuardrailConfig(guardrailRow);
  const enabled = await loadEnabledTools(db, orgId, agentId, baseCfg.allowedActions);
  const cfg: GuardrailConfig = { ...baseCfg, allowedActions: enabledActionTypes(enabled) };
  const daily = await loadDailyToolContext(db, agentId);

  const statusByEntity = new Map<string, EntityStatus>();
  const budgetByEntity = new Map<string, boolean>();
  const budgetAmountByEntity = new Map<string, number>();
  const budgetKindByEntity = new Map<string, BudgetPeriodKind>();
  // 1 leitura fresca por alvo distinto (chat = baixo volume; interativo).
  const seen = new Set<string>();
  for (const target of targets) {
    const key = entityKeyOf(target);
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const fresh = await ports.ads.readEntityState(ref, target.id);
      statusByEntity.set(key, mapStatus(fresh["effective_status"] as string | undefined, fresh["status"] as string | undefined));
      const budget = budgetAmountOf(fresh);
      budgetByEntity.set(key, budget !== null);
      if (budget !== null) {
        budgetAmountByEntity.set(key, budget.amountMinor);
        budgetKindByEntity.set(key, budget.kind);
      }
    } catch (err) {
      logger.warn({ agentId, entityId: target.id, err }, "chat-write:leitura fresca falhou");
    }
  }

  return {
    account: ref,
    currency: account.currency ?? DEFAULT_CURRENCY,
    cfg,
    budgetKindByEntity,
    ctx: {
      touchedToday: daily.touchedToday,
      budgetChangedToday: daily.budgetChangedToday,
      statusByEntity,
      budgetByEntity,
      budgetAmountByEntity,
    },
  };
}

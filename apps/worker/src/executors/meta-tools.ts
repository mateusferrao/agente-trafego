// Executor de ESCRITA na Meta via AdsPlatformPort. Cada execução:
//  - resolve idempotencyKey (agent_tool_calls.idempotency_key) → nunca aplica 2x
//  - aplica (ou SIMULA, se dryRun) via mutate() — que devolve before/after
//  - grava agent_tool_calls (args/result/before/risk) + audit_log (before/after)
//  - registra usage_events (ação aplicada) via MeteringPort
// A regra de negócio (guardrail, autonomia, conflito) já rodou ANTES daqui.

import { and, eq } from "drizzle-orm";
import { agentToolCalls, approvals, auditLog, campaignDrafts } from "@trafego/db";
import type { Action, ActionTarget } from "@trafego/shared/types";
import type { AdAccountRef, MutationResult } from "@trafego/shared/ports";
import { UNDO_BLOCKED_TOOL_KEY, UNDO_TOOL_KEY, type OrgId, type RunId } from "@trafego/shared";
import { entityKeyOf } from "@trafego/core";
import { targetingChanged } from "@trafego/ads-meta";
import type { WorkerDeps } from "../composition.js";

/** Ator da auditoria de escrita autônoma. */
const ACTOR_AGENT = "agent";
/** Tool key de editar público (drift fino no revert, D4) — fonte única do vocabulário. */
const ADJUST_AUDIENCE_KEY = "adjust_audience";
/** Campo do público cru no before/after de `adjust_audience`. */
const TARGETING_KEY = "targeting";
/** Dimensão genérica de metering p/ ação aplicada (base do billing por markup). */
const USAGE_TYPE_ACTION_APPLIED = "action_applied";

/** `agent_tool_call` carregado p/ o undo (org-scoped na casca que o carregou). */
export interface RevertToolCall {
  readonly id: string;
  readonly agentId: string | null;
  readonly runId: string | null;
  /** tipo da ação original — seleciona o re-check de drift (adjust_audience = targeting fino, D4). */
  readonly toolKey: string;
  readonly beforeState: Record<string, unknown> | null;
  readonly args: Record<string, unknown>;
  /** result da ação original ({ before, after }) — base do re-check de drift. */
  readonly result: Record<string, unknown> | null;
}

export interface RevertInput {
  readonly orgId: string;
  readonly account: AdAccountRef;
  readonly toolCall: RevertToolCall;
  /** ignora o drift (usuário confirmou "reverter mesmo assim"). */
  readonly force?: boolean;
  /** reversão de CRIAÇÃO/escala: pausar (default) ou arquivar a árvore criada. */
  readonly mode?: "pause" | "archive";
}

export interface RevertResult {
  readonly reverted: boolean;
  readonly reason?: string;
  /** re-check barrou por drift (entidade mudou desde a ação) — pede confirmação. */
  readonly blockedByDrift?: boolean;
}

/**
 * Campos de estado relevantes ao drift COARSE (status + budgets; ignora derivados) — usado no revert
 * de pausar/retomar/status/budget. O revert de `adjust_audience` NÃO passa por aqui: ele usa o drift
 * FINO de público (`detectRevertDrift` → `targetingChanged` sobre o `targeting` cru, D4), que
 * detecta edição CONCORRENTE de público entre o apply e o revert. Separar por tipo evita ler o
 * targeting pesado (e falso-positivar) no revert de budget/status. */
function driftFields(state: Record<string, unknown> | null | undefined): string {
  const s = state ?? {};
  return JSON.stringify({
    status: s["status"],
    daily_budget: s["daily_budget"],
    lifetime_budget: s["lifetime_budget"],
  });
}

export interface ExecuteActionInput {
  /** dono da ação — âncora do cap diário/undo/trilha (sempre presente). */
  readonly agentId: string;
  /** run de análise que originou a ação; null p/ escrita LIVRE por chat (5c). */
  readonly runId: string | null;
  readonly orgId: string;
  readonly account: AdAccountRef;
  readonly action: Action;
  /** chave idempotente estável (`${runId}:${action.id}` ou `conv:${conversationId}:${action.id}`). */
  readonly idempotencyKey: string;
  /** ensaio: simula (lê + computa) sem escrever na Meta. */
  readonly dryRun: boolean;
}

export interface ExecutedAction {
  readonly result: MutationResult;
  readonly dryRun: boolean;
  /** veio do registro idempotente (não re-aplicou). */
  readonly replayed: boolean;
}

function targetKey(action: Action): string {
  return entityKeyOf(action.target);
}

export function makeMetaToolExecutor(deps: WorkerDeps) {
  const { db, ports, logger } = deps;

  /** Aplica (ou simula) uma ação de escrita, idempotente + auditada. */
  async function execute(input: ExecuteActionInput): Promise<ExecutedAction> {
    const { agentId, runId, orgId, account, action, idempotencyKey, dryRun } = input;

    // idempotência: já aplicado? → devolve o result gravado (sem re-mutar).
    const [existing] = await db
      .select({ result: agentToolCalls.result })
      .from(agentToolCalls)
      .where(eq(agentToolCalls.idempotencyKey, idempotencyKey))
      .limit(1);
    if (existing?.result) {
      const stored = existing.result as unknown as MutationResult & { dryRun?: boolean };
      return { result: stored, dryRun: stored.dryRun ?? false, replayed: true };
    }

    const result = await ports.ads.mutate(account, action, { dryRun });

    await db
      .insert(agentToolCalls)
      .values({
        agentId,
        runId,
        toolKey: action.type,
        idempotencyKey,
        risk: action.riskLevel,
        args: { target: action.target, params: action.params, source: action.source, dryRun },
        result: { ...result, dryRun },
        beforeState: result.before as Record<string, unknown>,
      })
      .onConflictDoNothing();

    await db.insert(auditLog).values({
      orgId,
      actor: ACTOR_AGENT,
      action: `meta.${action.type}${dryRun ? ".dry_run" : ""}`,
      target: targetKey(action),
      metadata: { agentId, runId, dryRun, risk: action.riskLevel },
      before: result.before as Record<string, unknown>,
      after: result.after as Record<string, unknown>,
    });

    // metering só de ações REAIS (dry-run não é faturável — não infla o markup).
    if (!dryRun) {
      await ports.metering.record({
        orgId: orgId as OrgId,
        ...(runId ? { runId: runId as RunId } : {}),
        type: USAGE_TYPE_ACTION_APPLIED,
        payload: { actionType: action.type, target: targetKey(action), risk: action.riskLevel },
      });
    }

    logger.info({ runId, action: action.type, dryRun }, "meta-tool:applied");
    return { result, dryRun, replayed: false };
  }

  /** Undo: reaplica o `before_state` de um tool_call REAL. Idempotente (`${id}:undo`). */
  async function revert(input: RevertInput): Promise<RevertResult> {
    const { orgId, account, toolCall, force } = input;
    const args = toolCall.args as { target?: ActionTarget; dryRun?: boolean };
    if (args?.dryRun) return { reverted: false, reason: "ação simulada — nada a reverter" };
    if (!toolCall.beforeState || !args?.target) return { reverted: false, reason: "sem estado anterior" };

    const undoKey = `${toolCall.id}:${UNDO_TOOL_KEY}`;
    const [existing] = await db
      .select({ id: agentToolCalls.id })
      .from(agentToolCalls)
      .where(eq(agentToolCalls.idempotencyKey, undoKey))
      .limit(1);
    if (existing) return { reverted: true, reason: "já revertido" };

    const target = args.target;

    // Detecta drift por TIPO de ação: `adjust_audience` compara o `targeting` cru FINO (D4 —
    // pega edição concorrente de público); as demais comparam status+budget (coarse). Separar
    // por tipo evita ler o targeting pesado (e falso-positivar) no revert de budget/status.
    const detectRevertDrift = async (
      tc: typeof toolCall,
      tgt: ActionTarget,
      after: Record<string, unknown> | undefined,
    ): Promise<{ reason: string; current: Record<string, unknown> | null } | null> => {
      if (tc.toolKey === ADJUST_AUDIENCE_KEY) {
        const afterTargeting = after?.[TARGETING_KEY];
        if (!afterTargeting || typeof afterTargeting !== "object") return null; // sem baseline → não bloqueia
        const current = await ports.ads.readAdSetTargeting(account, tgt.id);
        // contenção (não igualdade): a Meta enriquece o read-back → só barra se um campo que
        // ESCREVEMOS não está mais no ar (edição concorrente), ignorando os extras da Meta.
        if (targetingChanged(current, afterTargeting as Record<string, unknown>)) {
          return { reason: "o público do conjunto mudou desde a edição — reverter sobrescreveria a mudança", current };
        }
        return null;
      }
      if (!after) return null;
      const current = await ports.ads.readEntityState(account, tgt.id);
      if (driftFields(current) !== driftFields(after)) {
        return { reason: "a entidade mudou desde a ação — reverter sobrescreveria a mudança", current };
      }
      return null;
    };

    // re-check de DRIFT (5b): compara o estado FRESCO com o que a ação deixou (`after`).
    // Divergiu (alguém mexeu depois) e sem `force` → NÃO reverte (evita sobrescrever a
    // mudança posterior); registra o bloqueio p/ a UI pedir confirmação ("mesmo assim").
    if (!force) {
      const after = (toolCall.result as { after?: Record<string, unknown> } | null)?.after;
      const drift = await detectRevertDrift(toolCall, target, after);
      if (drift) {
        await db
          .insert(agentToolCalls)
          .values({
            agentId: toolCall.agentId,
            runId: toolCall.runId,
            toolKey: UNDO_BLOCKED_TOOL_KEY,
            idempotencyKey: `${toolCall.id}:${UNDO_BLOCKED_TOOL_KEY}`,
            risk: "low",
            args: { revertOf: toolCall.id, target },
            result: { reason: drift.reason, current: drift.current },
          })
          .onConflictDoNothing();
        logger.info({ toolCallId: toolCall.id }, "undo:barrado por drift");
        return { reverted: false, blockedByDrift: true, reason: drift.reason };
      }
    }

    const restore = await ports.ads.restoreEntityState(account, target.id, toolCall.beforeState);
    const targetLabel = entityKeyOf(target);

    await db
      .insert(agentToolCalls)
      .values({
        agentId: toolCall.agentId,
        runId: toolCall.runId,
        toolKey: UNDO_TOOL_KEY,
        idempotencyKey: undoKey,
        risk: "low",
        args: { revertOf: toolCall.id, target },
        result: { ...restore },
        beforeState: restore.before as Record<string, unknown>,
      })
      .onConflictDoNothing();

    await db.insert(auditLog).values({
      orgId,
      actor: ACTOR_AGENT,
      action: `meta.${UNDO_TOOL_KEY}`,
      target: targetLabel,
      metadata: { revertOf: toolCall.id },
      before: restore.before as Record<string, unknown>,
      after: restore.after as Record<string, unknown>,
    });

    await ports.metering.record({
      orgId: orgId as OrgId,
      ...(toolCall.runId ? { runId: toolCall.runId as RunId } : {}),
      type: USAGE_TYPE_ACTION_APPLIED,
      payload: { actionType: UNDO_TOOL_KEY, target: targetLabel, revertOf: toolCall.id },
    });

    logger.info({ toolCallId: toolCall.id }, "meta-tool:reverted");
    return { reverted: true };
  }

  /**
   * Reversão de uma CRIAÇÃO/escala (Slice 11) — algoritmo DISTINTO do `revert` (não há
   * `before_state`/drift: a árvore não existia antes). Desmonta pausando (default) ou arquivando
   * a RAIZ (`args.target`, gravado no apply): como o `effective_status` da Meta é o AND da árvore,
   * pausar/arquivar a campanha raiz já para toda a entrega dos filhos. Idempotente (`${id}:undo`);
   * marca o rascunho `created → reverted`.
   */
  async function revertCreation(input: RevertInput): Promise<RevertResult> {
    const { orgId, account, toolCall } = input;
    const mode = input.mode ?? "pause";
    const args = toolCall.args as { target?: ActionTarget; draftId?: string; dryRun?: boolean };
    if (args?.dryRun) return { reverted: false, reason: "ação simulada — nada a reverter" };

    const createdIds = (toolCall.result as { createdIds?: Record<string, unknown> } | null)?.createdIds ?? {};
    const rootId = createdIds["campaignId"] ?? createdIds["copiedId"];
    // alvo = raiz criada. `args.target` (Slice 9) é a fonte; fallback p/ tool_calls pré-Slice-9.
    const target: ActionTarget | undefined =
      args.target ?? (rootId ? { level: "campaign", id: String(rootId) } : undefined);
    if (!target) return { reverted: false, reason: "não achei a campanha criada pra reverter" };

    const undoKey = `${toolCall.id}:${UNDO_TOOL_KEY}`;
    const [existing] = await db
      .select({ id: agentToolCalls.id, args: agentToolCalls.args })
      .from(agentToolCalls)
      .where(eq(agentToolCalls.idempotencyKey, undoKey))
      .limit(1);
    // Já revertido: idempotente no MESMO modo. Uma corrida "arquivar" DEPOIS de "pausar" ESCALA
    // (aplica ARCHIVED e atualiza o registro — a árvore já estava parada, só faltava tirar da lista
    // ativa); "pausar" DEPOIS de "arquivar" é no-op honesto (não desarquiva). Sem isso, o 2º pedido
    // devolveria sucesso sem aplicar nada (toast desonesto numa lista stale).
    const existingMode: "pause" | "archive" = (existing?.args as { mode?: "pause" | "archive" } | undefined)?.mode ?? "pause";
    const isEscalation = Boolean(existing) && existingMode === "pause" && mode === "archive";
    if (existing && !isEscalation) {
      return { reverted: true, reason: existingMode === "archive" ? "essa campanha já estava arquivada" : "essa campanha já estava pausada" };
    }

    const status = mode === "archive" ? "ARCHIVED" : "PAUSED";
    const action: Action = {
      id: `${toolCall.id}:revert`,
      type: "set_status",
      target,
      params: { status },
      source: "llm",
      riskLevel: "high",
      reason: mode === "archive" ? "arquivar a campanha criada (reversão)" : "pausar a campanha criada (reversão)",
    };
    let result: MutationResult;
    try {
      result = await ports.ads.mutate(account, action, { dryRun: false });
    } catch (error) {
      logger.error({ err: error, toolCallId: toolCall.id, mode }, "revertCreation:mutate falhou");
      return { reverted: false, reason: mode === "archive" ? "não consegui arquivar a campanha na Meta" : "não consegui pausar a campanha na Meta" };
    }

    const targetLabel = entityKeyOf(target);
    if (isEscalation) {
      // escalar pause → archive: atualiza o registro existente (o undoKey já ocupa a chave).
      await db
        .update(agentToolCalls)
        .set({ args: { revertOf: toolCall.id, target, mode }, result: { ...result }, beforeState: result.before as Record<string, unknown> })
        .where(eq(agentToolCalls.idempotencyKey, undoKey));
    } else {
      await db
        .insert(agentToolCalls)
        .values({
          agentId: toolCall.agentId,
          runId: toolCall.runId,
          toolKey: UNDO_TOOL_KEY,
          idempotencyKey: undoKey,
          risk: "low",
          args: { revertOf: toolCall.id, target, mode },
          result: { ...result },
          beforeState: result.before as Record<string, unknown>,
        })
        .onConflictDoNothing();
    }

    await db.insert(auditLog).values({
      orgId,
      actor: ACTOR_AGENT,
      action: `meta.${UNDO_TOOL_KEY}`,
      target: targetLabel,
      metadata: { revertOf: toolCall.id, mode, ...(isEscalation ? { escalatedFrom: "pause" } : {}) },
      before: result.before as Record<string, unknown>,
      after: result.after as Record<string, unknown>,
    });

    await ports.metering.record({
      orgId: orgId as OrgId,
      ...(toolCall.runId ? { runId: toolCall.runId as RunId } : {}),
      type: USAGE_TYPE_ACTION_APPLIED,
      payload: { actionType: UNDO_TOOL_KEY, target: targetLabel, revertOf: toolCall.id, mode },
    });

    // transição created → reverted (some da lista de reversíveis; não repropõe).
    if (args.draftId) {
      await db
        .update(campaignDrafts)
        .set({ status: "reverted" })
        .where(and(eq(campaignDrafts.id, args.draftId), eq(campaignDrafts.orgId, orgId)));
      // Cancela a aprovação de ATIVAÇÃO pendente órfã (P0.1): a campanha foi pausada/arquivada, então
      // o "2º OK pra ativar" não faz mais sentido — sem isso, aprovar tentaria ativar algo revertido.
      await db
        .update(approvals)
        .set({ status: "expired" })
        .where(and(eq(approvals.draftId, args.draftId), eq(approvals.orgId, orgId), eq(approvals.kind, "activation"), eq(approvals.status, "pending")));
    }

    logger.info({ toolCallId: toolCall.id, mode }, "meta-tool:creation reverted");
    return { reverted: true };
  }

  return { execute, revert, revertCreation };
}

export type MetaToolExecutor = ReturnType<typeof makeMetaToolExecutor>;

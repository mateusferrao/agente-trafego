import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { adAccounts, agentRuns, agentToolBindings, agentToolCalls, agents, campaignDrafts, guardrailConfigs, type Database } from "@trafego/db";
import type { ApplyOutcome, ApprovalId, CampaignDraftSpec, OrgId, TargetingSpec } from "@trafego/shared/types";
import type { Approval, ApprovalPort, PendingApproval } from "@trafego/shared/ports";
import type { SchedulerPort } from "@trafego/shared/ports";
import { APPROVAL_APPLY_JOB, APPROVAL_APPLY_QUEUE, enabledActionTypes, type ToolBindingMode } from "@trafego/shared";
import { ACTION_PARAM_CURRENT_MINOR, ACTION_PARAM_TARGETING } from "@trafego/shared";
import { computeApplyPreview, describeActionOutcome, describeActivationOutcome, describeCreatedDraft, describeDraftOutcome, editBudgetActionValue, projectBudgetTargetMinor, readModernizations, resolveEnabledTools, type OutcomeDetail } from "@trafego/core";
import { badRequest, notFound } from "../../middleware/error-handler.js";
import { buildExplicitFromInput, serializeExplicitAudience } from "../../lib/audience.js";
import { collapseActivationGroups, computeAppliedActions, DAY_MS } from "../../lib/applied-actions.js";
import type {
  ApprovalOutcomeOutput,
  ApprovalOutput,
  EditApprovalActionInput,
  ResolveApprovalInput,
  ResolveApprovalOutput,
  RevertibleActionOutput,
} from "./schema.js";

/** Unidade mínima por unidade monetária (reais → centavos) — igual ao drafts/service. */
const MINOR_PER_UNIT = 100;

export interface ApprovalsDeps {
  readonly db: Database;
  readonly approvals: ApprovalPort;
  /** enfileira a aplicação (worker re-checa fresco + escreve). A API nunca escreve na Meta. */
  readonly scheduler: SchedulerPort;
  /** janela (dias) em que "reverter" segue disponível (5b) — mesmo TTL da mini-surface. */
  readonly revertTtlDays: number;
}

/**
 * Slice de aprovações (HITL via site, 5b). Lista as pendentes da org (caixa de entrada
 * cross-conta) e resolve por-ação: aprovar → enfileira o apply-service (worker re-checa
 * o estado fresco + guardrail + escreve); rejeitar → resolve direto (sem escrita).
 */
export function createApprovalsService(deps: ApprovalsDeps) {
  interface AgentSignals {
    accountId: string;
    accountName: string;
    currency: string | null;
    accountAvailable: boolean;
    dryRun: boolean;
    killSwitch: boolean;
    /** ACTION-types habilitadas do agente (mesma fonte do apply) — o card usa p/ `actionAllowed`. */
    enabledActions: Set<string>;
  }

  /** agentId → conta + sinais do "antes" (rótulo/moeda + guardrail + ações habilitadas). Os sinais
   *  saem da MESMA fonte do apply (`resolveEnabledTools` + guardrail config) — consistência de gates. */
  async function signalsByAgent(agentIds: readonly string[]): Promise<Map<string, AgentSignals>> {
    const map = new Map<string, AgentSignals>();
    if (agentIds.length === 0) return map;
    const rows = await deps.db
      .select({
        agentId: agents.id,
        accountId: adAccounts.id,
        accountName: adAccounts.name,
        currency: adAccounts.currency,
        accountStatus: adAccounts.status,
        dryRun: guardrailConfigs.dryRun,
        killSwitch: guardrailConfigs.killSwitch,
        allowedActions: guardrailConfigs.allowedActions,
      })
      .from(agents)
      .innerJoin(adAccounts, eq(agents.adAccountId, adAccounts.id))
      .leftJoin(guardrailConfigs, eq(guardrailConfigs.agentId, agents.id))
      .where(inArray(agents.id, [...agentIds]));
    const bindingRows = await deps.db
      .select({ agentId: agentToolBindings.agentId, toolKey: agentToolBindings.toolKey, mode: agentToolBindings.mode })
      .from(agentToolBindings)
      .where(inArray(agentToolBindings.agentId, [...agentIds]));
    const bindingsByAgent = new Map<string, Map<string, ToolBindingMode>>();
    for (const b of bindingRows) {
      const m = bindingsByAgent.get(b.agentId) ?? new Map<string, ToolBindingMode>();
      m.set(b.toolKey, b.mode as ToolBindingMode);
      bindingsByAgent.set(b.agentId, m);
    }
    for (const r of rows) {
      const allowed = new Set((r.allowedActions ?? []) as string[]);
      const enabled = resolveEnabledTools(bindingsByAgent.get(r.agentId) ?? new Map(), allowed);
      map.set(r.agentId, {
        accountId: r.accountId,
        accountName: r.accountName ?? r.accountId,
        currency: r.currency,
        accountAvailable: r.accountStatus === "active",
        dryRun: r.dryRun ?? false,
        killSwitch: r.killSwitch ?? false,
        enabledActions: new Set(enabledActionTypes(enabled)),
      });
    }
    return map;
  }

  /** Deriva a frase de desfecho pela FORMA (ação/rascunho/ativação) — fonte única da copy (voz do Roy). */
  async function outcomeMessageFor(a: PendingApproval, oc: ApplyOutcome, reason: string): Promise<string> {
    if (a.kind === "action") {
      const detail: OutcomeDetail =
        oc === "applied" ? { kind: "applied" }
          : oc === "simulated" ? { kind: "simulated" }
            : oc === "noop" ? { kind: "noop" }
              : oc === "blocked" ? { kind: "blocked", reason }
                : { kind: "failed", ...(reason ? { metaMessage: reason } : {}) };
      return describeActionOutcome(a.action, detail);
    }
    if (a.kind === "activation") {
      return describeActivationOutcome(
        oc === "blocked" ? { kind: "blocked", reason }
          : oc === "failed" ? { kind: "failed", ...(reason ? { metaMessage: reason } : {}) }
            : { kind: "activated", dryRun: oc === "simulated" },
      );
    }
    // rascunho
    if (oc === "blocked") return describeDraftOutcome({ kind: "blocked", reason });
    if (oc === "failed") return describeDraftOutcome({ kind: "failed", ...(reason ? { metaMessage: reason } : {}) });
    const [d] = await deps.db
      .select({ kind: campaignDrafts.kind, spec: campaignDrafts.spec, createdIds: campaignDrafts.createdIds })
      .from(campaignDrafts)
      .where(and(eq(campaignDrafts.id, a.draftId), eq(campaignDrafts.orgId, a.orgId)))
      .limit(1);
    const summary = d ? describeCreatedDraft(d.kind, d.spec as CampaignDraftSpec) : "sua campanha";
    // Limitação conhecida: `activated` (nasceu ativa × pausada) vive no tool_call, não na approval →
    // aqui o site cai no "nasceu pausada" (o caso comum: creationActivation default = paused). O push
    // do WhatsApp tem o desfecho preciso. Persistir `activated` na approval = fast-follow se incomodar.
    return describeDraftOutcome({ kind: "created", dryRun: oc === "simulated", summary, modernizations: readModernizations(d?.createdIds ?? {}) });
  }

  return {
    async listPending(orgId: OrgId): Promise<ApprovalOutput[]> {
      // Rascunhos de campanha (Fatia 7) têm sua própria superfície (card de rascunho);
      // este inbox de AÇÕES lista só as aprovações de ação.
      const pending = (await deps.approvals.listPendingByOrg(orgId)).filter(
        (a): a is Approval => a.kind === "action",
      );
      const accounts = await signalsByAgent([...new Set(pending.map((a) => a.agentId))]);
      return pending.map((a) => {
        const acc = accounts.get(a.agentId);
        // orçamento atual (capturado na proposta) + projeção do proposto — só adjust_budget.
        const rawCurrent = Number(a.action.params[ACTION_PARAM_CURRENT_MINOR]);
        const currentBudgetMinor =
          a.actionType === "adjust_budget" && Number.isFinite(rawCurrent) && rawCurrent > 0 ? rawCurrent : null;
        const targetBudgetMinor =
          a.actionType === "adjust_budget" ? projectBudgetTargetMinor(currentBudgetMinor, a.action.params) : null;
        const currentBudgetMajor = currentBudgetMinor != null ? currentBudgetMinor / MINOR_PER_UNIT : null;
        const targetBudgetMajor = targetBudgetMinor != null ? targetBudgetMinor / MINOR_PER_UNIT : null;
        // público proposto (só adjust_audience) — semente do editor no card.
        const targeting = a.actionType === "adjust_audience" ? (a.action.params[ACTION_PARAM_TARGETING] as TargetingSpec | undefined) : undefined;
        const audience = targeting && targeting.kind === "explicit" ? serializeExplicitAudience(targeting) : null;
        return {
          id: a.id,
          accountId: acc?.accountId ?? "",
          accountName: acc?.accountName ?? "conta",
          entityLevel: a.entityLevel,
          entityId: a.entityId,
          entityName: a.action.target.name ?? null,
          type: a.actionType,
          reason: a.action.reason,
          status: a.status,
          expiresAt: a.expiresAt ? a.expiresAt.toISOString() : null,
          currency: acc?.currency ?? null,
          currentBudgetMajor,
          targetBudgetMajor,
          audience,
          applyPreview: computeApplyPreview({
            dryRun: acc?.dryRun ?? false,
            killSwitch: acc?.killSwitch ?? false,
            accountAvailable: acc?.accountAvailable ?? false,
            capabilityEnabled: acc?.enabledActions.has(a.actionType) ?? false,
            kind: "action",
          }),
          ressalvas: a.action.ressalvas ? [...a.action.ressalvas] : null,
        };
      });
    },

    /** Desfecho da aplicação de UMA aprovação (Fatia "depois") — o card faz polling disto após
     *  aprovar. A frase (`outcomeMessage`) vem do describe por KIND (fonte única, voz do Roy):
     *  ação, rascunho ou ativação. */
    async getOutcome(orgId: OrgId, approvalId: ApprovalId): Promise<ApprovalOutcomeOutput> {
      const a = await deps.approvals.getById(approvalId);
      if (!a || a.orgId !== orgId) throw notFound("Aprovação não encontrada.");
      const oc = a.applyOutcome;
      const outcomeMessage = oc === null ? null : await outcomeMessageFor(a, oc, a.resolvedReason ?? "");
      return { id: a.id, status: a.status, applyOutcome: oc ?? null, resolvedReason: a.resolvedReason ?? null, outcomeMessage };
    },

    async resolve(
      orgId: OrgId,
      approvalId: ApprovalId,
      input: ResolveApprovalInput,
    ): Promise<ResolveApprovalOutput> {
      const approval = await deps.approvals.getById(approvalId);
      if (!approval || approval.orgId !== orgId) throw notFound("Aprovação não encontrada.");
      if (approval.status !== "pending") throw badRequest("Essa aprovação já foi resolvida.");

      if (input.decision === "reject") {
        const resolved = await deps.approvals.resolve(approvalId, { status: "rejected" });
        return { id: resolved.id, status: resolved.status };
      }

      // aprovar: o WORKER re-checa fresco + aplica (escrita fora da casca HTTP).
      await deps.scheduler.enqueue({
        queue: APPROVAL_APPLY_QUEUE,
        name: APPROVAL_APPLY_JOB,
        payload: { orgId, approvalId },
      });
      return { id: approval.id, status: "pending" };
    },

    /**
     * Edita o VALOR de uma ação `adjust_budget` pendente ANTES de aprovar (C, v1). Núcleo puro
     * `editBudgetActionValue` valida/monta os params; persiste via porta. Só ajuste de orçamento
     * tem valor (pausar/retomar/status = aprovar/rejeitar). Clamp do blast-radius = rede do apply.
     */
    async editAction(
      orgId: OrgId,
      approvalId: ApprovalId,
      input: EditApprovalActionInput,
    ): Promise<ResolveApprovalOutput> {
      const approval = await deps.approvals.getById(approvalId);
      if (!approval || approval.orgId !== orgId) throw notFound("Aprovação não encontrada.");
      if (approval.status !== "pending") throw badRequest("Essa aprovação já foi resolvida.");
      if (approval.kind !== "action") throw badRequest("Só dá pra editar uma ação.");

      // PÚBLICO (adjust_audience, Fatia C): substituição TOTAL do targeting (o editor do site manda
      // o estado completo, já resolvido). Editar o público reseta o aprendizado da Meta (aviso no card).
      if (approval.actionType === "adjust_audience") {
        if (!input.explicitAudience) throw badRequest("Pra editar essa ação, ajuste o público.");
        const targeting = buildExplicitFromInput(input.explicitAudience);
        const nextAction = { ...approval.action, params: { ...approval.action.params, [ACTION_PARAM_TARGETING]: targeting } };
        const updated = await deps.approvals.updatePendingAction(approvalId, nextAction);
        return { id: updated.id, status: updated.status };
      }

      // ORÇAMENTO (adjust_budget): edita o valor. Demais tipos não têm o que editar.
      if (approval.actionType !== "adjust_budget") {
        throw badRequest("Só orçamento e público têm valor editável; pausar/retomar/status é aprovar ou rejeitar.");
      }
      if (input.mode === undefined) throw badRequest("Informe o novo orçamento (mode + pct/budgetReais).");
      const edit =
        input.mode === "set"
          ? { kind: "absolute" as const, amountMinor: Math.round((input.budgetReais ?? 0) * MINOR_PER_UNIT) }
          : { kind: "pct" as const, mode: input.mode, pct: input.pct ?? 0 };
      const r = editBudgetActionValue(approval.action, edit);
      if (!r.ok) throw badRequest(r.error);
      const updated = await deps.approvals.updatePendingAction(approvalId, r.action);
      return { id: updated.id, status: updated.status };
    },

    /**
     * Ações ainda ACIONÁVEIS quanto a reverter, cross-conta (dentro do TTL): as que
     * podem reverter agora + as barradas por drift aguardando "reverter mesmo assim".
     * Já revertidas/simuladas/fora do TTL não aparecem aqui (nada a fazer com elas) —
     * o histórico completo é a Timeline (6a). Sem fallback de nome por lookup (só o
     * `target.name` já embutido no tool_call) — cobre o caso comum; tool_calls muito
     * antigos sem nome caem pro id cru, como em qualquer lugar que já faz esse fallback.
     */
    async listRevertible(orgId: OrgId): Promise<RevertibleActionOutput[]> {
      const since = new Date(Date.now() - deps.revertTtlDays * DAY_MS);
      const rows = await deps.db
        .select({
          id: agentToolCalls.id,
          runId: agentToolCalls.runId,
          toolKey: agentToolCalls.toolKey,
          args: agentToolCalls.args,
          result: agentToolCalls.result,
          idempotencyKey: agentToolCalls.idempotencyKey,
          createdAt: agentToolCalls.createdAt,
          accountId: adAccounts.id,
          accountName: adAccounts.name,
        })
        .from(agentToolCalls)
        // dono via run→agente (análise) OU agentId direto (criação/escrita por chat, runId null) —
        // `coalesce` p/ criações via chat (runId null) também aparecerem nos reversíveis (Slice 11.4).
        .leftJoin(agentRuns, eq(agentToolCalls.runId, agentRuns.id))
        .innerJoin(agents, eq(sql`coalesce(${agentToolCalls.agentId}, ${agentRuns.agentId})`, agents.id))
        .innerJoin(adAccounts, eq(agents.adAccountId, adAccounts.id))
        .where(and(eq(agents.orgId, orgId), gte(agentToolCalls.createdAt, since)));

      const accountByToolCallId = new Map(rows.map((r) => [r.id, { accountId: r.accountId, accountName: r.accountName ?? r.accountId }]));
      // colapsa os N resumes de uma ATIVAÇÃO num único card (a raiz da árvore) — reverter a
      // campanha pausa tudo; sem isso, ativar uma duplicata polui a lista com 1 card por entidade.
      const idempotencyByToolCallId = new Map(rows.map((r) => [r.id, r.idempotencyKey]));
      // colapsa ANTES de filtrar undoable: cada ativação vira só a raiz; reverter a campanha some
      // com o grupo (sem os filhos ressurgirem como cards novos no reload).
      const actions = collapseActivationGroups(computeAppliedActions(rows, deps.revertTtlDays, new Map()), idempotencyByToolCallId).filter(
        (a) => a.undoable || a.revertBlocked,
      );
      return actions
        .map((a) => {
          const acc = accountByToolCallId.get(a.toolCallId);
          return {
            toolCallId: a.toolCallId,
            accountId: acc?.accountId ?? "",
            accountName: acc?.accountName ?? "conta",
            type: a.type,
            targetLevel: a.targetLevel,
            targetId: a.targetId,
            targetName: a.targetName,
            undoable: a.undoable,
            revertBlocked: a.revertBlocked,
            revertBlockedReason: a.revertBlockedReason,
          };
        });
    },
  };
}

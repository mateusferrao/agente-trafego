// Escrita de PLAYBOOK por chat (S2.5). Config de meta/autonomia/guardrail/cadência/
// arquétipo reusa `@trafego/agent-config` (fonte única com o site); playbook CRUD ainda
// NÃO é compartilhado — escrevemos direto em `playbook_rules` seguindo o MESMO shape do
// site (apps/api/.../agents/service.ts: whenJson/thenJson/thenActionType/scope/enabled/
// priority). CANDIDATO a extração p/ shared quando um 3º consumidor aparecer (§13 3x→extrai).

import { and, eq, sql } from "drizzle-orm";
import { agents, auditLog, playbookRules } from "@trafego/db";
import type { ActionType, OrgId } from "@trafego/shared";
import type { PlaybookCondition } from "@trafego/shared/types";
import type { WorkerDeps } from "../../composition.js";
import type { PendingPlaybookOp } from "../../graphs/whatsapp-conversation/state.js";

/** Janela por-regra ainda não aplicada pelo engine (fast-follow): usa a do agente. Espelha a API. */
const PLAYBOOK_WINDOW_PLACEHOLDER = "7d" as const;

/** Ação de auditoria de escrita de playbook por chat (durável — não vaza fase/canal). */
const PLAYBOOK_AUDIT_ACTION: Readonly<Record<PendingPlaybookOp["kind"], string>> = {
  add: "agent.playbook.add",
  toggle: "agent.playbook.toggle",
  remove: "agent.playbook.remove",
};

export interface ApplyPlaybookOpInput {
  readonly orgId: string;
  readonly agentId: string;
  /** ator da trilha = o contato que falou no WhatsApp (§12/§13). */
  readonly contactId: string;
  readonly op: PendingPlaybookOp;
}

export interface ApplyPlaybookOpResult {
  readonly ok: boolean;
  /** desfecho em PT (voz determinística — §UX). */
  readonly message: string;
}

/**
 * Aplica a operação de playbook CONGELADA (add/toggle/remove), org-scoped. Bumpa
 * `config_changed_at` (playbook afeta a análise → força 1 deep run) e audita com o
 * contato como ator. NÃO valida de novo o shape (o gate já validou); só escreve.
 */
export async function applyPlaybookOp(
  deps: WorkerDeps,
  input: ApplyPlaybookOpInput,
): Promise<ApplyPlaybookOpResult> {
  const { db } = deps;
  const { orgId, agentId, contactId, op } = input;

  if (op.kind === "add" && op.rule) {
    const r = op.rule;
    const whenJson: PlaybookCondition = {
      metric: r.metric,
      op: r.op as PlaybookCondition["op"],
      value: r.value,
      window: PLAYBOOK_WINDOW_PLACEHOLDER,
      ...(r.minSpend != null ? { minSpend: r.minSpend } : {}),
    };
    // prioridade nova = fim da fila: menor que todas (a listagem ordena por priority desc).
    const [{ minPriority } = { minPriority: null }] = await db
      .select({ minPriority: sql<number | null>`min(${playbookRules.priority})` })
      .from(playbookRules)
      .where(and(eq(playbookRules.agentId, agentId), eq(playbookRules.orgId, orgId)));
    const priority = minPriority == null ? 0 : minPriority - 1;

    await db.insert(playbookRules).values({
      orgId,
      agentId,
      scope: r.scope,
      whenJson,
      thenJson: r.then as { type: ActionType } & Record<string, unknown>,
      thenActionType: r.then.type as ActionType,
      enabled: true,
      priority,
    });
    await bumpAndAudit(deps, orgId, agentId, contactId, op, { rule: r });
    return { ok: true, message: "Pronto, criei a regra no playbook." };
  }

  if (op.kind === "toggle" && op.ruleId) {
    const updated = await db
      .update(playbookRules)
      .set({ enabled: !!op.enabled, updatedAt: sql`now()` })
      .where(and(eq(playbookRules.id, op.ruleId), eq(playbookRules.agentId, agentId), eq(playbookRules.orgId, orgId)))
      .returning({ id: playbookRules.id });
    if (updated.length === 0) return { ok: false, message: "Não achei essa regra. Vê a lista com as regras de novo?" };
    await bumpAndAudit(deps, orgId, agentId, contactId, op, { ruleId: op.ruleId, enabled: !!op.enabled });
    return { ok: true, message: op.enabled ? "Liguei a regra." : "Desliguei a regra." };
  }

  if (op.kind === "remove" && op.ruleId) {
    const removed = await db
      .delete(playbookRules)
      .where(and(eq(playbookRules.id, op.ruleId), eq(playbookRules.agentId, agentId), eq(playbookRules.orgId, orgId)))
      .returning({ id: playbookRules.id });
    if (removed.length === 0) return { ok: false, message: "Não achei essa regra. Vê a lista com as regras de novo?" };
    await bumpAndAudit(deps, orgId, agentId, contactId, op, { ruleId: op.ruleId });
    return { ok: true, message: "Removi a regra do playbook." };
  }

  return { ok: false, message: "Não entendi a mudança no playbook." };
}

/** Bumpa `config_changed_at` (playbook é relevante à análise) + grava 1 linha de auditoria. */
async function bumpAndAudit(
  deps: WorkerDeps,
  orgId: string,
  agentId: string,
  contactId: string,
  op: PendingPlaybookOp,
  detail: Record<string, unknown>,
): Promise<void> {
  await deps.db
    .update(agents)
    .set({ configChangedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)));
  await deps.db.insert(auditLog).values({
    orgId: orgId as OrgId,
    actor: `contact:${contactId}`,
    action: PLAYBOOK_AUDIT_ACTION[op.kind],
    target: `agent:${agentId}`,
    metadata: { channel: "whatsapp", ...detail },
  });
}

// Saga de ATIVAÇÃO de um rascunho JÁ CRIADO (P0.1 — 2º passo HITL). `apply-draft.ts` sempre cria
// PAUSADO (fecha o risco de órfão em crash); confirmar aqui ATIVA a raiz da árvore criada
// (campanha, se from_scratch; a cópia — no nível de origem, campanha OU adset — se duplicate) via
// o MESMO executor de escrita idempotente/auditado/metered (`makeMetaToolExecutor`). Não cria
// nada novo, não é gasto novo, só resume o status — por isso NÃO passa pelo guardrail de
// blast-radius/cap das 4 ações do catálogo (não se aplica): kill-switch é a única rede.

import { and, eq } from "drizzle-orm";
import { campaignDrafts, guardrailConfigs } from "@trafego/db";
import { toGuardrailConfig } from "@trafego/shared";
import type { Action, EntityLevel } from "@trafego/shared/types";
import type { AdAccountRef } from "@trafego/shared/ports";
import type { WorkerDeps } from "../../composition.js";
import { createAnalysisRepo } from "../analysis/repo.js";
import { makeMetaToolExecutor } from "../../executors/meta-tools.js";

export type ActivationOutcome =
  | { readonly kind: "activated"; readonly dryRun: boolean }
  | { readonly kind: "blocked"; readonly reason: string }
  | { readonly kind: "failed"; readonly error: unknown };

export interface ApplyActivationInput {
  readonly orgId: string;
  readonly draftId: string;
}

interface DraftForActivation {
  readonly kind: "from_scratch" | "duplicate";
  readonly createdIds: Record<string, unknown>;
  readonly sourceRef: { readonly level: EntityLevel; readonly id: string } | null;
}

/** Raiz ativável da árvore criada: a CAMPANHA (from_scratch) ou a CÓPIA no nível de origem
 *  (duplicate — campanha OU adset, conforme o que foi escalado sob CBO/ABO). Ativar a raiz ativa
 *  toda a árvore criada sob ela na Meta (adsets/ads herdam o status). `null` = ids ausentes
 *  (nunca deveria acontecer num rascunho `created`, mas não assume). */
function rootEntity(draft: DraftForActivation): { level: "campaign" | "adset"; id: string } | null {
  if (draft.kind === "duplicate") {
    const id = draft.createdIds["copiedId"];
    const level = draft.sourceRef?.level;
    return typeof id === "string" && id.length > 0 && (level === "campaign" || level === "adset")
      ? { level, id }
      : null;
  }
  const id = draft.createdIds["campaignId"];
  return typeof id === "string" && id.length > 0 ? { level: "campaign", id } : null;
}

/**
 * Confirma a ativação (site/chat). Exige o rascunho já `created` (nada a ativar antes).
 * Idempotente via o `idempotencyKey` do executor (`draft:${id}:activate` — nunca ativa 2x).
 */
export async function applyActivation(deps: WorkerDeps, input: ApplyActivationInput): Promise<ActivationOutcome> {
  const { db, ports, logger } = deps;
  const repo = createAnalysisRepo(db);

  const [row] = await db
    .select()
    .from(campaignDrafts)
    .where(and(eq(campaignDrafts.id, input.draftId), eq(campaignDrafts.orgId, input.orgId)))
    .limit(1);
  if (!row) return { kind: "blocked", reason: "rascunho não encontrado" };
  if (row.status !== "created") return { kind: "blocked", reason: "esse rascunho ainda não foi criado" };

  const [guardrailRow] = await db
    .select()
    .from(guardrailConfigs)
    .where(and(eq(guardrailConfigs.agentId, row.agentId), eq(guardrailConfigs.orgId, input.orgId)))
    .limit(1);
  const cfg = toGuardrailConfig(guardrailRow);
  if (cfg.killSwitch) return { kind: "blocked", reason: "kill switch ativo" };

  const root = rootEntity({
    kind: row.kind,
    createdIds: (row.createdIds ?? {}) as Record<string, unknown>,
    sourceRef: row.sourceRef ?? null,
  });
  if (!root) return { kind: "blocked", reason: "não encontrei o que ativar (ids de criação ausentes)" };

  const account = await repo.loadAccount(input.orgId, row.adAccountId);
  if (!account) return { kind: "blocked", reason: "conta indisponível" };
  const ref: AdAccountRef = { adAccountId: account.metaAdAccountId, accessToken: ports.vault.decrypt(account.tokenCripto) };

  const action: Action = {
    id: `activate:${row.id}`,
    type: "resume_entity",
    target: { level: root.level, id: root.id },
    params: {},
    source: "llm",
    riskLevel: "low",
    reason: "ativação confirmada pelo usuário",
  };

  try {
    const done = await makeMetaToolExecutor(deps).execute({
      agentId: row.agentId,
      runId: row.runId,
      orgId: input.orgId,
      account: ref,
      action,
      idempotencyKey: `draft:${row.id}:activate`,
      dryRun: cfg.dryRun,
    });
    logger.info({ draftId: row.id, dryRun: done.dryRun }, "apply-activation:ativado");
    return { kind: "activated", dryRun: done.dryRun };
  } catch (error) {
    logger.error({ draftId: row.id, err: error }, "apply-activation:falhou");
    return { kind: "failed", error };
  }
}

// Saga de ATIVAÇÃO de um rascunho JÁ CRIADO (P0.1 — 2º passo HITL). `apply-draft.ts` sempre cria
// PAUSADO (fecha o risco de órfão em crash); confirmar aqui ATIVA a ÁRVORE INTEIRA criada
// (campanha+adset+ads no from_scratch; a cópia + adsets intermediários + ads no duplicate) via
// o MESMO executor de escrita idempotente/auditado/metered (`makeMetaToolExecutor`). A Meta NÃO
// cascateia status (entrega = campanha ∧ adset ∧ ad), então resumir só a raiz deixaria a árvore
// pausada e a campanha nunca veicularia. Não cria nada novo, não é gasto novo, só resume o status
// — por isso NÃO passa pelo guardrail de blast-radius/cap das 4 ações do catálogo (não se aplica):
// kill-switch é a única rede.

import { and, eq } from "drizzle-orm";
import { campaignDrafts, guardrailConfigs } from "@trafego/db";
import { toGuardrailConfig } from "@trafego/shared";
import type { Action, EntityLevel } from "@trafego/shared/types";
import type { AdAccountRef } from "@trafego/shared/ports";
import { mapStatus } from "@trafego/ads-meta";
import type { WorkerDeps } from "../../composition.js";
import { createAnalysisRepo } from "../analysis/repo.js";
import { makeMetaToolExecutor } from "../../executors/meta-tools.js";

export type ActivationOutcome =
  // `notDelivering` (G8): a DUPLICATA de conjunto entra na campanha da FONTE (não numa criada por nós);
  // se essa campanha-mãe estiver pausada, ligar o conjunto não faz veicular (a Meta não cascateia p/
  // cima) → o desfecho não afirma "veiculando".
  | { readonly kind: "activated"; readonly dryRun: boolean; readonly notDelivering?: boolean }
  | { readonly kind: "blocked"; readonly reason: string }
  | { readonly kind: "failed"; readonly error: unknown };

export interface ApplyActivationInput {
  readonly orgId: string;
  readonly draftId: string;
}

export interface DraftForActivation {
  readonly kind: "from_scratch" | "duplicate";
  readonly createdIds: Record<string, unknown>;
  readonly sourceRef: { readonly level: EntityLevel; readonly id: string } | null;
}

type ActivateTarget = { readonly level: EntityLevel; readonly id: string };

/** `createdIds[key]` como string não-vazia, senão null (shape defensivo). */
function idAt(ids: Record<string, unknown>, key: string): string | null {
  const v = ids[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}
/** `createdIds[key]` como lista de strings não-vazias. */
function idsAt(ids: Record<string, unknown>, key: string): string[] {
  const v = ids[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
}

/** G8: o conjunto copiado está entregando? Lê o `effective_status` (que rola p/ baixo a partir da
 *  campanha-mãe da fonte) — não-active = a mãe está pausada. Best-effort: erro de leitura → `false`
 *  (não afirma nada de errado; a ativação em si já foi aplicada). */
async function copiedAdsetNotDelivering(deps: WorkerDeps, ref: AdAccountRef, createdIds: Record<string, unknown> | null): Promise<boolean> {
  const copiedId = idAt(createdIds ?? {}, "copiedId");
  if (!copiedId) return false;
  try {
    const fresh = await deps.ports.ads.readEntityState(ref, copiedId);
    return mapStatus(fresh["effective_status"] as string | undefined, fresh["status"] as string | undefined) !== "active";
  } catch (err) {
    deps.logger.warn({ err, copiedId }, "apply-activation:leitura de entrega do conjunto copiado falhou");
    return false;
  }
}

/**
 * ENTIDADES a ativar = a ÁRVORE INTEIRA criada, pausada (§P0.1). A Meta NÃO cascateia status
 * (a entrega efetiva é o E-lógico da árvore: campanha ∧ adset ∧ ad), então ativar só a raiz
 * deixaria adset/ads pausados e a campanha nunca veicularia. from_scratch: campanha+adset+ads.
 * duplicate: a cópia-raiz (campanha OU adset) + adsets intermediários (só no deep_copy de
 * campanha) + ads copiados. Vazio = ids ausentes (não deveria num rascunho `created`).
 */
export function entitiesToActivate(draft: DraftForActivation): ActivateTarget[] {
  const ids = draft.createdIds;
  const out: ActivateTarget[] = [];
  if (draft.kind === "from_scratch") {
    const campaignId = idAt(ids, "campaignId");
    const adsetId = idAt(ids, "adsetId");
    if (campaignId) out.push({ level: "campaign", id: campaignId });
    if (adsetId) out.push({ level: "adset", id: adsetId });
    for (const adId of idsAt(ids, "adIds")) out.push({ level: "ad", id: adId });
    return out;
  }
  const copiedId = idAt(ids, "copiedId");
  const rootLevel = draft.sourceRef?.level;
  if (copiedId && (rootLevel === "campaign" || rootLevel === "adset")) out.push({ level: rootLevel, id: copiedId });
  for (const adsetId of idsAt(ids, "childAdsetIds")) out.push({ level: "adset", id: adsetId });
  for (const adId of idsAt(ids, "childIds")) out.push({ level: "ad", id: adId });
  return out;
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

  const targets = entitiesToActivate({
    kind: row.kind,
    createdIds: (row.createdIds ?? {}) as Record<string, unknown>,
    sourceRef: row.sourceRef ?? null,
  });
  if (targets.length === 0) return { kind: "blocked", reason: "não encontrei o que ativar (ids de criação ausentes)" };

  const account = await repo.loadAccount(input.orgId, row.adAccountId);
  if (!account) return { kind: "blocked", reason: "conta indisponível" };
  const ref: AdAccountRef = { adAccountId: account.metaAdAccountId, accessToken: ports.vault.decrypt(account.tokenCripto) };

  // Resume CADA entidade da árvore (a Meta não cascateia). Idempotency key POR entidade →
  // um retry após falha parcial re-ativa só o que faltou (resume é idempotente de qualquer jeito).
  const executor = makeMetaToolExecutor(deps);
  let dryRun = cfg.dryRun;
  try {
    for (const target of targets) {
      const action: Action = {
        id: `activate:${row.id}:${target.id}`,
        type: "resume_entity",
        target: { level: target.level, id: target.id },
        params: {},
        source: "llm",
        riskLevel: "low",
        reason: "ativação confirmada pelo usuário",
      };
      const done = await executor.execute({
        agentId: row.agentId,
        runId: row.runId,
        orgId: input.orgId,
        account: ref,
        action,
        idempotencyKey: `draft:${row.id}:activate:${target.id}`,
        dryRun: cfg.dryRun,
      });
      dryRun = done.dryRun;
    }
    logger.info({ draftId: row.id, dryRun, entities: targets.length }, "apply-activation:ativado (árvore inteira)");
    // G8: duplicata de CONJUNTO entra na campanha da FONTE (não criamos a campanha-mãe) — se ela
    // estiver pausada, ligar só o conjunto não veicula (o efetivo rola p/ baixo). Lê o efetivo do
    // conjunto copiado: não-active = a mãe está pausada → o desfecho é honesto (não diz "veiculando").
    // Best-effort (falha de leitura NÃO derruba a ativação, que já foi aplicada).
    const notDelivering = !dryRun && row.kind === "duplicate" && (row.sourceRef ?? null)?.level === "adset" ? await copiedAdsetNotDelivering(deps, ref, row.createdIds) : false;
    return { kind: "activated", dryRun, ...(notDelivering ? { notDelivering: true } : {}) };
  } catch (error) {
    logger.error({ draftId: row.id, err: error }, "apply-activation:falhou");
    return { kind: "failed", error };
  }
}

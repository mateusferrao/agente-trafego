// Saga de aplicação de um RASCUNHO de campanha (Fatia 7). Relê o rascunho fresco →
// re-roda o guardrail de gasto novo → executa a criação na Meta (idempotente por
// created_ids) → grava agent_tool_calls (beforeState=null, result=createdIds) +
// audit_log + metering → marca campaign_drafts.status. Reusa o padrão de
// apply-confirmed-action / meta-tools. O EFEITO no chamador (resolver approval / push).

import { and, count, eq, gte } from "drizzle-orm";
import { agentToolCalls, auditLog, campaignDrafts, guardrailConfigs } from "@trafego/db";
import { applyCreationGuardrails, buildDuplicateInput } from "@trafego/core";
import { toGuardrailConfig, type CampaignDraft, type OrgId } from "@trafego/shared";
import type { AdAccountRef } from "@trafego/shared/ports";
import type { WorkerDeps } from "../../composition.js";
import { createAnalysisRepo } from "../analysis/repo.js";

const ACTOR_AGENT = "agent";
const USAGE_TYPE_CAMPAIGN_CREATED = "campaign_created";
const TOOL_KEY_DUPLICATE = "duplicate_scale";
/** Janela do cap de campanhas novas/dia (rolling 24h — igual ao contexto de tool diário). */
const CREATION_DAY_MS = 24 * 60 * 60 * 1000;

/** Desfecho tipado (o chamador mapeia p/ resolver a approval + push). */
export type DraftApplyOutcome =
  | { readonly kind: "created"; readonly dryRun: boolean; readonly createdIds: Record<string, unknown> }
  | { readonly kind: "blocked"; readonly reason: string }
  | { readonly kind: "failed"; readonly error: unknown }
  | { readonly kind: "unsupported"; readonly reason: string };

export interface ApplyDraftInput {
  readonly orgId: string;
  readonly draftId: string;
}

/**
 * Casca IO da saga de criação. Idempotente: rascunho já `created` (com created_ids) →
 * replay sem tocar na Meta. Guardrail de gasto novo re-checado fresco; barrado → `blocked`
 * (+ status=failed com motivo). `dryRun` (cfg) simula a saga (não cria na Meta).
 */
export async function applyDraft(deps: WorkerDeps, input: ApplyDraftInput): Promise<DraftApplyOutcome> {
  const { db, ports, logger } = deps;
  const repo = createAnalysisRepo(db);

  const [row] = await db
    .select()
    .from(campaignDrafts)
    .where(and(eq(campaignDrafts.id, input.draftId), eq(campaignDrafts.orgId, input.orgId)))
    .limit(1);
  if (!row) return { kind: "blocked", reason: "rascunho não encontrado" };

  // idempotência: já criado → replay (retomada de retry não duplica).
  if (row.status === "created" && Object.keys(row.createdIds ?? {}).length > 0) {
    return { kind: "created", dryRun: false, createdIds: row.createdIds as Record<string, unknown> };
  }

  const draft: CampaignDraft = {
    kind: row.kind,
    spec: row.spec,
    ...(row.sourceRef ? { sourceRef: row.sourceRef } : {}),
  };

  // conta + token frescos.
  const account = await repo.loadAccount(input.orgId, row.adAccountId);
  if (!account) return { kind: "blocked", reason: "conta indisponível" };
  const accessToken = ports.vault.decrypt(account.tokenCripto);
  const ref: AdAccountRef = { adAccountId: account.metaAdAccountId, accessToken };

  // guardrail de gasto novo (fresco + cross-run).
  const [guardrailRow] = await db
    .select()
    .from(guardrailConfigs)
    .where(and(eq(guardrailConfigs.agentId, row.agentId), eq(guardrailConfigs.orgId, input.orgId)))
    .limit(1);
  const cfg = toGuardrailConfig(guardrailRow);
  const since = new Date(Date.now() - CREATION_DAY_MS);
  const [{ n } = { n: 0 }] = await db
    .select({ n: count() })
    .from(campaignDrafts)
    .where(
      and(
        eq(campaignDrafts.adAccountId, row.adAccountId),
        eq(campaignDrafts.status, "created"),
        gte(campaignDrafts.createdAt, since),
      ),
    );

  const check = applyCreationGuardrails(draft, cfg, { createdCampaignsToday: n });
  if (!check.allowed) {
    await db.update(campaignDrafts).set({ status: "failed" }).where(eq(campaignDrafts.id, row.id));
    return { kind: "blocked", reason: check.dropped?.reason ?? "barrado pelo guardrail de gasto novo" };
  }
  const allowed = check.allowed;

  if (allowed.kind !== "duplicate") {
    // criar-do-zero (saga create*) chega na S3.
    return { kind: "unsupported", reason: "criação do zero ainda não disponível" };
  }

  await db.update(campaignDrafts).set({ status: "creating" }).where(eq(campaignDrafts.id, row.id));

  const dryRun = cfg.dryRun;
  let createdIds: Record<string, unknown> = {};
  try {
    if (!dryRun) {
      const dup = await ports.ads.duplicateEntity(ref, buildDuplicateInput(allowed));
      createdIds = { copiedId: dup.copiedId, childIds: dup.childIds };
    } else {
      createdIds = { simulated: true };
    }
  } catch (error) {
    await db.update(campaignDrafts).set({ status: "failed" }).where(eq(campaignDrafts.id, row.id));
    return { kind: "failed", error };
  }

  await db
    .insert(agentToolCalls)
    .values({
      agentId: row.agentId,
      runId: row.runId,
      toolKey: TOOL_KEY_DUPLICATE,
      idempotencyKey: `draft:${row.id}:apply`,
      risk: "high",
      args: { draftId: row.id, kind: row.kind, dryRun },
      result: { createdIds, dryRun },
      beforeState: null,
    })
    .onConflictDoNothing();

  await db.insert(auditLog).values({
    orgId: input.orgId,
    actor: ACTOR_AGENT,
    action: `meta.duplicate_scale${dryRun ? ".dry_run" : ""}`,
    target: `${allowed.sourceRef?.level}:${allowed.sourceRef?.id}`,
    metadata: { agentId: row.agentId, draftId: row.id, dryRun },
    before: null,
    after: createdIds,
  });

  if (!dryRun) {
    await ports.metering.record({
      orgId: input.orgId as OrgId,
      type: USAGE_TYPE_CAMPAIGN_CREATED,
      payload: { draftId: row.id, kind: row.kind },
      adAccountId: row.adAccountId,
    });
  }

  await db
    .update(campaignDrafts)
    .set({ status: "created", createdIds })
    .where(eq(campaignDrafts.id, row.id));

  logger.info({ draftId: row.id, dryRun }, "apply-draft:created");
  return { kind: "created", dryRun, createdIds };
}

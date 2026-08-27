// Saga de aplicação de um RASCUNHO de campanha (Fatia 7). Relê o rascunho fresco →
// re-roda o guardrail de gasto novo → executa a criação na Meta (idempotente por
// created_ids) → grava agent_tool_calls (beforeState=null, result=createdIds) +
// audit_log + metering → marca campaign_drafts.status. Reusa o padrão de
// apply-confirmed-action / meta-tools. O EFEITO no chamador (resolver approval / push).

import { and, count, eq, gte, inArray } from "drizzle-orm";
import { agentToolCalls, auditLog, campaignDrafts, guardrailConfigs } from "@trafego/db";
import { applyCreationGuardrails, buildDuplicateInput, goalNounPt } from "@trafego/core";
import { DEFAULT_CONVERSION_GOAL, toGuardrailConfig, type CampaignDraft, type CampaignDraftSpec, type OrgId } from "@trafego/shared";
import type { ApprovalId } from "@trafego/shared";
import { AdsPlatformError, type AdAccountRef } from "@trafego/shared/ports";
import type { WorkerDeps } from "../../composition.js";
import { createAnalysisRepo } from "../analysis/repo.js";
import { loadEnabledTools } from "../tools/enabled.js";

const ACTOR_AGENT = "agent";
const USAGE_TYPE_CAMPAIGN_CREATED = "campaign_created";
const TOOL_KEY_DUPLICATE = "duplicate_scale";
const TOOL_KEY_CREATE = "create_campaign";
/** Categoria especial default (§7): sem categoria; override por-agente = fast-follow. */
const DEFAULT_SPECIAL_AD_CATEGORIES: readonly string[] = [];
/** Janela do cap de campanhas novas/dia (rolling 24h — igual ao contexto de tool diário). */
const CREATION_DAY_MS = 24 * 60 * 60 * 1000;
/** Vencedor legado (criativo com recurso descontinuado) não pode ser duplicado como está.
 *  Honesto + 2 saídas explícitas (subir budget / recriar criativo). Auto-recriar-do-zero foi
 *  descartado (baixa-fidelidade + eco+confirma) — ver ROADMAP / plano. */
const NOT_DUPLICABLE_REASON =
  "esse vencedor usa um recurso que a Meta descontinuou para cópia, então não consigo cloná-lo fielmente. " +
  "Posso subir o orçamento dele agora, ou você recria o criativo no Gerenciador de Anúncios que eu duplico";

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

  // Gate de criação (A2, NET-NEW): a capacidade (create_campaign|duplicate_scale) desligada
  // nos bindings → nem chega na Meta. MESMA fonte (bindings) que o chat/site/auto usam. Após
  // o replay idempotente (um já-criado sempre retorna created, mesmo se depois desligarem).
  const creationToolKey = row.kind === "duplicate" ? TOOL_KEY_DUPLICATE : TOOL_KEY_CREATE;
  const enabledCreation = await loadEnabledTools(db, input.orgId, row.agentId);
  if (!enabledCreation.has(creationToolKey)) {
    await db.update(campaignDrafts).set({ status: "failed" }).where(and(eq(campaignDrafts.id, row.id), eq(campaignDrafts.orgId, input.orgId)));
    return { kind: "blocked", reason: "essa capacidade de criação está desligada para este agente" };
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
  // Cap rolling 24h de campanhas novas/dia. APROXIMAÇÃO: conta por `createdAt` do rascunho (quando
  // foi proposto), não pelo instante em que foi aplicado na Meta — um rascunho proposto há >24h e
  // aplicado agora escapa. Aceitável como teto de segurança; medir pelo apply-time = fast-follow.
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
    await db.update(campaignDrafts).set({ status: "failed" }).where(and(eq(campaignDrafts.id, row.id), eq(campaignDrafts.orgId, input.orgId)));
    return { kind: "blocked", reason: check.dropped?.reason ?? "barrado pelo guardrail de gasto novo" };
  }
  const allowed = check.allowed;

  // valida pré-requisitos do criar-do-zero (Page + criativo) — sem eles não dá pra criar.
  if (allowed.kind === "from_scratch") {
    if (!allowed.spec.pageId || !allowed.spec.creative) {
      return { kind: "blocked", reason: "faltou a Página ou o criativo pra criar a campanha" };
    }
  }

  // Claim ATÔMICO da transição proposed|failed → creating: um único UPDATE guardado por
  // status serializa dois applies concorrentes do MESMO rascunho (ex: usuário confirma no
  // chat e aprova no site na janela em que o card ainda está pendente). O 2º pega 0 linhas
  // (status já é `creating`) e aborta — sem isso, ambos leriam createdIds vazio e criariam
  // campanha/duplicata em DOBRO (gasto novo real). Retry de `failed` é permitido (retomada).
  const claimed = await db
    .update(campaignDrafts)
    .set({ status: "creating" })
    .where(
      and(
        eq(campaignDrafts.id, row.id),
        eq(campaignDrafts.orgId, input.orgId),
        inArray(campaignDrafts.status, ["proposed", "failed"]),
      ),
    )
    .returning({ id: campaignDrafts.id });
  if (claimed.length === 0) {
    logger.debug({ draftId: row.id }, "apply-draft:already_in_flight");
    return { kind: "blocked", reason: "este rascunho já está sendo aplicado" };
  }

  const dryRun = cfg.dryRun;
  const toolKey = allowed.kind === "duplicate" ? TOOL_KEY_DUPLICATE : TOOL_KEY_CREATE;
  // createdIds parte do que já foi criado (retomada) e é PERSISTIDO a cada passo — um retry
  // após falha parcial pula o que já existe. `/copies`/`create*` não têm idempotência nativa,
  // então a persistência incremental É a idempotência. LIMITAÇÃO conhecida: um crash na janela
  // (ms) entre a Meta retornar o create e o persist deixa um órfão que o retry re-cria (dup).
  // Mitigado por PENDING_REVIEW (a Meta revisa antes de veicular → não gasta na hora) + claim
  // atômico. Fechar 100% = criar PAUSED → persist → ativar no fim (fast-follow no ROADMAP).
  const createdIds: Record<string, unknown> = { ...(row.createdIds ?? {}) };
  const persist = async (patch: Record<string, unknown>): Promise<void> => {
    Object.assign(createdIds, patch);
    await db.update(campaignDrafts).set({ createdIds }).where(and(eq(campaignDrafts.id, row.id), eq(campaignDrafts.orgId, input.orgId)));
  };
  try {
    if (dryRun) {
      Object.assign(createdIds, { simulated: true });
    } else if (allowed.kind === "duplicate") {
      if (!createdIds["copiedId"]) {
        const dup = await ports.ads.duplicateEntity(ref, buildDuplicateInput(allowed));
        await persist({ copiedId: dup.copiedId, childIds: dup.childIds });
      }
      if (!createdIds["budgetApplied"]) {
        await ports.ads.setEntityBudget(ref, createdIds["copiedId"] as string, allowed.spec.dailyBudgetMinor);
        await persist({ budgetApplied: true });
      }
    } else {
      await runFromScratchSaga(ports.ads, allowed, ref, createdIds, persist);
    }
  } catch (error) {
    // createdIds já foi persistido incrementalmente → o retry retoma daqui.
    await db.update(campaignDrafts).set({ status: "failed" }).where(and(eq(campaignDrafts.id, row.id), eq(campaignDrafts.orgId, input.orgId)));
    // vencedor legado (criativo descontinuado): falha HONESTA + 2 saídas, não erro genérico.
    // Nada foi criado (o /copies falhou antes do 1º persist) → sem órfão pra reconciliar.
    if (error instanceof AdsPlatformError && error.kind === "not_duplicable") {
      return { kind: "blocked", reason: NOT_DUPLICABLE_REASON };
    }
    return { kind: "failed", error };
  }

  await db
    .insert(agentToolCalls)
    .values({
      agentId: row.agentId,
      runId: row.runId,
      toolKey,
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
    action: `meta.${toolKey}${dryRun ? ".dry_run" : ""}`,
    target: allowed.sourceRef ? `${allowed.sourceRef.level}:${allowed.sourceRef.id}` : `account:${row.adAccountId}`,
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
    .where(and(eq(campaignDrafts.id, row.id), eq(campaignDrafts.orgId, input.orgId)));

  logger.info({ draftId: row.id, dryRun }, "apply-draft:created");
  return { kind: "created", dryRun, createdIds };
}

/**
 * Auto-criação PROATIVA (C): o agente cria sozinho ("age sozinho" por-ação) — com travas.
 * (1) força o rascunho a nascer **PAUSED** (não veicula sozinho; nasce pendente de revisão);
 * (2) aplica a saga (o guardrail de gasto novo é re-checado = rede; criar-do-zero sem criativo
 * é barrado lá dentro); (3) resolve a approval pendente conforme o desfecho (some do inbox).
 * `failed` mantém a approval PENDENTE (humano reaprova). O nudge transparente fica no chamador.
 */
export async function autoApplyProactiveDraft(
  deps: WorkerDeps,
  input: { readonly orgId: string; readonly draftId: string; readonly approvalId: string },
): Promise<DraftApplyOutcome> {
  const { db, ports, logger } = deps;
  // trava #1: PAUSED sempre (read-modify-write no spec) — mesmo que o proponente marque active.
  const [row] = await db
    .select({ spec: campaignDrafts.spec })
    .from(campaignDrafts)
    .where(and(eq(campaignDrafts.id, input.draftId), eq(campaignDrafts.orgId, input.orgId)))
    .limit(1);
  if (row?.spec) {
    const spec: CampaignDraftSpec = { ...(row.spec as CampaignDraftSpec), activation: "paused" };
    await db
      .update(campaignDrafts)
      .set({ spec })
      .where(and(eq(campaignDrafts.id, input.draftId), eq(campaignDrafts.orgId, input.orgId)));
  }

  const outcome = await applyDraft(deps, { orgId: input.orgId, draftId: input.draftId });
  const approvalId = input.approvalId as ApprovalId;
  if (outcome.kind === "created") {
    await ports.approval.resolve(approvalId, { status: "approved" });
  } else if (outcome.kind === "blocked" || outcome.kind === "unsupported") {
    await ports.approval.resolve(approvalId, { status: "blocked", resolvedReason: outcome.reason });
  } else {
    // failed → mantém pendente (a promessa de criar não some; humano reaprova).
    logger.warn({ draftId: input.draftId }, "auto-create:saga falhou — approval mantida pendente");
  }
  return outcome;
}

/**
 * Saga de criar-do-zero: createCampaign → createAdSet → por variação (createAdCreative →
 * createAd). RETOMÁVEL: `persist` grava `createdIds` após CADA id → um retry pula o que já
 * existe (sem duplicar gasto). Pareamento por índice de variação: um criativo órfão (ad
 * falhou) é reusado na retomada, não recriado. `state` = createdIds mutável (lido + escrito).
 */
async function runFromScratchSaga(
  ads: WorkerDeps["ports"]["ads"],
  draft: CampaignDraft,
  ref: AdAccountRef,
  state: Record<string, unknown>,
  persist: (patch: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  const spec = draft.spec;
  const goal = spec.objective ?? DEFAULT_CONVERSION_GOAL;
  const status = spec.activation;
  const name = `AutoTraffic — ${goalNounPt(goal)}`;

  if (!state["campaignId"]) {
    const { campaignId } = await ads.createCampaign(ref, {
      name,
      objectiveGoal: goal,
      specialAdCategories: DEFAULT_SPECIAL_AD_CATEGORIES,
      status,
    });
    await persist({ campaignId });
  }
  if (!state["adsetId"]) {
    const { adsetId } = await ads.createAdSet(ref, {
      campaignId: state["campaignId"] as string,
      name: `${name} — conjunto`,
      dailyBudgetMinor: spec.dailyBudgetMinor,
      goal,
      ...(spec.pixelId ? { pixelId: spec.pixelId } : {}),
      targeting: spec.targeting ?? { kind: "advantage_plus" },
      status,
    });
    await persist({ adsetId });
  }

  const variants = spec.copyVariants ?? [];
  const creativeIds = [...((state["creativeIds"] as string[] | undefined) ?? [])];
  const adIds = [...((state["adIds"] as string[] | undefined) ?? [])];
  const creative = spec.creative;
  for (let i = 0; i < variants.length; i++) {
    if (adIds[i]) continue; // variação já completa (retomada)
    const v = variants[i]!;
    if (!creativeIds[i]) {
      const { creativeId } = await ads.createAdCreative(ref, {
        name: `${name} — criativo ${i + 1}`,
        pageId: spec.pageId!,
        ...(creative?.metaImageHash ? { imageHash: creative.metaImageHash } : {}),
        ...(creative?.metaVideoId ? { videoId: creative.metaVideoId } : {}),
        ...(spec.linkUrl ? { linkUrl: spec.linkUrl } : {}),
        copy: {
          primaryText: v.primaryText,
          headline: v.headline,
          ...(v.description ? { description: v.description } : {}),
          ...(v.cta ? { cta: v.cta } : {}),
        },
      });
      creativeIds[i] = creativeId;
      await persist({ creativeIds: [...creativeIds] });
    }
    const { adId } = await ads.createAd(ref, {
      adsetId: state["adsetId"] as string,
      creativeId: creativeIds[i]!,
      name: `${name} — anúncio ${i + 1}`,
      status,
    });
    adIds[i] = adId;
    await persist({ adIds: [...adIds] });
  }
}

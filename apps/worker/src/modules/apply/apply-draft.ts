// Saga de aplicação de um RASCUNHO de campanha (Fatia 7). Relê o rascunho fresco →
// re-roda o guardrail de gasto novo → executa a criação na Meta (idempotente por
// created_ids) → grava agent_tool_calls (beforeState=null, result=createdIds) +
// audit_log + metering → marca campaign_drafts.status. Reusa o padrão de
// apply-confirmed-action / meta-tools. O EFEITO no chamador (resolver approval / push).

import { and, count, eq, gte, inArray, sql } from "drizzle-orm";
import { agentToolCalls, approvals, auditLog, campaignDrafts, guardrailConfigs } from "@trafego/db";
import type { Database } from "@trafego/db/client";
import { applyCreationGuardrails, buildDuplicateInput, goalNounPt, planScaledBudget, readModernizations, type ScaledBudgetPlan } from "@trafego/core";
import { DEFAULT_CONVERSION_GOAL, toGuardrailConfig, type CampaignDraft, type OrgId } from "@trafego/shared";
import type { AgentId, ApprovalId, DraftId, RunId } from "@trafego/shared";
import { AdsPlatformError, type AdAccountRef } from "@trafego/shared/ports";
import type { WorkerDeps } from "../../composition.js";
import { createAnalysisRepo } from "../analysis/repo.js";
import { loadEnabledTools } from "../tools/enabled.js";
import { applyActivation } from "./apply-activation.js";

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

/**
 * Conta as campanhas novas dentro do cap/dia (P0.4 — fix): apply-time REAL via `agent_tool_calls`
 * (o `create_campaign`/`duplicate_scale` mais recente do agente), não `createdAt` do rascunho —
 * um rascunho proposto há >24h e aplicado agora não escapa mais o cap. Exclui dry-run (não gasta,
 * não deve consumir o cap). Soma o EM-VOO (`campaign_drafts` `creating` do mesmo agente) só quando
 * o agente não está em dry-run — sem isso, dois applies de rascunhos DIFERENTES concorrentes lêem
 * o mesmo N e podem estourar o cap transitoriamente (o tool_call só é gravado no FIM da saga).
 */
export async function countCreationsLast24h(
  db: Database,
  input: { readonly agentId: string; readonly adAccountId: string; readonly dryRun: boolean },
): Promise<number> {
  const since = new Date(Date.now() - CREATION_DAY_MS);
  const [{ n: appliedToday } = { n: 0 }] = await db
    .select({ n: count() })
    .from(agentToolCalls)
    .where(
      and(
        eq(agentToolCalls.agentId, input.agentId),
        inArray(agentToolCalls.toolKey, [TOOL_KEY_DUPLICATE, TOOL_KEY_CREATE]),
        gte(agentToolCalls.createdAt, since),
        sql`(${agentToolCalls.args} ->> 'dryRun') IS DISTINCT FROM 'true'`,
      ),
    );
  if (input.dryRun) return appliedToday;
  const [{ n: inFlight } = { n: 0 }] = await db
    .select({ n: count() })
    .from(campaignDrafts)
    .where(and(eq(campaignDrafts.adAccountId, input.adAccountId), eq(campaignDrafts.status, "creating")));
  return appliedToday + inFlight;
}

/** Aprovação TTL — reusa a mesma janela da aprovação de criação (24h, §8). */
const ACTIVATION_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Desfecho tipado (o chamador mapeia p/ resolver a approval + push). Ativação (v1):
 * `creationActivation="active"` → a árvore é ATIVADA já no fim do create (`activated:true`),
 * sem 2º OK; `="paused"` → nasce pausada + `activationApprovalId` (o 2º OK pra ativar depois).
 * A saga SEMPRE cria pausada primeiro (fecha o risco de órfão em crash); "active" só resume no fim.
 */
export type DraftApplyOutcome =
  | {
      readonly kind: "created";
      readonly dryRun: boolean;
      readonly createdIds: Record<string, unknown>;
      readonly activationApprovalId: string | null;
      /** true quando nasceu ativa (creationActivation="active" e a ativação foi aplicada). */
      readonly activated: boolean;
    }
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

  // idempotência: já criado → replay (retomada de retry não duplica). Reporta a activation
  // approval PENDENTE se houver uma (mesmo desfecho de sempre, sem recriar a linha).
  if (row.status === "created" && Object.keys(row.createdIds ?? {}).length > 0) {
    const [pendingActivation] = await db
      .select({ id: approvals.id })
      .from(approvals)
      .where(and(eq(approvals.draftId, row.id), eq(approvals.kind, "activation"), eq(approvals.status, "pending")))
      .limit(1);
    return {
      kind: "created",
      dryRun: false,
      createdIds: row.createdIds as Record<string, unknown>,
      activationApprovalId: pendingActivation?.id ?? null,
      activated: false, // replay: não re-ativa nem re-avisa (o desfecho já saiu no 1º apply).
    };
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
  // Cap rolling 24h de campanhas novas/dia — pelo APPLY-TIME real (P0.4, ver countCreationsLast24h).
  const n = await countCreationsLast24h(db, { agentId: row.agentId, adAccountId: row.adAccountId, dryRun: cfg.dryRun });

  const check = applyCreationGuardrails(draft, cfg, { createdCampaignsToday: n });
  if (!check.allowed) {
    await db.update(campaignDrafts).set({ status: "failed" }).where(and(eq(campaignDrafts.id, row.id), eq(campaignDrafts.orgId, input.orgId)));
    return { kind: "blocked", reason: check.dropped?.reason ?? "barrado pelo guardrail de gasto novo" };
  }
  const allowed = check.allowed;

  // valida pré-requisitos do criar-do-zero: OU reuso de criativos por referência (cópia fiel,
  // Fatia 7 — não precisa de Page/criativo, o creative_id já traz tudo), OU Page + criativo novo.
  if (allowed.kind === "from_scratch") {
    const hasRefs = (allowed.spec.creativeRefs?.length ?? 0) > 0;
    if (!hasRefs && (!allowed.spec.pageId || !allowed.spec.creative)) {
      return { kind: "blocked", reason: "faltou a Página ou o criativo pra criar a campanha" };
    }
  }

  // P0.1: a criação SEMPRE nasce PAUSADA na saga (fecha o risco de órfão em crash — um crash na
  // janela entre a Meta retornar o create e o persist deixaria um órfão que o retry re-cria;
  // pausado, esse órfão não gasta). `requestedActivation` (v1 — vem do creationActivation do
  // agente, gravado no spec) decide NO FIM: "active" → ATIVA a árvore já (sem 2º OK); "paused" →
  // cria a approval de ATIVAÇÃO (o 2º OK pra ativar depois). Os dois avisam no WhatsApp (S7).
  const requestedActivation = allowed.spec.activation;
  const pausedDraft: CampaignDraft = { ...allowed, spec: { ...allowed.spec, activation: "paused" } };

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
  const toolKey = pausedDraft.kind === "duplicate" ? TOOL_KEY_DUPLICATE : TOOL_KEY_CREATE;
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
    } else if (pausedDraft.kind === "duplicate") {
      if (!createdIds["copiedId"]) {
        const dup = await ports.ads.duplicateEntity(ref, buildDuplicateInput(pausedDraft));
        await persist({ copiedId: dup.copiedId, childIds: dup.childIds, childAdsetIds: dup.childAdsetIds, modernizations: dup.modernizations });
      }
      if (!createdIds["budgetApplied"]) {
        const copiedId = createdIds["copiedId"] as string;
        const target = pausedDraft.spec.dailyBudgetMinor;
        // Duplicata de CAMPANHA: decide o NÍVEL do budget pelo modelo (setar na campanha ABO liga
        // CBO e a Meta recusa se os conjuntos têm metas diferentes). CBO → campanha; ABO → distribui
        // entre os conjuntos (soma EXATA = alvo) e avisa o dono. Adset-level → seta no conjunto.
        if (pausedDraft.sourceRef?.level === "campaign") {
          // Snapshot do PLANO na 1ª vez (dos conjuntos ORIGINAIS): um retry reaplica o MESMO plano
          // (setEntityBudget é idempotente), sem re-derivar de conjuntos já parcialmente ajustados.
          let plan = createdIds["budgetPlan"] as ScaledBudgetPlan | undefined;
          if (!plan) {
            plan = planScaledBudget(await ports.ads.getCampaignBudgetLayout(ref, copiedId), target);
            await persist({ budgetPlan: plan });
          }
          if (plan.kind === "campaign") {
            await ports.ads.setEntityBudget(ref, copiedId, plan.dailyMinor);
            await persist({ budgetApplied: true });
          } else {
            for (const b of plan.budgets) await ports.ads.setEntityBudget(ref, b.id, b.dailyMinor);
            await persist({ budgetApplied: true, modernizations: [...readModernizations(createdIds), { code: "budget_distributed_across_adsets" as const }] });
          }
        } else {
          await ports.ads.setEntityBudget(ref, copiedId, target);
          await persist({ budgetApplied: true });
        }
      }
    } else {
      await runFromScratchSaga(ports.ads, pausedDraft, ref, createdIds, persist);
    }
  } catch (error) {
    // createdIds já foi persistido incrementalmente → o retry retoma daqui.
    await db.update(campaignDrafts).set({ status: "failed" }).where(and(eq(campaignDrafts.id, row.id), eq(campaignDrafts.orgId, input.orgId)));
    // vencedor legado (criativo descontinuado): falha HONESTA + 2 saídas, não erro genérico.
    // Sem órfão pra reconciliar: a cópia é ATÔMICA — o adapter reverte os parciais (DELETE cascata)
    // antes de lançar, então `createdIds` fica vazio (nada persistido no draft).
    if (error instanceof AdsPlatformError && error.kind === "not_duplicable") {
      return { kind: "blocked", reason: NOT_DUPLICABLE_REASON };
    }
    return { kind: "failed", error };
  }

  // `target` = raiz criada na Meta (campanha do zero, ou a entidade copiada na escala). Grava no
  // tool_call p/ a reversão (Slice 11) montar o rótulo/alvo do item reversível sem hack — e p/
  // `computeAppliedActions` (função pura) não ver `target` vazio. Ausente em dry-run (nada criado).
  const revertTarget = dryRun
    ? undefined
    : row.kind === "duplicate"
      ? createdIds["copiedId"]
        ? {
            level: pausedDraft.sourceRef?.level ?? "campaign",
            id: createdIds["copiedId"] as string,
            ...(pausedDraft.sourceRef?.name ? { name: pausedDraft.sourceRef.name } : {}),
          }
        : undefined
      : createdIds["campaignId"]
        ? {
            level: "campaign" as const,
            id: createdIds["campaignId"] as string,
            ...(pausedDraft.spec.campaignName ? { name: pausedDraft.spec.campaignName } : {}),
          }
        : undefined;

  await db
    .insert(agentToolCalls)
    .values({
      agentId: row.agentId,
      runId: row.runId,
      toolKey,
      idempotencyKey: `draft:${row.id}:apply`,
      risk: "high",
      args: { draftId: row.id, kind: row.kind, dryRun, ...(revertTarget ? { target: revertTarget } : {}) },
      result: { createdIds, dryRun },
      beforeState: null,
    })
    .onConflictDoNothing();

  await db.insert(auditLog).values({
    orgId: input.orgId,
    actor: ACTOR_AGENT,
    action: `meta.${toolKey}${dryRun ? ".dry_run" : ""}`,
    target: pausedDraft.sourceRef ? `${pausedDraft.sourceRef.level}:${pausedDraft.sourceRef.id}` : `account:${row.adAccountId}`,
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

  // Ativação (v1) — a saga SEMPRE criou PAUSADA (crash-safe); aqui decide o que fazer com isso:
  //  · creationActivation="active" → ATIVA a árvore JÁ (sem 2º OK): o dono optou por criar no ar
  //    (opt-in explícito: autonomia act_full E creationActivation=active, ambos default OFF/paused),
  //    e o resumo no WhatsApp (S7) é o aviso. Cria pausada→ativa no fim = mantém a segurança de crash
  //    E entrega "nasce ativa". Se a ativação NÃO vier (kill-switch/bloqueio/falha), NÃO deixa a
  //    campanha num beco pausado sem saída: cai no fallback abaixo (cria a approval de ativação).
  //  · creationActivation="paused" → cria a approval de ATIVAÇÃO (o 2º OK pra ativar depois, chat
  //    ou site). Idempotente (unique draftId+kind). Dry-run: nem ativa nem cria approval (simulado).
  let activationApprovalId: string | null = null;
  let activated = false;
  if (!dryRun) {
    if (requestedActivation === "active") {
      const act = await applyActivation(deps, { orgId: input.orgId, draftId: row.id });
      activated = act.kind === "activated" && !act.dryRun;
      if (act.kind === "failed") logger.warn({ draftId: row.id }, "apply-draft:ativação falhou — fallback p/ approval de ativação");
    }
    // "paused" desde o início, OU "active" que não ativou (fallback) → cria o 2º OK de ativação.
    if (!activated) {
      const appr = await ports.approval.upsertActivationPending({
        orgId: input.orgId as OrgId,
        agentId: row.agentId as AgentId,
        runId: row.runId as RunId | null,
        contactId: null,
        draftId: row.id as DraftId,
        expiresAt: new Date(Date.now() + ACTIVATION_APPROVAL_TTL_MS),
      });
      activationApprovalId = appr.id;
    }
  }

  logger.info({ draftId: row.id, dryRun, activationApprovalId, activated }, "apply-draft:created");
  return { kind: "created", dryRun, createdIds, activationApprovalId, activated };
}

/**
 * Auto-criação PROATIVA (C): o agente cria sozinho ("age sozinho" por-ação) — com travas.
 * (1) aplica a saga — `applyDraft` já força PAUSADO internamente nos dois ramos (P0.1), sem
 * trava externa aqui; o guardrail de gasto novo é re-checado = rede; criar-do-zero sem criativo
 * é barrado lá dentro. (2) resolve a approval de CRIAÇÃO conforme o desfecho (some do inbox).
 * (3) O desfecho da ATIVAÇÃO segue o `creationActivation` do agente (v1, resolvido no `applyDraft`):
 * "active" → nasce ATIVA (veicula) já, sem 2º OK — opt-in explícito (act_full + creationActivation
 * =active, ambos default OFF/paused); "paused" (ou "active" que barrou) → nasce PAUSADA + approval
 * de ATIVAÇÃO pendente (o dono ativa no site/chat). `failed` na CRIAÇÃO mantém a approval de criação
 * pendente (a promessa não some; humano reaprova). O nudge transparente (ativou × pausou) fica no chamador.
 */
export async function autoApplyProactiveDraft(
  deps: WorkerDeps,
  input: { readonly orgId: string; readonly draftId: string; readonly approvalId: string },
): Promise<DraftApplyOutcome> {
  const { ports, logger } = deps;
  const outcome = await applyDraft(deps, { orgId: input.orgId, draftId: input.draftId });
  const approvalId = input.approvalId as ApprovalId;
  if (outcome.kind === "created") {
    // Desfecho da ativação = creationActivation do agente (v1): "active" (opt-in) → veicula já
    // (outcome.activated); senão nasce PAUSADA com approval de ativação pendente (o dono ativa
    // no site/chat). O nudge do chamador reflete os dois casos com honestidade.
    await ports.approval.resolve(approvalId, { status: "approved" });
    if (outcome.activationApprovalId) {
      logger.info({ draftId: input.draftId }, "auto-create:criado PAUSADO — aprovação de ativação pendente");
    } else if (outcome.activated) {
      logger.info({ draftId: input.draftId }, "auto-create:criado e ATIVADO (creationActivation=active)");
    }
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
  // nome DERIVADO (default) — o usuário pode ter editado (Slice 7/8, spec.campaignName/adsetName)
  // OU vir da cópia fiel (spec.name preserva a convenção do cliente); senão cai no derivado.
  const derived = `CaquiAI — ${goalNounPt(goal)}`;
  const name = spec.campaignName ?? spec.name ?? derived;
  // CBO (cópia fiel): budget na CAMPANHA; ABO: no adset. `budgetMode` vem da leitura fiel.
  const isCbo = spec.budgetMode === "cbo";

  if (!state["campaignId"]) {
    const { campaignId } = await ads.createCampaign(ref, {
      name,
      objectiveGoal: goal,
      specialAdCategories: spec.specialAdCategories ?? DEFAULT_SPECIAL_AD_CATEGORIES,
      status,
      ...(isCbo ? { dailyBudgetMinor: spec.dailyBudgetMinor } : {}),
    });
    await persist({ campaignId });
  }
  if (!state["adsetId"]) {
    const { adsetId, targetingFallback } = await ads.createAdSet(ref, {
      campaignId: state["campaignId"] as string,
      name: spec.adsetName ?? `${name} — conjunto`,
      // ABO leva budget no adset; CBO não (está na campanha).
      ...(isCbo ? {} : { dailyBudgetMinor: spec.dailyBudgetMinor }),
      goal,
      ...(spec.pixelId ? { pixelId: spec.pixelId } : {}),
      targeting: spec.targeting ?? { kind: "advantage_plus" },
      status,
    });
    // targetingFallback: o `reuse_adset` pedido não pôde ser resolvido (fonte indisponível) e
    // caiu em Advantage+ amplo — persiste pra o push do apply avisar o dono (nunca silencioso).
    await persist({ adsetId, ...(targetingFallback ? { targetingFallback: true } : {}) });
  }

  // CÓPIA FIEL (Fatia 7): reusa os criativos da fonte por REFERÊNCIA (creative_id) — 1 anúncio
  // por ref, preservando object_story_spec/destino WhatsApp sem rebuild. Retomável por índice.
  const refs = spec.creativeRefs ?? [];
  if (refs.length > 0) {
    const copyAdIds = [...((state["adIds"] as string[] | undefined) ?? [])];
    for (let i = 0; i < refs.length; i++) {
      if (copyAdIds[i]) continue;
      const { adId } = await ads.createAd(ref, {
        adsetId: state["adsetId"] as string,
        creativeId: refs[i]!,
        name: `${name} — anúncio ${i + 1}`,
        status,
      });
      copyAdIds[i] = adId;
      await persist({ adIds: [...copyAdIds] });
    }
    return;
  }

  const variants = spec.copyVariants ?? [];
  const creativeIds = [...((state["creativeIds"] as string[] | undefined) ?? [])];
  const adIds = [...((state["adIds"] as string[] | undefined) ?? [])];
  for (let i = 0; i < variants.length; i++) {
    if (adIds[i]) continue; // variação já completa (retomada)
    const v = variants[i]!;
    // criativo POR ANÚNCIO (Fatia 7): o do próprio anúncio vence; ausente → o padrão do rascunho.
    const creative = v.creative ?? spec.creative;
    if (!creativeIds[i]) {
      const { creativeId } = await ads.createAdCreative(ref, {
        name: `${derived} — criativo ${i + 1}`,
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
      name: v.adName ?? `${derived} — anúncio ${i + 1}`,
      status,
    });
    adIds[i] = adId;
    await persist({ adIds: [...adIds] });
  }
}

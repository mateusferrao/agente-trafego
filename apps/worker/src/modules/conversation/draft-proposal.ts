// Proposta de rascunho de campanha por CHAT (Fatia 7): escalar vencedor + criar do zero.
// Persiste campaign_drafts(proposed) + approvals(pending) na hora (fonte única visível no
// site) e monta o eco determinístico. O "sim" (applyWrite) enfileira a saga (mesmo
// apply-service do site). Escala inteligente por passo (planScaleMove): raise = ação
// adjust_budget (caminho de escrita existente); duplicate/from_scratch = rascunho.

import { and, desc, eq } from "drizzle-orm";
import { adAccounts, agents, campaignDrafts, entityAnalyses, guardrailConfigs } from "@trafego/db";
import { planScaleMove, type BudgetLevel, type ScaleAggressivePreference, type ScaleChoice } from "@trafego/core";
import {
  ACTION_PARAM_MODE,
  ACTION_PARAM_PCT,
  BUDGET_MODE_INCREASE,
  DEFAULT_CONVERSION_GOAL,
  DEFAULT_CURRENCY,
  toGuardrailConfig,
  type Action,
  type AgentId,
  type CampaignDraftSpec,
  type ConversionGoal,
  type CopyVariant,
  type DraftId,
} from "@trafego/shared";
import type { AdAccountRef } from "@trafego/shared/ports";
import type { WorkerDeps } from "../../composition.js";
import { createAnalysisRepo } from "../analysis/repo.js";
import { generateCopy } from "../copy/generate-copy.js";

const MINOR_PER_UNIT = 100;
const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_VARIANTS = 2;
const DEFAULT_STARTER_BUDGET_MINOR = 3000;
const DEFAULT_COPY_MODEL = "openai/gpt-4o-mini";

export interface DraftProposalContext {
  readonly orgId: string;
  readonly agentId: string;
  readonly adAccountId: string;
  readonly currency: string;
}

export type ChatDraftProposal =
  | { readonly kind: "draft"; readonly echo: string; readonly approvalId: string; readonly draftId: string }
  | { readonly kind: "action"; readonly action: Action }
  // passo agressivo, intent aberto: o agente PERGUNTA (subir seguro vs duplicar) e re-chama
  // proposeScaleWinner com `choice`. Nada é criado ainda.
  | {
      readonly kind: "ask";
      readonly echo: string;
      readonly winnerLabel: string;
      readonly entityId: string;
      readonly entityLevel: "campaign" | "adset";
      readonly raisePct: number;
      readonly duplicatePct: number;
    }
  | { readonly kind: "blocked"; readonly reason: string };

/** on_demand (chat/site) ou proactive (proposto pelo agente no run). */
export type DraftOrigin = "on_demand" | "proactive";

interface AgentContext {
  readonly ref: AdAccountRef;
  readonly currency: string;
  readonly cfg: ReturnType<typeof toGuardrailConfig>;
  readonly model: string;
  readonly businessContext: string | null;
  readonly guidance: string | null;
  /** Preferência do passo agressivo (autonomy_policy) — default "ask". */
  readonly scaleAggressivePreference: ScaleAggressivePreference;
}

function money(reais: number, currency: string): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency }).format(reais);
}

async function loadAgentContext(deps: WorkerDeps, ctx: DraftProposalContext): Promise<AgentContext | null> {
  const repo = createAnalysisRepo(deps.db);
  const account = await repo.loadAccount(ctx.orgId, ctx.adAccountId);
  if (!account) return null;
  const [ag] = await deps.db
    .select({
      modelConfig: agents.modelConfig,
      businessContext: agents.businessContext,
      guidance: agents.guidance,
      autonomyPolicy: agents.autonomyPolicy,
    })
    .from(agents)
    .where(and(eq(agents.id, ctx.agentId), eq(agents.orgId, ctx.orgId)))
    .limit(1);
  const [g] = await deps.db
    .select()
    .from(guardrailConfigs)
    .where(and(eq(guardrailConfigs.agentId, ctx.agentId), eq(guardrailConfigs.orgId, ctx.orgId)))
    .limit(1);
  const [acc] = await deps.db
    .select({ currency: adAccounts.currency })
    .from(adAccounts)
    .where(and(eq(adAccounts.id, ctx.adAccountId), eq(adAccounts.orgId, ctx.orgId)))
    .limit(1);
  const mc = (ag?.modelConfig ?? {}) as Record<string, unknown>;
  return {
    ref: { adAccountId: account.metaAdAccountId, accessToken: deps.ports.vault.decrypt(account.tokenCripto) },
    currency: acc?.currency ?? ctx.currency ?? DEFAULT_CURRENCY,
    cfg: toGuardrailConfig(g),
    model: (mc["messageModel"] as string) ?? (mc["model"] as string) ?? DEFAULT_COPY_MODEL,
    businessContext: ag?.businessContext ?? null,
    guidance: ag?.guidance ?? null,
    scaleAggressivePreference: ag?.autonomyPolicy?.scaleAggressivePreference ?? "ask",
  };
}

async function persistDraftAndApproval(
  deps: WorkerDeps,
  ctx: DraftProposalContext,
  kind: "duplicate" | "from_scratch",
  spec: CampaignDraftSpec,
  origin: DraftOrigin,
  sourceRef?: { level: "campaign" | "adset"; id: string },
): Promise<{ draftId: string; approvalId: string }> {
  const [row] = await deps.db
    .insert(campaignDrafts)
    .values({
      orgId: ctx.orgId,
      adAccountId: ctx.adAccountId,
      agentId: ctx.agentId,
      kind,
      status: "proposed",
      origin,
      spec,
      ...(sourceRef ? { sourceRef } : {}),
    })
    .returning({ id: campaignDrafts.id });
  try {
    const appr = await deps.ports.approval.upsertDraftPending({
      orgId: ctx.orgId as never,
      agentId: ctx.agentId as AgentId,
      runId: null,
      contactId: null,
      draftId: row!.id as DraftId,
      expiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
    });
    return { draftId: row!.id, approvalId: appr.id };
  } catch (err) {
    // a aprovação é a fronteira: sem ela o rascunho é inalcançável → remove o órfão.
    await deps.db.delete(campaignDrafts).where(eq(campaignDrafts.id, row!.id));
    throw err;
  }
}

/** Escalar o melhor vencedor (curado do último run). Raise = ação; duplicate = rascunho. */
export async function proposeScaleWinner(
  deps: WorkerDeps,
  ctx: DraftProposalContext,
  winnerName?: string,
  origin: DraftOrigin = "on_demand",
  choice?: ScaleChoice,
): Promise<ChatDraftProposal> {
  const ac = await loadAgentContext(deps, ctx);
  if (!ac) return { kind: "blocked", reason: "não consegui acessar a conta agora" };

  const winners = await deps.db
    .select({ entityId: entityAnalyses.entityId, entityLevel: entityAnalyses.entityLevel, entityName: entityAnalyses.entityName })
    .from(entityAnalyses)
    .where(and(eq(entityAnalyses.agentId, ctx.agentId), eq(entityAnalyses.tier, "winner")))
    .orderBy(desc(entityAnalyses.analyzedAt))
    .limit(10);
  if (winners.length === 0) {
    return { kind: "blocked", reason: "não achei um vencedor claro na última análise — roda a análise primeiro" };
  }
  const chosen =
    (winnerName ? winners.find((w) => (w.entityName ?? "").toLowerCase().includes(winnerName.toLowerCase())) : undefined) ??
    winners[0]!;

  const state = await deps.ports.ads.readEntityState(ac.ref, chosen.entityId);
  const sourceDailyMinor = Number(state["daily_budget"] ?? 0);
  const level = chosen.entityLevel === "campaign" ? "campaign" : "adset";
  const budgetLevel: BudgetLevel = level === "adset" && sourceDailyMinor > 0 ? "adset" : "campaign";
  const scalePct = ac.cfg.scalePct ?? 50;
  const move = planScaleMove({
    scalePct,
    maxBudgetChangePct: ac.cfg.maxBudgetChangePct,
    budgetLevel,
    preference: ac.scaleAggressivePreference,
    ...(choice ? { choice } : {}),
  });
  const label = chosen.entityName ?? chosen.entityId;

  // passo agressivo, intent aberto, sem resposta → PERGUNTA em linguagem plana (§UX: sem jargão).
  if (move.move === "ask") {
    const echo = [
      `O aumento que você pediu é grande pro "${label}".`,
      `Posso **subir o orçamento** dele em até ${move.raisePct}% (o limite seguro, que não reinicia o desempenho que ele já tem),`,
      `ou **criar uma cópia separada** pra crescer mais que isso sem arriscar a que já está funcionando.`,
      `O que você prefere?`,
    ].join(" ");
    return {
      kind: "ask",
      echo,
      winnerLabel: label,
      entityId: chosen.entityId,
      entityLevel: level,
      raisePct: move.raisePct,
      duplicatePct: move.duplicatePct,
    };
  }

  if (move.move === "raise_budget") {
    const action: Action = {
      id: `scale:${chosen.entityId}`,
      type: "adjust_budget",
      // target = a entidade REAL (nível dela + id dela). budgetLevel só decidiu raise-vs-ask;
      // usar budgetLevel no target casaria nível "campaign" com id de adset (CBO) — mismatch.
      target: { level, id: chosen.entityId, name: label },
      params: { [ACTION_PARAM_MODE]: BUDGET_MODE_INCREASE, [ACTION_PARAM_PCT]: move.pct },
      source: "llm",
      riskLevel: "medium",
      reason: `escalar o vencedor "${label}": +${move.pct}% de budget`,
    };
    return { kind: "action", action };
  }

  // clampa JÁ no propose ao teto de gasto novo → o eco mostra o valor REAL (o guardrail
  // do apply é rede redundante, não uma surpresa que corta o que o usuário confirmou). §8.
  const requested = Math.round(sourceDailyMinor * (1 + move.scalePct / 100));
  const cap = ac.cfg.maxNewDailyBudgetMinor;
  const newDailyMinor = cap != null ? Math.min(requested, cap) : requested;
  const spec: CampaignDraftSpec = {
    version: 1,
    currency: ac.currency,
    dailyBudgetMinor: newDailyMinor,
    activation: "active",
  };
  const { draftId, approvalId } = await persistDraftAndApproval(deps, ctx, "duplicate", spec, origin, {
    level,
    id: chosen.entityId,
  });
  const echo = [
    `Vou **duplicar o vencedor "${label}"** com mais budget pra escalar sem estourar o aprendizado do original.`,
    `Gasto novo: ${money(newDailyMinor / MINOR_PER_UNIT, ac.currency)}/dia · entra ativa (a Meta revisa antes de veicular).`,
    `Confirma? (o original fica intocado)`,
  ].join("\n");
  return { kind: "draft", echo, approvalId, draftId };
}

/** Eco genérico de um rascunho (após refino) — o quê/quanto/ativação/copy. */
function buildRefineEcho(kind: string, spec: CampaignDraftSpec): string {
  const head = kind === "duplicate" ? "Rascunho de escala atualizado" : "Rascunho de campanha atualizado";
  const lines = [
    `${head}: gasto novo ${money(spec.dailyBudgetMinor / MINOR_PER_UNIT, spec.currency)}/dia · entra ${spec.activation === "active" ? "ativa" : "pausada"}.`,
  ];
  if (spec.copyVariants && spec.copyVariants.length > 0) {
    lines.push(`${spec.copyVariants.length} variação(ões) de copy. Ex: "${spec.copyVariants[0]!.headline}".`);
  }
  lines.push("Confirma agora ou quer ajustar mais?");
  return lines.join("\n");
}

export interface RefineDraftPatch {
  readonly budgetReais?: number;
  readonly activation?: "active" | "paused";
  readonly variantsCount?: number;
  readonly regenerateCopy?: boolean;
}

export type RefineResult = { readonly kind: "ok"; readonly echo: string } | { readonly kind: "blocked"; readonly reason: string };

/**
 * Refinamento CONVERSACIONAL do rascunho pendente (Fatia 7): muta o campaign_drafts (spec)
 * sem criar rascunho novo — budget/ativação/variações/regenerar copy — e re-ecoa. O
 * "sim" segue aplicando o MESMO rascunho (mesma approval). Só mexe em rascunho `proposed`.
 */
export async function refineDraft(
  deps: WorkerDeps,
  ctx: DraftProposalContext,
  draftId: string,
  patch: RefineDraftPatch,
): Promise<RefineResult> {
  const [row] = await deps.db
    .select({ kind: campaignDrafts.kind, spec: campaignDrafts.spec, status: campaignDrafts.status })
    .from(campaignDrafts)
    .where(and(eq(campaignDrafts.id, draftId), eq(campaignDrafts.orgId, ctx.orgId)))
    .limit(1);
  if (!row || row.status !== "proposed") return { kind: "blocked", reason: "esse rascunho não está mais aberto pra ajuste" };

  const ac = await loadAgentContext(deps, ctx);
  if (!ac) return { kind: "blocked", reason: "não consegui acessar a conta agora" };
  const spec = row.spec as CampaignDraftSpec;

  const cap = ac.cfg.maxNewDailyBudgetMinor;
  const requestedBudget = patch.budgetReais != null ? Math.round(patch.budgetReais * MINOR_PER_UNIT) : spec.dailyBudgetMinor;
  const dailyBudgetMinor = cap != null ? Math.min(requestedBudget, cap) : requestedBudget;
  const activation = patch.activation ?? spec.activation;
  const variantsCount = patch.variantsCount ?? spec.variantsCount ?? DEFAULT_VARIANTS;

  let copyVariants = spec.copyVariants;
  const needCopy = row.kind === "from_scratch" && (patch.regenerateCopy === true || (patch.variantsCount != null && patch.variantsCount !== (spec.variantsCount ?? 0)));
  if (needCopy) {
    copyVariants = await generateCopy(
      deps.ports.llm,
      { model: ac.model, goal: spec.objective ?? DEFAULT_CONVERSION_GOAL, variantsCount, businessContext: ac.businessContext, guidance: ac.guidance },
      { orgId: ctx.orgId, adAccountId: ctx.adAccountId },
    );
  }

  const nextSpec: CampaignDraftSpec = {
    ...spec,
    dailyBudgetMinor,
    activation,
    ...(row.kind === "from_scratch" ? { variantsCount, ...(copyVariants ? { copyVariants } : {}) } : {}),
  };
  await deps.db.update(campaignDrafts).set({ spec: nextSpec }).where(eq(campaignDrafts.id, draftId));
  return { kind: "ok", echo: buildRefineEcho(row.kind, nextSpec) };
}

/** Criar do zero reusando o criativo/página/pixel da conta + copy gerada. */
export async function proposeCreateCampaign(
  deps: WorkerDeps,
  ctx: DraftProposalContext,
  args: { readonly goal?: ConversionGoal; readonly budgetReais?: number },
  origin: DraftOrigin = "on_demand",
): Promise<ChatDraftProposal> {
  const ac = await loadAgentContext(deps, ctx);
  if (!ac) return { kind: "blocked", reason: "não consegui acessar a conta agora" };

  const defaults = await deps.ports.ads.inferCreationDefaults(ac.ref);
  if (!defaults.pageId || !defaults.imageHash) {
    return {
      kind: "blocked",
      reason:
        "essa conta ainda não tem um anúncio de onde eu possa reusar a página e o criativo — me manda um criativo ou conecte uma conta com anúncios",
    };
  }
  const goal = args.goal ?? defaults.objectiveGoal ?? DEFAULT_CONVERSION_GOAL;
  const requested = args.budgetReais
    ? Math.round(args.budgetReais * MINOR_PER_UNIT)
    : (ac.cfg.maxNewDailyBudgetMinor ?? DEFAULT_STARTER_BUDGET_MINOR);
  const cap = ac.cfg.maxNewDailyBudgetMinor;
  const dailyBudgetMinor = cap != null ? Math.min(requested, cap) : requested;
  const variantsCount = DEFAULT_VARIANTS;

  const copyVariants: CopyVariant[] = await generateCopy(
    deps.ports.llm,
    {
      model: ac.model,
      goal,
      variantsCount,
      businessContext: ac.businessContext,
      guidance: ac.guidance,
    },
    { orgId: ctx.orgId, adAccountId: ctx.adAccountId },
  );

  const spec: CampaignDraftSpec = {
    version: 1,
    currency: ac.currency,
    dailyBudgetMinor,
    activation: "active",
    objective: goal,
    targeting: { kind: "advantage_plus" },
    variantsCount,
    copyVariants,
    creative: { assetId: defaults.sourceAdId ?? "reuse", format: "image", origin: "reuse", metaImageHash: defaults.imageHash },
    pageId: defaults.pageId,
    ...(defaults.pixelId ? { pixelId: defaults.pixelId } : {}),
    ...(defaults.linkUrl ? { linkUrl: defaults.linkUrl } : {}),
  };
  const { draftId, approvalId } = await persistDraftAndApproval(deps, ctx, "from_scratch", spec, origin);
  const echo = [
    `Vou **criar uma campanha de ${goal}** reusando seu criativo campeão e ${variantsCount} variações de copy novas.`,
    `Gasto novo: ${money(dailyBudgetMinor / MINOR_PER_UNIT, ac.currency)}/dia · Página: ${defaults.pageId}${defaults.pixelId ? ` · Pixel: ${defaults.pixelId}` : ""} · entra ativa (a Meta revisa antes).`,
    `Confirma? (você pode editar/trocar o criativo no site antes de aprovar)`,
  ].join("\n");
  return { kind: "draft", echo, approvalId, draftId };
}

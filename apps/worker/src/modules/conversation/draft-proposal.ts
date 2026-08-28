// Proposta de rascunho de campanha por CHAT (Fatia 7): escalar vencedor + criar do zero.
// Persiste campaign_drafts(proposed) + approvals(pending) na hora (fonte única visível no
// site) e monta o eco determinístico. O "sim" (applyWrite) enfileira a saga (mesmo
// apply-service do site). Escala inteligente por passo (planScaleMove): raise = ação
// adjust_budget (caminho de escrita existente); duplicate/from_scratch = rascunho.

import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { adAccounts, agents, campaignDrafts, creativeAssets, creativeVisionAnalyses, entityAnalyses, guardrailConfigs } from "@trafego/db";
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
  type CreativeAssetRef,
  type DraftId,
  type TargetingSpec,
} from "@trafego/shared";
import type { AdAccountRef } from "@trafego/shared/ports";
import type { WorkerDeps } from "../../composition.js";
import { createAnalysisRepo } from "../analysis/repo.js";
import { loadEnabledTools } from "../tools/enabled.js";
import { generateCopy } from "../copy/generate-copy.js";
import { creativeContentHash } from "../vision/resolver.js";
import { pickLibraryCreativeByContext, type LibraryCandidate, type MatchContext } from "../creative/match-library.js";
import { joinBalloons } from "../notify/split.js";

const MINOR_PER_UNIT = 100;
const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_VARIANTS = 2;
const DEFAULT_STARTER_BUDGET_MINOR = 3000;
/** Quantos uploads recentes considerar no pick da biblioteca (ranqueados por score da visão). */
const LIBRARY_PICK_CANDIDATES = 20;

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
  /** Tool-keys habilitadas (bindings, mesma fonte do chat/apply) — gate da escala. */
  readonly enabled: ReadonlySet<string>;
}

function money(reais: number, currency: string): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency }).format(reais);
}

/** Frase honesta sobre o que acontece ao confirmar (P0.1): a criação SEMPRE nasce pausada —
 *  só entra no ar depois de um 2º OK separado (approval de ativação). Sem isso o eco+confirma
 *  (§8) mentiria sobre o que vai acontecer ANTES do usuário dizer sim. */
function activationPhrase(activation: "active" | "paused"): string {
  return activation === "active"
    ? "nasce PAUSADA (a Meta revisa antes) — te aviso separado pra confirmar a ativação"
    : "fica pausada, do jeito que você pediu";
}

/**
 * Targeting da campanha criada do zero: com um adset vencedor real, HERDA o público já
 * provado dele (`reuse_adset`) — inclusive travas de geo/audience que o dono já tenha
 * configurado manualmente ali. Só cai em `advantage_plus` (amplo, sem trava) no cold-start,
 * quando não há nenhum adset vencedor pra herdar. PURA — sem isso, criar do zero sempre
 * ignoraria as travas de público da conta (ver guidance §7 do agente).
 */
export function resolveCreationTargeting(defaults: { readonly sourceAdsetId?: string }): TargetingSpec {
  return defaults.sourceAdsetId ? { kind: "reuse_adset", sourceAdsetId: defaults.sourceAdsetId } : { kind: "advantage_plus" };
}

/** Rótulo PT do formato não-reusável (o vocabulário neutro vem do adapter). */
function unsupportedFormatPt(f: "carousel" | "catalog" | "other"): string {
  return f === "carousel" ? "carrossel" : f === "catalog" ? "anúncio de catálogo" : "formato que ainda não sei clonar";
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
  const enabled = await loadEnabledTools(deps.db, ctx.orgId, ctx.agentId);
  return {
    ref: { adAccountId: account.metaAdAccountId, accessToken: deps.ports.vault.decrypt(account.tokenCripto) },
    currency: acc?.currency ?? ctx.currency ?? DEFAULT_CURRENCY,
    cfg: toGuardrailConfig(g),
    model: (mc["messageModel"] as string) ?? (mc["model"] as string) ?? deps.conversation.copyModel,
    businessContext: ag?.businessContext ?? null,
    guidance: ag?.guidance ?? null,
    scaleAggressivePreference: ag?.autonomyPolicy?.scaleAggressivePreference ?? "ask",
    enabled,
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

  // Gate por binding (mesma fonte/lógica do site scaleWinner): escalar precisa de ao menos uma
  // capacidade — subir budget (adjust_budget) OU duplicar (duplicate_scale). Sem alinhar isto,
  // o chat exporia scale_winner e proporia duplicar mesmo com duplicate_scale off → passaria no
  // gate do chat e barraria no apply (divergência dos gates).
  const canRaise = ac.enabled.has("adjust_budget");
  const canDuplicate = ac.enabled.has("duplicate_scale");
  if (!canRaise && !canDuplicate) {
    return { kind: "blocked", reason: "escalar está desligado para este agente (ligue duplicar ou ajustar orçamento nas ações permitidas)" };
  }

  const state = await deps.ports.ads.readEntityState(ac.ref, chosen.entityId);
  const sourceDailyMinor = Number(state["daily_budget"] ?? 0);
  const sourceLifetimeMinor = Number(state["lifetime_budget"] ?? 0);
  const level = chosen.entityLevel === "campaign" ? "campaign" : "adset";
  const label = chosen.entityName ?? chosen.entityId;
  const scalePct = ac.cfg.scalePct ?? 50;

  // Vencedor ADSET sem orçamento DIÁRIO próprio. Dois casos: (a) o adset tem orçamento VITALÍCIO
  // (ABO lifetime) → sobe o vitalício do PRÓPRIO conjunto; (b) sem nenhum budget no adset → é CBO
  // (orçamento na CAMPANHA) → sobe o da campanha-mãe (diário ou vitalício). O adapter escreve
  // daily/lifetime conforme o que a entidade usa; o eco deixa CLARO qual budget e por quê.
  if (level === "adset" && sourceDailyMinor <= 0) {
    if (!canRaise) {
      return { kind: "blocked", reason: "escalar esse vencedor exige subir o orçamento — ligue 'ajustar orçamento' nas ações permitidas, ou ajuste no gerenciador." };
    }
    const pct = Math.min(scalePct, ac.cfg.maxBudgetChangePct);
    const raise = (targetLevel: "adset" | "campaign", targetId: string, reason: string): ChatDraftProposal => ({
      kind: "action",
      action: {
        id: `scale:${targetId}`,
        type: "adjust_budget",
        target: { level: targetLevel, id: targetId, name: label },
        params: { [ACTION_PARAM_MODE]: BUDGET_MODE_INCREASE, [ACTION_PARAM_PCT]: pct },
        source: "llm",
        riskLevel: "medium",
        reason,
      },
    });
    // (a) adset com orçamento VITALÍCIO próprio → sobe o vitalício do conjunto.
    if (sourceLifetimeMinor > 0) {
      return raise("adset", chosen.entityId, `seu vencedor "${label}" usa orçamento vitalício no conjunto, então subo +${pct}% no orçamento vitalício dele`);
    }
    // (b) sem orçamento no adset → CBO: sobe o da CAMPANHA-mãe (diário ou vitalício).
    const parent = await deps.ports.ads.getAdSetCampaignBudget(ac.ref, chosen.entityId);
    if (!parent || (parent.dailyBudgetMinor <= 0 && parent.lifetimeBudgetMinor <= 0)) {
      return { kind: "blocked", reason: "essa campanha não tem um orçamento que eu consiga escalar por aqui — ajuste o orçamento no gerenciador." };
    }
    const isLifetime = parent.dailyBudgetMinor <= 0;
    const kindTxt = isLifetime ? "vitalício" : "diário";
    return raise(
      "campaign",
      parent.campaignId,
      `seu vencedor "${label}" está sob orçamento de campanha (CBO), então subo +${pct}% no orçamento ${kindTxt} da CAMPANHA (o conjunto não tem orçamento próprio pra mexer)`,
    );
  }

  const budgetLevel: BudgetLevel = level === "adset" && sourceDailyMinor > 0 ? "adset" : "campaign";
  let move = planScaleMove({
    scalePct,
    maxBudgetChangePct: ac.cfg.maxBudgetChangePct,
    budgetLevel,
    preference: ac.scaleAggressivePreference,
    ...(choice ? { choice } : {}),
  });

  // só oferece/decide o que está habilitado: capacidade off → força o ramo disponível (sem
  // "ask" morto nem proposta que o apply barraria).
  if (move.move === "ask" && !(canRaise && canDuplicate)) {
    move = canRaise
      ? { move: "raise_budget", pct: move.raisePct, level: budgetLevel }
      : { move: "duplicate", scalePct: move.duplicatePct };
  }
  if (move.move === "raise_budget" && !canRaise) {
    return { kind: "blocked", reason: "subir orçamento está desligado — posso duplicar o vencedor, se quiser" };
  }
  if (move.move === "duplicate" && !canDuplicate) {
    return { kind: "blocked", reason: "duplicar está desligado — posso subir o orçamento no limite, se quiser" };
  }

  // passo agressivo, intent aberto, sem resposta → PERGUNTA em linguagem plana (§UX: sem jargão).
  if (move.move === "ask") {
    const echo = joinBalloons([
      `O aumento que você pediu é grande pro "${label}".`,
      `Posso **subir o orçamento** dele em até ${move.raisePct}% (o limite seguro, que não reinicia o desempenho que ele já tem),`,
      `ou **criar uma cópia separada** pra crescer mais que isso sem arriscar a que já está funcionando.`,
      `O que você prefere?`,
    ]);
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
  const echo = joinBalloons([
    `Vou **duplicar o vencedor "${label}"** com mais budget pra escalar sem estourar o aprendizado do original.`,
    `Gasto novo: ${money(newDailyMinor / MINOR_PER_UNIT, ac.currency)}/dia · ${activationPhrase("active")}.`,
    `Confirma? (o original fica intocado)`,
  ]);
  return { kind: "draft", echo, approvalId, draftId };
}

/** Eco genérico de um rascunho (após refino) — o quê/quanto/ativação/copy. */
function buildRefineEcho(kind: string, spec: CampaignDraftSpec): string {
  const head = kind === "duplicate" ? "Rascunho de escala atualizado" : "Rascunho de campanha atualizado";
  const lines = [
    `${head}: gasto novo ${money(spec.dailyBudgetMinor / MINOR_PER_UNIT, spec.currency)}/dia · ${activationPhrase(spec.activation)}.`,
  ];
  if (spec.copyVariants && spec.copyVariants.length > 0) {
    lines.push(`${spec.copyVariants.length} variação(ões) de copy. Ex: "${spec.copyVariants[0]!.headline}".`);
  }
  lines.push("Confirma agora ou quer ajustar mais?");
  return joinBalloons(lines);
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
    // re-aterra a regeneração na copy que já performa (mesma fonte da proposta inicial).
    const defaults = await deps.ports.ads.inferCreationDefaults(ac.ref);
    copyVariants = await generateCopy(
      deps.ports.llm,
      {
        model: ac.model,
        goal: spec.objective ?? DEFAULT_CONVERSION_GOAL,
        variantsCount,
        businessContext: ac.businessContext,
        guidance: ac.guidance,
        ...(defaults.winnerCopy ? { winnerCopy: defaults.winnerCopy } : {}),
      },
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

/** Criativo escolhido pro rascunho + de onde veio (pro eco honesto). `source`: `serving` =
 *  melhor anúncio veiculando (provado); `library` = upload da biblioteca (fallback quando não
 *  há criativo veiculando). */
interface ChosenCreative {
  readonly imageHash?: string;
  readonly videoId?: string;
  readonly assetId: string;
  readonly origin: CreativeAssetRef["origin"];
  readonly source: "serving" | "library";
}

/**
 * Pool ÚNICO de candidatos a criativo (decisão do dono): anúncios VEICULANDO + biblioteca.
 * Rank: o melhor VEICULANDO (provado por desempenho, via `inferCreationDefaults`) vence; sem
 * criativo veiculando, cai no upload mais recente da biblioteca (`ready`, não-arquivado). Assim
 * um criativo que você subiu mas nunca veiculou também é candidato (antes era ignorado). O
 * picker manual segue podendo forçar qualquer asset. `null` = nenhum criativo em lugar nenhum.
 */
export async function chooseCreative(
  deps: WorkerDeps,
  orgId: string,
  accountId: string,
  serving: { imageHash?: string; videoId?: string; sourceAdId?: string },
  match?: MatchContext & { readonly model: string },
): Promise<ChosenCreative | null> {
  if (serving.imageHash || serving.videoId) {
    return {
      ...(serving.imageHash ? { imageHash: serving.imageHash } : {}),
      ...(serving.videoId ? { videoId: serving.videoId } : {}),
      assetId: serving.sourceAdId ?? "reuse",
      origin: "reuse",
      source: "serving",
    };
  }
  // Sem criativo veiculando → BIBLIOTECA. A escolha considera o CONTEXTO da campanha (objetivo +
  // negócio + orientações) casado com a DESCRIÇÃO cacheada de cada upload (visão feita no upload) —
  // via um matcher LLM barato (texto, sem re-analisar). NÃO é ranking genérico/aleatório. Sem
  // descrições cacheadas ou sem contexto → recência (a lista já vem por createdAt desc).
  const libs = await deps.db
    .select({ id: creativeAssets.id, imageHash: creativeAssets.metaImageHash, videoId: creativeAssets.metaVideoId })
    .from(creativeAssets)
    .where(
      and(
        eq(creativeAssets.orgId, orgId),
        eq(creativeAssets.adAccountId, accountId),
        eq(creativeAssets.status, "ready"),
        isNull(creativeAssets.archivedAt),
      ),
    )
    .orderBy(desc(creativeAssets.createdAt))
    .limit(LIBRARY_PICK_CANDIDATES);
  const withMedia = libs.filter((l) => l.imageHash || l.videoId);
  if (withMedia.length === 0) return null;

  let chosenId = withMedia[0]!.id; // default: recência (mais recente)
  if (match) {
    // descrições cacheadas por asset (contentHash estável = creativeContentHash(assetId)).
    const hashOf = new Map(withMedia.map((l) => [l.id, creativeContentHash(l.id, undefined)]));
    const visions = await deps.db
      .select({ hash: creativeVisionAnalyses.contentHash, result: creativeVisionAnalyses.result })
      .from(creativeVisionAnalyses)
      .where(
        and(
          inArray(creativeVisionAnalyses.contentHash, [...hashOf.values()]),
          eq(creativeVisionAnalyses.analyzerVersion, deps.visionAnalyzerVersion),
        ),
      );
    const descByHash = new Map(visions.map((v) => [v.hash, describeVision(v.result)]));
    const candidates: LibraryCandidate[] = withMedia
      .map((l) => ({ assetId: l.id, description: descByHash.get(hashOf.get(l.id)!) ?? "" }))
      .filter((c) => c.description.length > 0);
    if (candidates.length > 0) {
      // ordena os candidatos por recência (já vêm assim) → o fallback do matcher = mais recente.
      const picked = await pickLibraryCreativeByContext(deps.ports.llm, match.model, match, candidates);
      if (picked) chosenId = picked;
    }
  }

  const best = withMedia.find((l) => l.id === chosenId) ?? withMedia[0]!;
  return {
    ...(best.imageHash ? { imageHash: best.imageHash } : {}),
    ...(best.videoId ? { videoId: best.videoId } : {}),
    assetId: best.id,
    origin: "upload",
    source: "library",
  };
}

/** Descrição compacta da visão cacheada p/ o matcher de contexto (o que o criativo comunica). */
function describeVision(result: unknown): string {
  const r = (result ?? {}) as { summary?: string; hook?: string; angle?: string; format?: string };
  return [
    r.summary,
    r.hook ? `Gancho: ${r.hook}` : "",
    r.angle ? `Ângulo: ${r.angle}` : "",
    r.format ? `Formato: ${r.format}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
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

  // Gate por binding (mesma fonte/lógica do chat/apply/scale): criar do zero precisa de
  // `create_campaign` ligado. O chat já filtra pelo toolset, mas o caminho PROATIVO chama
  // isto direto — sem este gate, proporia um rascunho de uma capacidade desligada (some no
  // apply, mas já teria mostrado a proposta + approval + recomendação). Alinha com o scale.
  if (!ac.enabled.has("create_campaign")) {
    return { kind: "blocked", reason: "criar campanha está desligado para este agente (ligue em ações permitidas)" };
  }

  const defaults = await deps.ports.ads.inferCreationDefaults(ac.ref);
  const goal = args.goal ?? defaults.objectiveGoal ?? DEFAULT_CONVERSION_GOAL;
  // Pool único: melhor veiculando (provado) OU, sem nenhum, o upload da biblioteca que MELHOR
  // CASA com o contexto da campanha (objetivo + negócio + orientações) via matcher LLM barato.
  const chosen = await chooseCreative(
    deps,
    ctx.orgId,
    ctx.adAccountId,
    {
      ...(defaults.imageHash ? { imageHash: defaults.imageHash } : {}),
      ...(defaults.videoId ? { videoId: defaults.videoId } : {}),
      ...(defaults.sourceAdId ? { sourceAdId: defaults.sourceAdId } : {}),
    },
    { goal, businessContext: ac.businessContext, guidance: ac.guidance, model: ac.model },
  );
  const reuseImageHash = chosen?.imageHash;
  const reuseVideoId = chosen?.videoId;
  // Página é obrigatória (object_story_spec). Vem do anúncio veiculando; conta sem NENHUM
  // anúncio não tem página inferível — nesse caso nem um upload da biblioteca cria (falta a Page).
  if (!defaults.pageId || !chosen) {
    return {
      kind: "blocked",
      reason: defaults.unsupportedTopFormat
        ? `seu melhor anúncio é um ${unsupportedFormatPt(defaults.unsupportedTopFormat)}, que eu ainda não sei clonar, e não achei um criativo de imagem/vídeo pra reusar — me manda uma imagem ou vídeo pra eu criar a campanha.`
        : "essa conta ainda não tem um anúncio de onde eu possa reusar a página e o criativo — me manda um criativo ou conecte uma conta com anúncios",
    };
  }
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
      // aterramento no que já performa (§7): a copy dos melhores anúncios veiculando.
      ...(defaults.winnerCopy ? { winnerCopy: defaults.winnerCopy } : {}),
    },
    { orgId: ctx.orgId, adAccountId: ctx.adAccountId },
  );

  const isVideo = !reuseImageHash && Boolean(reuseVideoId);
  const spec: CampaignDraftSpec = {
    version: 1,
    currency: ac.currency,
    dailyBudgetMinor,
    activation: "active",
    objective: goal,
    targeting: resolveCreationTargeting(defaults),
    variantsCount,
    copyVariants,
    creative: {
      assetId: chosen.assetId,
      format: isVideo ? "video" : "image",
      origin: chosen.origin,
      ...(reuseImageHash ? { metaImageHash: reuseImageHash } : {}),
      ...(reuseVideoId ? { metaVideoId: reuseVideoId } : {}),
    },
    pageId: defaults.pageId,
    ...(defaults.pixelId ? { pixelId: defaults.pixelId } : {}),
    ...(defaults.linkUrl ? { linkUrl: defaults.linkUrl } : {}),
  };
  const { draftId, approvalId } = await persistDraftAndApproval(deps, ctx, "from_scratch", spec, origin);
  // eco honesto sobre a FONTE do criativo (veiculando/provado × biblioteca) e do PÚBLICO
  // (herdado de um adset provado × amplo/Advantage+ no cold-start).
  const creativeSourcePhrase =
    chosen.source === "serving"
      ? "reusando o criativo que melhor performa na sua conta"
      : "reusando um criativo da sua biblioteca (você não tem anúncio ativo pra eu comparar desempenho)";
  const audienceSourcePhrase = spec.targeting?.kind === "reuse_adset" ? " e o público que já converte" : "";
  // Transparência (§clareza pro dono): se o #1 por desempenho for um formato que ainda não sei
  // clonar (carrossel/catálogo), avisa que peguei o melhor de imagem/vídeo no lugar.
  const lines = [
    `Vou **criar uma campanha de ${goal}** ${creativeSourcePhrase}${audienceSourcePhrase} e ${variantsCount} variações de copy novas (baseadas no que já converte).`,
  ];
  if (defaults.unsupportedTopFormat) {
    lines.push(`Obs: seu anúncio de melhor desempenho é um **${unsupportedFormatPt(defaults.unsupportedTopFormat)}**, que eu ainda não sei clonar — então usei o melhor criativo de imagem/vídeo que você tem.`);
  }
  lines.push(
    `Gasto novo: ${money(dailyBudgetMinor / MINOR_PER_UNIT, ac.currency)}/dia · Página: ${defaults.pageId}${defaults.pixelId ? ` · Pixel: ${defaults.pixelId}` : ""} · ${activationPhrase("active")}.`,
    `Confirma? (você pode trocar o criativo no site antes de aprovar)`,
  );
  return { kind: "draft", echo: joinBalloons(lines), approvalId, draftId };
}

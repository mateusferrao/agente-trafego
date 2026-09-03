// Proposta de rascunho de campanha por CHAT (Fatia 7): escalar vencedor + criar do zero.
// Persiste campaign_drafts(proposed) + approvals(pending) na hora (fonte única visível no
// site) e monta o eco determinístico. O "sim" (applyWrite) enfileira a saga (mesmo
// apply-service do site). Escala inteligente por passo (planScaleMove): raise = ação
// adjust_budget (caminho de escrita existente); duplicate/from_scratch = rascunho.

import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { adAccounts, adCreatives, agents, campaignDrafts, creativeAssets, creativeVisionAnalyses, customAudiences, entityAnalyses, guardrailConfigs } from "@trafego/db";
import { applyDraftEdit, buildResolvedSnapshot, clampRadius, describeDeliveryEstimate, goalNounPt, planScaleMove, resolveCreativeSourceStrategy, resolveExpansion, resolveNamedMatch, suggestConverterExclusions, type BudgetLevel, type DraftEdit, type RefineError, type ScaleAggressivePreference, type ScaleChoice } from "@trafego/core";
import { applyExplicitBehaviorEdit, applyExplicitGeoEdit, applyExplicitInterestEdit, loadDraftForEdit, persistDraftSpec, resolveAudienceTargeting } from "@trafego/campaign-drafts";
import {
  ACTION_PARAM_CURRENT_MINOR,
  ACTION_PARAM_MODE,
  ACTION_PARAM_PCT,
  BUDGET_MODE_INCREASE,
  DEFAULT_CONVERSION_GOAL,
  DEFAULT_CURRENCY,
  DEFAULT_VARIANTS,
  MAX_ADS_PER_DRAFT,
  resolveCreationActivation,
  toGuardrailConfig,
  type Action,
  type AgentId,
  type CreationActivation,
  type AudienceProfile,
  type CampaignDraftSpec,
  type ConversionGoal,
  type CopyVariant,
  type CreativeAssetRef,
  type CustomAudience,
  type CreativeSourceStrategy,
  type DraftId,
  type ResolvedAudienceSnapshot,
  type TargetingSpec,
  withTimeout,
} from "@trafego/shared";
import type { AdAccountRef, DraftApproval } from "@trafego/shared/ports";
import type { DraftKind } from "@trafego/shared";
import type { WorkerDeps } from "../../composition.js";
import { createAnalysisRepo } from "../analysis/repo.js";
import { loadEnabledTools } from "../tools/enabled.js";
import { generateCopy } from "../copy/generate-copy.js";
import { createVisionResolver, creativeContentHash, servingVisionKey } from "../vision/resolver.js";
import { pickLibraryCreativeByContext, type MatchContext } from "../creative/match-library.js";
import { joinBalloons } from "../notify/split.js";
import { assembleExplicitTargeting, hasExplicitContent, type ExplicitTargetingParts } from "./explicit-targeting.js";

const MINOR_PER_UNIT = 100;
const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_STARTER_BUDGET_MINOR = 3000;
/** Máx. de anúncios com criativos DISTINTOS que o agente monta sozinho ao criar (1 por criativo).
 *  Só usa mais de 1 quando há criativos distintos disponíveis na estratégia; senão cai no padrão. */
const AGENT_MAX_CREATIVE_ADS = 3;
/** Quantos uploads recentes considerar no pick da biblioteca (ranqueados por score da visão). */
const LIBRARY_PICK_CANDIDATES = 20;
/** Quantos anúncios veiculando (mais recentes) descrever por visão no pick por-contexto (Slice 10).
 *  Teto do custo: só os SEM cache computam visão fresca (vídeo = 1 fetch de frames cada). */
const SERVING_PICK_CANDIDATES = 10;

/**
 * Clampa o gasto novo (diário) ao teto do agente e sinaliza se cortou — fonte única do
 * `dailyBudgetMinor`/`clampedByCap` p/ criar E escalar (§13 reuso-primeiro). O eco/card usam
 * `clampedByCap` p/ a transparência "você pediu X, virou Y" (§8); o guardrail do apply é a
 * rede redundante, não uma surpresa que corta o que o usuário confirmou.
 */
export function clampNewBudget(
  requestedMinor: number,
  capMinor: number | null | undefined,
): { readonly dailyBudgetMinor: number; readonly clampedByCap: boolean } {
  const dailyBudgetMinor = capMinor != null ? Math.min(requestedMinor, capMinor) : requestedMinor;
  return { dailyBudgetMinor, clampedByCap: dailyBudgetMinor < requestedMinor };
}

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
  /** estratégia de fonte do criativo na criação (Slice 10) — default serving.best_performing. */
  readonly creativeSource: CreativeSourceStrategy;
  /** Preferência do passo agressivo (autonomy_policy) — default "ask". */
  readonly scaleAggressivePreference: ScaleAggressivePreference;
  /** Ativação da criação (autonomy_policy, v1) — "paused" (default) × "active". */
  readonly creationActivation: CreationActivation;
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
    ? "nasce ATIVA (vai ao ar assim que a Meta revisar) — te aviso aqui quando subir"
    : "nasce PAUSADA — te aviso pra você revisar e ativar quando quiser";
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

/**
 * Frase de "Público: ..." do eco — PURA, deriva do `targetingKind` real. Bug fixado (P0): antes o
 * `else` assumia "amplo (Advantage+)" mesmo quando o targeting era `reuse_adset`/`explicit`. Pós-colapso
 * (Slice 1) o público salvo é descrito pelo próprio `explicit` (`describeExplicitAudience` já anexa
 * "+ público salvo indicado") — não há mais branch `hasAudience` separado.
 */
export function audienceEchoPhrase(args: {
  readonly targetingKind: TargetingSpec["kind"] | undefined;
  /** descrição real (cidades/idade/expansão) do público herdado — quando disponível (subfatia 2),
   *  substitui o genérico "herdado do conjunto que já converte" pelo público de verdade. */
  readonly resolvedAudienceDescription?: string;
  /** descrição do público EXPLÍCITO (Fase 1, subfatia 3a) — geo/idade/gênero indicados pelo dono. */
  readonly explicitAudienceDescription?: string;
}): string {
  if (args.targetingKind === "explicit" && args.explicitAudienceDescription) return args.explicitAudienceDescription;
  if (args.targetingKind === "reuse_adset") {
    return args.resolvedAudienceDescription
      ? `herda o conjunto que já converte — ${args.resolvedAudienceDescription}`
      : "herdado do conjunto que já converte";
  }
  return "amplo (Advantage+)";
}

/** Descrição HONESTA do público EXPLÍCITO (Fase 1, subfatia 3a) — geo/idade/gênero pro eco. Pura. */
export function describeExplicitAudience(targeting: Extract<TargetingSpec, { readonly kind: "explicit" }>): string {
  // raio (Slice 5): cidade com raio → "BH (raio 20 km)"; senão só o nome.
  const placeName = (g: Extract<TargetingSpec, { readonly kind: "explicit" }>["geo"][number]): string =>
    g.radius ? `${g.name} (raio ${g.radius} ${g.distanceUnit === "mile" ? "mi" : "km"})` : g.name;
  const geoNames = targeting.geo.map(placeName);
  const areaNames = (targeting.radiusAreas ?? []).map((a) => `${a.address} (raio ${a.radius} ${a.distanceUnit === "mile" ? "mi" : "km"})`);
  const allPlaces = [...geoNames, ...areaNames];
  const placesLabel = allPlaces.length > 0 ? summarizePlaces(allPlaces) : null;
  const ageLabel = targeting.ageMin !== undefined || targeting.ageMax !== undefined ? `${targeting.ageMin ?? "?"}-${targeting.ageMax ?? "?"} anos` : null;
  const genderLabel = targeting.genders?.includes(1) && !targeting.genders.includes(2) ? "homens" : targeting.genders?.includes(2) && !targeting.genders.includes(1) ? "mulheres" : null;
  // grupos (Slice 3/4): "A ou B" dentro do grupo, " e " entre grupos (AND narrowing).
  const describeGroups = (gs: readonly (readonly { readonly name: string }[])[] | undefined, label: string): string | null => {
    const groups = (gs ?? []).filter((g) => g.length > 0);
    return groups.length > 0 ? `${label}: ${groups.map((g) => g.map((i) => i.name).join(" ou ")).join(" e ")}` : null;
  };
  const interestsLabel = describeGroups(targeting.interestGroups, "interesses");
  const behaviorsLabel = describeGroups(targeting.behaviorGroups, "comportamentos");
  const audienceLabel = targeting.customAudienceIncludeIds && targeting.customAudienceIncludeIds.length > 0 ? "+ público salvo indicado" : null;
  const exclusionLabel = targeting.customAudienceExcludeIds && targeting.customAudienceExcludeIds.length > 0 ? "excluindo público salvo" : null;
  return [placesLabel, ageLabel, genderLabel, interestsLabel, behaviorsLabel, "sem expansão de público", audienceLabel, exclusionLabel].filter((s): s is string => Boolean(s)).join(", ");
}

/** Máx. de cidades/regiões nomeadas no eco antes de resumir em "+N" (compacto, não despeja a lista). */
const MAX_PLACES_IN_ECHO = 3;

function summarizePlaces(names: readonly string[]): string {
  if (names.length <= MAX_PLACES_IN_ECHO) return names.join(", ");
  return `${names.slice(0, MAX_PLACES_IN_ECHO).join(", ")} (+${names.length - MAX_PLACES_IN_ECHO} cidades)`;
}

/** geo AGRUPADO (snapshot) → lista PLANA `{key,name,kind}[]`
 *  (shape do `TargetingSpec.explicit.geo`). Usado quando o dono troca idade/gênero na CÓPIA sem
 *  trocar a geo — mantém a geo original em vez de defaultar pra um país. País usa o código como
 *  nome (sem round-trip de nome legível — `resolvedSnapshot` não guarda o nome do país). */
function flattenSnapshotGeo(geo: ResolvedAudienceSnapshot["geo"]): { readonly key: string; readonly name: string; readonly kind: "country" | "region" | "city" }[] {
  const countries = (geo.countries ?? []).map((c) => ({ key: c, name: c, kind: "country" as const }));
  const regions = (geo.regions ?? []).map((r) => ({ key: r.key, name: r.name, kind: "region" as const }));
  const cities = (geo.cities ?? []).map((c) => ({ key: c.key, name: c.name, kind: "city" as const }));
  return [...countries, ...regions, ...cities];
}

/** Snapshot resolvido → público `explicit` editável (Slice 9 — CONVERTER modo no chat, igual ao site).
 *  Preserva geo (em chips)/idade/interesses/behaviors/públicos salvos herdados; a partir daí o dono
 *  edita à mão. Puro. */
function snapshotToExplicit(snapshot: ResolvedAudienceSnapshot): Extract<TargetingSpec, { readonly kind: "explicit" }> {
  return {
    kind: "explicit",
    geo: flattenSnapshotGeo(snapshot.geo),
    ...(snapshot.ageMin !== undefined ? { ageMin: snapshot.ageMin } : {}),
    ...(snapshot.ageMax !== undefined ? { ageMax: snapshot.ageMax } : {}),
    ...(snapshot.interestGroups && snapshot.interestGroups.length > 0 ? { interestGroups: snapshot.interestGroups } : {}),
    ...(snapshot.behaviorGroups && snapshot.behaviorGroups.length > 0 ? { behaviorGroups: snapshot.behaviorGroups } : {}),
    ...(snapshot.customAudienceIncludeIds && snapshot.customAudienceIncludeIds.length > 0 ? { customAudienceIncludeIds: snapshot.customAudienceIncludeIds } : {}),
    ...(snapshot.customAudienceExcludeIds && snapshot.customAudienceExcludeIds.length > 0 ? { customAudienceExcludeIds: snapshot.customAudienceExcludeIds } : {}),
  };
}

// `buildResolvedSnapshot` mora no core (`@trafego/core`) — fonte ÚNICA compartilhada por worker
// (propose) e api (toggle reuse), pra o `reuse_adset` nascer SEMPRE com retrato. Re-exportado aqui
// (binding importado acima) por conveniência dos testes/consumidores deste módulo.
export { buildResolvedSnapshot };

/**
 * Descrição HONESTA do público herdado pro eco (P0.2) — cidades/regiões (ou países, sem
 * `geoEntries`), faixa etária, expansão (resumo neutro). Pura, sem jargão de campo Meta cru.
 */
export function describeResolvedAudience(profile: AudienceProfile): string {
  const entries = profile.geoEntries ?? [];
  const cityNames = entries.filter((e) => e.kind === "city").map((e) => e.name);
  const regionNames = entries.filter((e) => e.kind === "region").map((e) => e.name);
  const places = cityNames.length > 0 ? cityNames : regionNames.length > 0 ? regionNames : (profile.geo ?? []);
  const placesLabel = places.length > 0 ? summarizePlaces(places) : null;
  const ageLabel = profile.ageMin !== undefined || profile.ageMax !== undefined ? `${profile.ageMin ?? "?"}-${profile.ageMax ?? "?"} anos` : null;
  const { summary } = resolveExpansion(profile.expansion);
  const expansionLabel = summary === "on" ? "expansão de público ligada" : "sem expansão de público";
  // Slice 9: eco honesto — a cópia reuse_adset preserva os públicos salvos; anuncia quando houver.
  const savedLabel = profile.customAudienceCount > 0 ? `${profile.customAudienceCount} público(s) salvo(s)` : null;
  const exclLabel = profile.exclusionCount > 0 ? `${profile.exclusionCount} exclusão(ões)` : null;
  return [placesLabel, ageLabel, savedLabel, exclLabel, expansionLabel].filter((s): s is string => Boolean(s)).join(", ");
}

/** Rótulo PT do formato não-reusável (o vocabulário neutro vem do adapter). */
function unsupportedFormatPt(f: "carousel" | "catalog" | "other"): string {
  return f === "carousel" ? "carrossel" : f === "catalog" ? "anúncio de catálogo" : "formato que ainda não sei clonar";
}

export async function loadAgentContext(deps: WorkerDeps, ctx: DraftProposalContext): Promise<AgentContext | null> {
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
    creativeSource: resolveCreativeSourceStrategy(mc),
    scaleAggressivePreference: ag?.autonomyPolicy?.scaleAggressivePreference ?? "ask",
    creationActivation: resolveCreationActivation(ag?.autonomyPolicy ?? undefined),
    enabled,
  };
}

async function persistDraftAndApproval(
  deps: WorkerDeps,
  ctx: DraftProposalContext,
  kind: "duplicate" | "from_scratch",
  spec: CampaignDraftSpec,
  origin: DraftOrigin,
  sourceRef?: { level: "campaign" | "adset"; id: string; name?: string },
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

/** Piso de tamanho pra um público entregar bem (custom audience Meta ~1000). Abaixo = aviso. */
const MIN_DELIVERABLE_AUDIENCE = 1000;

/** Públicos da conta — DB-first (cache do run), Meta ao vivo no fallback (+ re-cacheia). */
export async function loadAccountAudiences(deps: WorkerDeps, ctx: DraftProposalContext, ref: AdAccountRef): Promise<CustomAudience[]> {
  const rows = await deps.db
    .select({ id: customAudiences.externalId, name: customAudiences.name, subtype: customAudiences.subtype, approximateCount: customAudiences.approximateCount, isLookalike: customAudiences.isLookalike })
    .from(customAudiences)
    .where(and(eq(customAudiences.orgId, ctx.orgId as never), eq(customAudiences.adAccountId, ctx.adAccountId)));
  if (rows.length > 0) {
    return rows.map((r) => ({ id: r.id, name: r.name, ...(r.subtype ? { subtype: r.subtype } : {}), ...(r.approximateCount != null ? { approximateCount: r.approximateCount } : {}), isLookalike: r.isLookalike }));
  }
  // fallback ao vivo BOUNDED pelo mesmo teto dos outros fetches do chat (igual `listAudiencesData`) —
  // Meta lenta na resolução de público não pode travar o propose até o teto do turno; degrada p/ [].
  let live: CustomAudience[];
  try {
    live = await withTimeout(deps.ports.ads.listCustomAudiences(ref), deps.conversation.liveFetchTimeoutMs);
  } catch {
    return [];
  }
  if (live.length > 0) await createAnalysisRepo(deps.db).saveCustomAudiences(ctx.orgId, ctx.adAccountId, live);
  return live;
}

type AudiencePrep =
  | { readonly kind: "ok"; readonly includeIds: string[]; readonly excludeIds: string[]; readonly notes: string[]; readonly sizeWarnings: string[]; readonly dropped: string[] }
  | { readonly kind: "blocked"; readonly reason: string };

/**
 * Resolve os públicos pedidos (por NOME/descrição) → ids, de forma DETERMINÍSTICA (mesmo
 * `resolveNamedMatch` da campanha: typo/acento/ordem, e ambíguo → PERGUNTA com as opções, nunca
 * chuta). Gap 2: se o dono deu inclusão mas não exclusão, SUGERE excluir quem já converteu
 * (decisão final dele — só entra no rascunho + eco). Gap 3: avisa público pequeno demais.
 */
async function prepareAudiences(
  deps: WorkerDeps,
  ctx: DraftProposalContext,
  ref: AdAccountRef,
  includeQueries: readonly string[],
  excludeQueries: readonly string[],
  autonomous = false,
): Promise<AudiencePrep> {
  if (includeQueries.length === 0 && excludeQueries.length === 0) return { kind: "ok", includeIds: [], excludeIds: [], notes: [], sizeWarnings: [], dropped: [] };
  const audiences = await loadAccountAudiences(deps, ctx, ref);
  if (audiences.length === 0) {
    if (autonomous) return { kind: "ok", includeIds: [], excludeIds: [], notes: [], sizeWarnings: [], dropped: [...includeQueries, ...excludeQueries] };
    return { kind: "blocked", reason: "não achei públicos salvos nessa conta — confere no Gerenciador ou rode uma análise que eu cacheio os públicos" };
  }
  const byId = new Map(audiences.map((a) => [a.id, a]));
  const acc = { name: (a: CustomAudience) => a.name, keys: (a: CustomAudience) => [a.id] };
  const dropped: string[] = [];

  const resolve = (q: string): { id: string } | { blocked: string } | { drop: true } => {
    const m = resolveNamedMatch(audiences, q, acc);
    if (m.kind === "one") return { id: m.row.id };
    if (autonomous) return { drop: true }; // proativo: ambíguo/inexistente → descarta
    if (m.kind === "none") return { blocked: `não achei um público chamado "${q}" na conta. Chega perto? me diga o nome exato (posso listar com "quais públicos eu tenho").` };
    const opts = m.rows.map((r, i) => `${i + 1}. ${r.name}`).join("\n");
    return { blocked: `achei mais de um público parecido com "${q}":\n${opts}\nQual desses? (me diz o nome exato)` };
  };

  const includeIds: string[] = [];
  for (const q of includeQueries) {
    const r = resolve(q);
    if ("blocked" in r) return { kind: "blocked", reason: r.blocked };
    if ("drop" in r) { dropped.push(q); continue; }
    includeIds.push(r.id);
  }
  const excludeIds: string[] = [];
  for (const q of excludeQueries) {
    const r = resolve(q);
    if ("blocked" in r) return { kind: "blocked", reason: r.blocked };
    if ("drop" in r) { dropped.push(q); continue; }
    excludeIds.push(r.id);
  }

  const notes: string[] = [];
  // Gap 2 (sugestão, decisão do dono): incluiu mas não excluiu → sugere excluir convertidos.
  if (includeIds.length > 0 && excludeQueries.length === 0) {
    const suggested = suggestConverterExclusions(audiences, includeIds);
    if (suggested.length > 0) {
      excludeIds.push(...suggested);
      const names = suggested.map((id) => byId.get(id)?.name ?? id).join(", ");
      notes.push(`Já *sugeri excluir* quem parece ter convertido (${names}) — se quiser manter, é só falar.`);
    }
  }
  // Gap 3: público de inclusão pequeno demais → pode não entregar. FALLBACK por-público (o
  // sinal combinado do delivery_estimate, quando pronto, é superior e o substitui no eco).
  const sizeWarnings: string[] = [];
  for (const id of includeIds) {
    const a = byId.get(id);
    if (a?.approximateCount != null && a.approximateCount < MIN_DELIVERABLE_AUDIENCE) {
      sizeWarnings.push(`⚠️ o público *${a.name}* é pequeno (~${a.approximateCount} pessoas) — pode entregar pouco.`);
    }
  }
  return { kind: "ok", includeIds, excludeIds, notes, sizeWarnings, dropped };
}

/** Rótulo PT do tipo de geo (vocabulário Meta fica no adapter — aqui só o kind neutro). */
function geoKindPt(kind: "country" | "region" | "city"): string {
  return kind === "country" ? "país" : kind === "region" ? "região" : "cidade";
}

const MAX_GEO_AMBIGUOUS_OPTIONS = 5;

type GeoPrep =
  | { readonly kind: "ok"; readonly geo: readonly { readonly key: string; readonly name: string; readonly kind: "country" | "region" | "city" }[]; readonly dropped: readonly string[] }
  | { readonly kind: "blocked"; readonly reason: string };

/**
 * Resolve geo pedida (por NOME) → lugar real na Meta. Honestidade: 1 match/exato → resolve; 0 →
 * honesto; 2+ → PERGUNTA. `autonomous` (proativo) descarta o ambíguo/inexistente em `dropped`.
 */
async function prepareGeo(deps: WorkerDeps, ref: AdAccountRef, queries: readonly string[], autonomous = false): Promise<GeoPrep> {
  const resolved: { key: string; name: string; kind: "country" | "region" | "city" }[] = [];
  const dropped: string[] = [];
  for (const q of queries) {
    const matches = await deps.ports.ads.searchGeo(ref, q, ["country", "region", "city"]);
    const exact = matches.find((m) => normalizeTerm(m.name) === normalizeTerm(q));
    const pick = exact ?? (matches.length === 1 ? matches[0] : undefined);
    if (pick) {
      resolved.push({ key: pick.key, name: pick.name, kind: pick.kind });
      continue;
    }
    if (autonomous) { dropped.push(q); continue; }
    if (matches.length === 0) return { kind: "blocked", reason: `não achei "${q}" na busca de localização da Meta — confere o nome? (cidade, região ou país)` };
    const opts = matches
      .slice(0, MAX_GEO_AMBIGUOUS_OPTIONS)
      .map((m, i) => `${i + 1}. ${m.name}${m.countryCode ? ` (${m.countryCode})` : ""} — ${geoKindPt(m.kind)}`)
      .join("\n");
    return { kind: "blocked", reason: `achei mais de um lugar parecido com "${q}":\n${opts}\nQual desses? (me diz mais específico, tipo "Belo Horizonte, MG")` };
  }
  return { kind: "ok", geo: resolved, dropped };
}

const MAX_INTEREST_AMBIGUOUS_OPTIONS = 5;

type InterestPrep =
  | { readonly kind: "ok"; readonly interests: readonly { readonly id: string; readonly name: string }[]; readonly dropped: readonly string[] }
  | { readonly kind: "blocked"; readonly reason: string };

/** normaliza termo p/ match tolerante (minúsculas, sem acento, sem espaço extra). */
function normalizeTerm(s: string): string {
  return [...s.toLowerCase().normalize("NFD")].filter((c) => { const cp = c.codePointAt(0) ?? 0; return cp < 0x300 || cp > 0x36f; }).join("").replace(/\s+/g, " ").trim();
}
/** tamanho de público humanizado pro dono escolher com confiança (~600M, ~48 mil). */
function humanAudienceSize(n: number | undefined): string {
  if (!n || n <= 0) return "";
  if (n >= 1_000_000) return ` (~${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)} mi pessoas)`;
  if (n >= 1_000) return ` (~${Math.round(n / 1_000)} mil pessoas)`;
  return ` (~${n} pessoas)`;
}

/**
 * Resolve uma opção de direcionamento detalhado (interesse/behavior) por NOME → id real. Honestidade
 * (§8): match exato de nome → AUTO-escolhe (resolve o dono repetir a opção ofertada); 0 → tenta de
 * novo SEM o parêntese (a busca da Meta quebra com "(...)" — evita beco sem saída), senão honesto;
 * 2+ sem exato → PERGUNTA numerada COM tamanho de público (nunca chuta o de maior audiência).
 */
async function resolveDetailedTargeting(
  search: (q: string) => Promise<readonly { id: string; name: string; audienceSize?: number; path?: readonly string[] }[]>,
  query: string,
  labelSingular: string,
  autonomous = false,
): Promise<{ kind: "ok"; ref: { id: string; name: string } } | { kind: "blocked"; reason: string } | { kind: "dropped" }> {
  let matches = await search(query);
  if (matches.length === 0) {
    const stripped = query.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
    if (stripped && normalizeTerm(stripped) !== normalizeTerm(query)) matches = await search(stripped);
  }
  const exact = matches.find((m) => normalizeTerm(m.name) === normalizeTerm(query));
  if (exact) return { kind: "ok", ref: { id: exact.id, name: exact.name } };
  if (matches.length === 1) return { kind: "ok", ref: { id: matches[0]!.id, name: matches[0]!.name } };
  // AUTÔNOMO (proativo, sem humano): ambíguo/inexistente → DESCARTA (nunca pergunta, nunca chuta).
  if (autonomous) return { kind: "dropped" };
  if (matches.length === 0) return { kind: "blocked", reason: `não achei ${labelSingular} "${query}" — confere o termo?` };
  const opts = matches
    .slice(0, MAX_INTEREST_AMBIGUOUS_OPTIONS)
    .map((m, i) => `${i + 1}. ${m.name}${humanAudienceSize(m.audienceSize)}${m.path && m.path.length > 0 ? ` — ${m.path.join(" > ")}` : ""}`)
    .join("\n");
  return { kind: "blocked", reason: `achei mais de um ${labelSingular} parecido com "${query}":\n${opts}\nQual desses? (me diz o nome exato da opção)` };
}

/** Resolve interesses pedidos (por NOME) → ids reais. `autonomous` (proativo) descarta o não-resolvido
 *  em `dropped` em vez de perguntar. Ver `resolveDetailedTargeting`. */
async function prepareInterests(deps: WorkerDeps, ref: AdAccountRef, queries: readonly string[], autonomous = false): Promise<InterestPrep> {
  const resolved: { id: string; name: string }[] = [];
  const dropped: string[] = [];
  for (const q of queries) {
    const r = await resolveDetailedTargeting((s) => deps.ports.ads.searchInterests(ref, s), q, "o interesse", autonomous);
    if (r.kind === "blocked") return r;
    if (r.kind === "dropped") dropped.push(q);
    else resolved.push(r.ref);
  }
  return { kind: "ok", interests: resolved, dropped };
}

/** Resolve comportamentos pedidos (por NOME) → ids reais (catálogo cacheado, match local). */
async function prepareBehaviors(deps: WorkerDeps, ref: AdAccountRef, queries: readonly string[], autonomous = false): Promise<InterestPrep> {
  const resolved: { id: string; name: string }[] = [];
  const dropped: string[] = [];
  for (const q of queries) {
    const r = await resolveDetailedTargeting((s) => deps.ports.ads.searchBehaviors(ref, s), q, "o comportamento", autonomous);
    if (r.kind === "blocked") return r;
    if (r.kind === "dropped") dropped.push(q);
    else resolved.push(r.ref);
  }
  return { kind: "ok", interests: resolved, dropped };
}

type ExplicitGeo = Extract<TargetingSpec, { readonly kind: "explicit" }>["geo"][number];
type AddressArea = { readonly address: string; readonly radiusKm: number };

/** Aplica um raio (km) às CIDADES do geo resolvido (Slice 5) — clampa pro limite da Meta (17–80 km)
 *  + nota. A Meta só aceita raio em `cities` (e custom_locations), NUNCA em `regions`/`countries` —
 *  aplicar em region gera payload inválido/eco enganoso. Puro (usa `clampRadius` do core). */
function applyCityRadius(geo: readonly ExplicitGeo[], radiusKm: number | undefined): { geo: ExplicitGeo[]; notes: string[] } {
  if (!radiusKm) return { geo: [...geo], notes: [] };
  const { radius, note } = clampRadius(radiusKm, "kilometer", "city");
  const next = geo.map((g) => (g.kind === "city" ? { ...g, radius, distanceUnit: "kilometer" as const } : g));
  return { geo: next, notes: note ? [note] : [] };
}

/** Constrói `radiusAreas` (raio em torno de endereço) já clampado (endereço 1–80 km) + notas. Puro. */
function buildRadiusAreas(areas: readonly AddressArea[] | undefined): { radiusAreas: { address: string; radius: number; distanceUnit: "kilometer" }[]; notes: string[] } {
  const out: { address: string; radius: number; distanceUnit: "kilometer" }[] = [];
  const notes: string[] = [];
  for (const a of areas ?? []) {
    const { radius, note } = clampRadius(a.radiusKm, "kilometer", "address");
    if (note) notes.push(note);
    out.push({ address: a.address, radius, distanceUnit: "kilometer" });
  }
  return { radiusAreas: out, notes };
}

/** Nomes propostos (por NOME/termo) do público explícito — subconjunto targeting dos args de criação,
 *  reusado pela EDIÇÃO de público (`adjust_audience`, Fatia C). A resolução nome→id é a mesma. */
export interface ProposedExplicitInput {
  readonly geo?: readonly string[];
  readonly ageMin?: number;
  readonly ageMax?: number;
  readonly gender?: "all" | "men" | "women";
  readonly interests?: readonly string[];
  readonly behaviors?: readonly string[];
  readonly includeAudiences?: readonly string[];
  readonly excludeAudiences?: readonly string[];
  readonly radiusKm?: number;
  readonly addressAreas?: readonly AddressArea[];
}

export type ResolvedExplicitTargeting =
  | { readonly kind: "ok"; readonly targeting: Extract<TargetingSpec, { readonly kind: "explicit" }>; readonly droppedNames: readonly string[]; readonly notes: readonly string[] }
  | { readonly kind: "blocked"; readonly reason: string }
  | { readonly kind: "empty"; readonly droppedNames: readonly string[] };

/**
 * Resolve nomes propostos → `TargetingSpec.explicit` (nome→id via os MESMOS prepare* da criação;
 * autônomo-safe: descarta o não-resolvido em `droppedNames`). `empty` = nada resolveu (o caller
 * decide: sem edição de público). Reusa `assembleExplicitTargeting` (fonte única da montagem).
 * IO isolado aqui — o worker de análise (adjust_audience) e a criação compartilham a resolução.
 */
export async function resolveProposedExplicitTargeting(
  deps: WorkerDeps,
  ctx: DraftProposalContext,
  ref: AdAccountRef,
  input: ProposedExplicitInput,
  opts: { readonly autonomous?: boolean } = {},
): Promise<ResolvedExplicitTargeting> {
  const auto = opts.autonomous === true;
  const aud = await prepareAudiences(deps, ctx, ref, input.includeAudiences ?? [], input.excludeAudiences ?? [], auto);
  if (aud.kind === "blocked") return { kind: "blocked", reason: aud.reason };
  const geoPrep = await prepareGeo(deps, ref, input.geo ?? [], auto);
  if (geoPrep.kind === "blocked") return { kind: "blocked", reason: geoPrep.reason };
  const interestPrep = await prepareInterests(deps, ref, input.interests ?? [], auto);
  if (interestPrep.kind === "blocked") return { kind: "blocked", reason: interestPrep.reason };
  const behaviorPrep = await prepareBehaviors(deps, ref, input.behaviors ?? [], auto);
  if (behaviorPrep.kind === "blocked") return { kind: "blocked", reason: behaviorPrep.reason };

  const droppedNames = [...aud.dropped, ...geoPrep.dropped, ...interestPrep.dropped, ...behaviorPrep.dropped];
  const geoRadius = applyCityRadius(geoPrep.geo, input.radiusKm);
  const areas = buildRadiusAreas(input.addressAreas);
  const parts: ExplicitTargetingParts = {
    geo: geoRadius.geo,
    ...(areas.radiusAreas.length > 0 ? { radiusAreas: areas.radiusAreas } : {}),
    ...(input.ageMin !== undefined ? { ageMin: input.ageMin } : {}),
    ...(input.ageMax !== undefined ? { ageMax: input.ageMax } : {}),
    ...(input.gender ? { gender: input.gender } : {}),
    interests: interestPrep.interests,
    behaviors: behaviorPrep.interests,
    includeAudienceIds: aud.includeIds,
    excludeAudienceIds: aud.excludeIds,
  };
  if (!hasExplicitContent(parts)) return { kind: "empty", droppedNames };
  return { kind: "ok", targeting: assembleExplicitTargeting(parts), droppedNames, notes: [...aud.notes, ...geoRadius.notes, ...areas.notes] };
}

/**
 * Estima o alcance do targeting COMBINADO ao vivo (Fatia 7 — fast-follow) → nota pro eco. Best-effort:
 * qualquer erro/indisponibilidade da plataforma vira `null` e o caller degrada pro sinal por-público
 * (`sizeWarnings`). NÃO cacheável no run: depende do público/exclusões escolhidos no chat. Chamado só
 * quando o dono indicou público (alcance incerto — onde a estimativa agrega valor).
 */
async function reachNoteFor(
  deps: WorkerDeps,
  ref: AdAccountRef,
  targeting: TargetingSpec,
  goal: ConversionGoal,
  pixelId?: string,
): Promise<string | null> {
  try {
    // bounded pelo MESMO teto dos outros fetches ao vivo do chat: enrichment opcional NÃO pode
    // travar até o teto do turno inteiro (derrubaria a proposta) — Meta lenta → degrada p/ null.
    const estimate = await withTimeout(
      deps.ports.ads.getDeliveryEstimate(ref, { targeting, goal, ...(pixelId ? { pixelId } : {}) }),
      deps.conversation.liveFetchTimeoutMs,
    );
    return describeDeliveryEstimate(estimate);
  } catch {
    return null; // estimativa é enriquecimento, nunca bloqueia a proposta
  }
}

/** Motivo do bloqueio quando o público autônomo fica abaixo do piso de alcance (Fatia 8) — o nó
 *  de proativo reconhece este sentinel e degrada pra recomendação humana em vez de criar. */
export const PROACTIVE_REACH_FLOOR_REASON = "público estreito demais para veicular sozinho";

/** Motivo do bloqueio quando o autônomo EXIGE público resolvido (ex: remarketing) mas nenhum
 *  público de inclusão resolveu — degrada pra recomendação humana em vez de criar amplo às cegas. */
export const PROACTIVE_AUDIENCE_UNRESOLVED_REASON = "não consegui resolver o público específico para criar sozinho";

/**
 * Ajusta o nº de anúncios PRESERVANDO os existentes: aumentar duplica o último (copy + criativo
 * próprio); diminuir corta os últimos (mín 1). Clampado ao teto. Não regenera copy nem apaga edições.
 */
export function adjustAdCount(variants: readonly CopyVariant[], target: number): CopyVariant[] {
  const t = Math.max(1, Math.min(target, MAX_ADS_PER_DRAFT));
  if (t <= variants.length) return variants.slice(0, t);
  if (variants.length === 0) return [...variants]; // nada a duplicar (rascunho sempre nasce com ≥1)
  const out = [...variants];
  const last = variants[variants.length - 1]!;
  while (out.length < t) out.push({ ...last });
  return out;
}

/**
 * Piso de alcance (só autônomo): a faixa MENSAL estimada está abaixo do mínimo? Best-effort —
 * estimativa não-pronta/indisponível → `false` (não bloqueia: não inventa risco onde não há dado).
 */
async function reachBelowFloor(
  deps: WorkerDeps,
  ref: AdAccountRef,
  targeting: TargetingSpec,
  goal: ConversionGoal,
  minMonthlyReach: number,
  pixelId?: string,
): Promise<boolean> {
  try {
    const estimate = await withTimeout(
      deps.ports.ads.getDeliveryEstimate(ref, { targeting, goal, ...(pixelId ? { pixelId } : {}) }),
      deps.conversation.liveFetchTimeoutMs,
    );
    return estimate.ready && estimate.monthlyReachMax != null && estimate.monthlyReachMax < minMonthlyReach;
  } catch {
    return false;
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
    const raise = (targetLevel: "adset" | "campaign", targetId: string, currentMinor: number, reason: string): ChatDraftProposal => ({
      kind: "action",
      action: {
        id: `scale:${targetId}`,
        type: "adjust_budget",
        target: { level: targetLevel, id: targetId, name: label },
        // `currentMinor` (contexto de exibição): o card mostra "atual → proposto".
        params: {
          [ACTION_PARAM_MODE]: BUDGET_MODE_INCREASE,
          [ACTION_PARAM_PCT]: pct,
          ...(currentMinor > 0 ? { [ACTION_PARAM_CURRENT_MINOR]: currentMinor } : {}),
        },
        source: "llm",
        riskLevel: "medium",
        reason,
      },
    });
    // (a) adset com orçamento VITALÍCIO próprio → sobe o vitalício do conjunto.
    if (sourceLifetimeMinor > 0) {
      return raise("adset", chosen.entityId, sourceLifetimeMinor, `seu vencedor "${label}" usa orçamento vitalício no conjunto, então subo +${pct}% no orçamento vitalício dele`);
    }
    // (b) sem orçamento no adset → CBO: sobe o da CAMPANHA-mãe (diário ou vitalício).
    const parent = await deps.ports.ads.getAdSetCampaignBudget(ac.ref, chosen.entityId);
    if (!parent || (parent.dailyBudgetMinor <= 0 && parent.lifetimeBudgetMinor <= 0)) {
      return { kind: "blocked", reason: "essa campanha não tem um orçamento que eu consiga escalar por aqui — ajuste o orçamento no gerenciador." };
    }
    const isLifetime = parent.dailyBudgetMinor <= 0;
    const kindTxt = isLifetime ? "vitalício" : "diário";
    const parentMinor = isLifetime ? parent.lifetimeBudgetMinor : parent.dailyBudgetMinor;
    return raise(
      "campaign",
      parent.campaignId,
      parentMinor,
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
      // `currentMinor` (contexto de exibição): o card mostra "atual → proposto". Diário
      // preferido; adset sob orçamento vitalício usa o vitalício do próprio conjunto.
      params: {
        [ACTION_PARAM_MODE]: BUDGET_MODE_INCREASE,
        [ACTION_PARAM_PCT]: move.pct,
        ...(sourceDailyMinor > 0
          ? { [ACTION_PARAM_CURRENT_MINOR]: sourceDailyMinor }
          : sourceLifetimeMinor > 0
            ? { [ACTION_PARAM_CURRENT_MINOR]: sourceLifetimeMinor }
            : {}),
      },
      source: "llm",
      riskLevel: "medium",
      reason: `escalar o vencedor "${label}": +${move.pct}% de budget`,
    };
    return { kind: "action", action };
  }

  // clampa JÁ no propose ao teto de gasto novo → o eco mostra o valor REAL (o guardrail
  // do apply é rede redundante, não uma surpresa que corta o que o usuário confirmou). §8.
  const requested = Math.round(sourceDailyMinor * (1 + move.scalePct / 100));
  const { dailyBudgetMinor: newDailyMinor, clampedByCap } = clampNewBudget(requested, ac.cfg.maxNewDailyBudgetMinor);
  const spec: CampaignDraftSpec = {
    version: 1,
    currency: ac.currency,
    dailyBudgetMinor: newDailyMinor,
    ...(clampedByCap ? { requestedDailyBudgetMinor: requested } : {}),
    activation: ac.creationActivation,
  };
  const { draftId, approvalId } = await persistDraftAndApproval(deps, ctx, "duplicate", spec, origin, {
    level,
    id: chosen.entityId,
    name: label, // nome do vencedor → card mostra "Duplicar conjunto <nome>" (não o id cru)
  });
  const budgetLine = clampedByCap
    ? `Gasto novo: ${money(newDailyMinor / MINOR_PER_UNIT, ac.currency)}/dia (você pediu ${money(requested / MINOR_PER_UNIT, ac.currency)}, mas seu teto de gasto novo é ${money(newDailyMinor / MINOR_PER_UNIT, ac.currency)}) · ${activationPhrase(ac.creationActivation)}.`
    : `Gasto novo: ${money(newDailyMinor / MINOR_PER_UNIT, ac.currency)}/dia · ${activationPhrase(ac.creationActivation)}.`;
  const echo = joinBalloons([
    `Vou **duplicar o vencedor "${label}"** com mais budget pra escalar sem estourar o aprendizado do original.`,
    budgetLine,
    `Confirma? (o original fica intocado)`,
  ]);
  return { kind: "draft", echo, approvalId, draftId };
}

/** Eco genérico de um rascunho (após refino) — o quê/quanto/ativação/copy. Exportado p/ teste. */
export function buildRefineEcho(kind: string, spec: CampaignDraftSpec): string {
  const head = kind === "duplicate" ? "Rascunho de escala atualizado" : "Rascunho de campanha atualizado";
  const lines = [
    `${head}: gasto novo ${money(spec.dailyBudgetMinor / MINOR_PER_UNIT, spec.currency)}/dia · ${activationPhrase(spec.activation)}.`,
  ];
  if (kind === "from_scratch" && spec.objective) lines.push(`Objetivo: ${goalNounPt(spec.objective)}.`);
  // copies/composição só no rascunho de criação (escala/duplicate não tem copyVariants próprios).
  if (kind === "from_scratch" && spec.copyVariants && spec.copyVariants.length > 0) {
    const distinct = new Set(spec.copyVariants.map((v) => v.creative?.metaVideoId ?? v.creative?.metaImageHash ?? "default")).size;
    if (spec.copyVariants.length >= 2) lines.push(`${spec.copyVariants.length} anúncios · ${distinct} criativo(s) distinto(s).`);
    lines.push(describeCopiesBlock(spec.copyVariants));
  }
  const t = spec.targeting;
  if (kind === "from_scratch" && t) {
    // fonte ÚNICA do eco de público (§13 reuso): antes duplicava a lógica aqui e assumia "amplo"
    // p/ explicit/custom_audiences — mesma classe do bug já corrigido em `audienceEchoPhrase`.
    lines.push(
      `Público: ${audienceEchoPhrase({
        targetingKind: t.kind,
        ...(t.kind === "explicit" ? { explicitAudienceDescription: describeExplicitAudience(t) } : {}),
      })}.`,
    );
  }
  lines.push("Confirma agora ou quer ajustar mais?");
  return joinBalloons(lines);
}

/** Rascunho aberto recuperado do BANCO (fonte da verdade) quando o estado efêmero da conversa
 *  expirou — o suficiente pra refinar (draftId), aplicar/recusar (approvalId) e re-ecoar (kind+spec). */
export interface RecoveredDraft {
  readonly draftId: string;
  readonly approvalId: string;
  readonly kind: DraftKind;
  readonly spec: CampaignDraftSpec;
}

/**
 * Recupera o rascunho de campanha AINDA ABERTO (`proposed`) do banco quando o `pendingDraft` do
 * estado da conversa expirou (TTL 30min) — a fonte da verdade das pendências é a tabela (§ Regras de
 * negócio, igual às approvals). Junta a aprovação de rascunho PENDENTE (id p/ aplicar/recusar) com o
 * `campaign_drafts` mais recente. Sem pendência aberta → null. Org + conta-scoped.
 */
export async function recoverOpenDraft(deps: WorkerDeps, ctx: DraftProposalContext): Promise<RecoveredDraft | null> {
  const pending = (await deps.ports.approval.listPendingByAgent(ctx.agentId as AgentId)).filter(
    (a): a is DraftApproval => a.kind === "draft",
  );
  if (pending.length === 0) return null;
  const [row] = await deps.db
    .select({ id: campaignDrafts.id, kind: campaignDrafts.kind, spec: campaignDrafts.spec })
    .from(campaignDrafts)
    .where(
      and(
        inArray(
          campaignDrafts.id,
          pending.map((a) => a.draftId),
        ),
        eq(campaignDrafts.orgId, ctx.orgId),
        eq(campaignDrafts.adAccountId, ctx.adAccountId),
        eq(campaignDrafts.status, "proposed"),
      ),
    )
    .orderBy(desc(campaignDrafts.createdAt))
    .limit(1);
  if (!row) return null;
  const appr = pending.find((a) => a.draftId === row.id);
  if (!appr) return null;
  return { draftId: row.id, approvalId: appr.id, kind: row.kind, spec: row.spec as CampaignDraftSpec };
}

export interface RefineDraftPatch {
  readonly budgetReais?: number;
  readonly activation?: "active" | "paused";
  readonly variantsCount?: number;
  readonly regenerateCopy?: boolean;
  /** público (só from_scratch): `reuse` = herda o conjunto que converte; `broad` = a Meta escolhe. */
  readonly audience?: "reuse" | "broad";
  /** nome da campanha (chat leve — ajuste de intenção única, só from_scratch). */
  readonly campaignName?: string;
  /** nome do conjunto de anúncios (só from_scratch) — paridade com o painel do site. */
  readonly adsetName?: string;
  /** objetivo/conversão de negócio (só from_scratch) — paridade com o site: o refino re-resolve o
   *  pixel DA CONTA; o core bloqueia objetivo que exige pixel quando a conta não tem. */
  readonly objective?: ConversionGoal;
  /** remove geo(s) do público EXPLÍCITO já resolvido (Fase 1, subfatia 3a) — por nome/trecho do
   *  nome (ex: "Ibirité"). Sem chamada nova (já está no rascunho). Nome não encontrado → bloqueia. */
  readonly removeGeo?: readonly string[];
  /** adiciona geo(s) NOVA(s) ao público explícito, pelo NOME que o dono disse — `refineDraft`
   *  resolve via `prepareGeo` (ambíguo→pergunta) antes de fundir. */
  readonly addGeo?: readonly string[];
  readonly ageMin?: number;
  readonly ageMax?: number;
  /** gênero do público EXPLÍCITO: "men"/"women" define; "all" limpa (todos). Ausente = mantém. */
  readonly gender?: "men" | "women" | "all";
  /** remove interesse(s) do público EXPLÍCITO já resolvido (Fase 2, subfatia 4) — por nome/trecho
   *  do nome. Sem chamada nova. Nome não encontrado → bloqueia. */
  readonly removeInterests?: readonly string[];
  /** adiciona interesse(s) ao público explícito (OR-widen no 1º grupo), pelo NOME que o dono disse —
   *  `refineDraft` resolve via `prepareInterests` (ambíguo→pergunta) antes de fundir. */
  readonly addInterests?: readonly string[];
  /** ESTREITA (AND narrowing, Slice 3): novo grupo "e também/que também curtam" — os interesses do
   *  novo grupo ANDam com os existentes. Resolvido via `prepareInterests`. */
  readonly narrowInterests?: readonly string[];
  /** comportamentos (Slice 4) — mesma semântica dos interesses (remove/OR-widen/AND narrow). */
  readonly removeBehaviors?: readonly string[];
  readonly addBehaviors?: readonly string[];
  readonly narrowBehaviors?: readonly string[];
  /** raio (Slice 9 — paridade com site): aplica raio (km) às cidades do público; áreas por endereço. */
  readonly radiusKm?: number;
  readonly addressAreas?: readonly AddressArea[];
  /** públicos salvos (Slice 9 — paridade): adiciona ao incluir / excluir / remove (por NOME → id). */
  readonly addAudiences?: readonly string[];
  readonly excludeAudiences?: readonly string[];
  readonly removeAudiences?: readonly string[];
  /** COMPOSIÇÃO de criativo (recompor o rascunho existente): quantos distintos + mídia. O agente
   *  escolhe QUAIS; troca do asset específico segue no site. */
  readonly distinctCreatives?: number;
  readonly mediaPreference?: MediaPreference;
  /** edição do TEXTO da copy por anúncio (índice) — headline/primaryText/description/adName. NÃO
   *  toca o criativo (composição/site cuidam disso). */
  readonly copyEdits?: readonly {
    readonly index: number;
    readonly headline?: string;
    readonly primaryText?: string;
    readonly description?: string;
    readonly adName?: string;
  }[];
}

export type RefineResult = { readonly kind: "ok"; readonly echo: string } | { readonly kind: "blocked"; readonly reason: string };

type MutableEdit = { -readonly [K in keyof DraftEdit]: DraftEdit[K] };

const NOT_OPEN_REASON = "esse rascunho não está mais aberto pra ajuste";

/** Erro tipado do núcleo → motivo amigável no chat (§13). O caminho leve do chat raramente cai
 *  aqui (não edita objetivo nem remove anúncio), mas mapeia por completude. */
function refineErrorReason(error: RefineError): string {
  switch (error.code) {
    case "field_not_editable":
      return "numa escala eu mantenho o que já converte — pra mexer nisso o caminho é criar uma campanha nova";
    case "empty_variants":
      return "toda campanha precisa de pelo menos um anúncio";
    case "objective_requires_pixel":
      return "esse objetivo precisa do pixel configurado na conta, e ela ainda não tem";
  }
}

/**
 * Refinamento CONVERSACIONAL do rascunho pendente (Fatia 7): muta o campaign_drafts (spec) sem
 * criar rascunho novo e re-ecoa. Converge com o site no núcleo `applyDraftEdit` + `persistDraftSpec`
 * (§13 DRY) — a casca só resolve os fragmentos de IO (copy via LLM, público ao vivo). O chat é LEVE
 * (Slice 8): budget/ativação/nome/público/regenerar copy; edição pesada vai pro painel do site.
 */
export async function refineDraft(
  deps: WorkerDeps,
  ctx: DraftProposalContext,
  draftId: string,
  patch: RefineDraftPatch,
): Promise<RefineResult> {
  const loaded = await loadDraftForEdit(deps.db, { orgId: ctx.orgId, draftId, adAccountId: ctx.adAccountId });
  if (!loaded) return { kind: "blocked", reason: NOT_OPEN_REASON };
  const { kind, spec } = loaded;

  const ac = await loadAgentContext(deps, ctx);
  if (!ac) return { kind: "blocked", reason: "não consegui acessar a conta agora" };

  // `inferCreationDefaults` (ida à Meta) memoizado — o refino pode tocar objetivo + regenerar copy +
  // público no mesmo turno; sem o memo seriam 3 idas. Lazy: só resolve se algum ramo precisar.
  let defaultsCache: Awaited<ReturnType<typeof deps.ports.ads.inferCreationDefaults>> | undefined;
  const defaultsOnce = async () => (defaultsCache ??= await deps.ports.ads.inferCreationDefaults(ac.ref));

  const edit: MutableEdit = {};
  const refineNotes: string[] = []; // avisos (ex: clamp de raio) anexados ao eco
  if (patch.budgetReais != null) edit.budgetMinor = Math.round(patch.budgetReais * MINOR_PER_UNIT);
  if (patch.activation) edit.activation = patch.activation;
  if (kind === "from_scratch" && patch.campaignName != null) edit.campaignName = patch.campaignName;
  if (kind === "from_scratch" && patch.adsetName != null) edit.adsetName = patch.adsetName;
  // OBJETIVO (só from_scratch, paridade com o site §13): re-resolve o pixel DA CONTA (não de
  // spec.pixelId). O guard do core (`objective_requires_pixel`) bloqueia objetivo que exige pixel
  // quando a conta não tem; quando há, grava o pixel no spec junto.
  let hasPixel = true;
  if (kind === "from_scratch" && patch.objective) {
    const defaults = await defaultsOnce();
    hasPixel = Boolean(defaults.pixelId);
    edit.objective = patch.objective;
    if (defaults.pixelId) edit.pixelId = defaults.pixelId;
  }

  // anúncios (só from_scratch): `regenerateCopy` re-aterra TUDO na copy que já performa (LLM na
  // casca) — descarta edições manuais E criativo próprio (intencional: "regenerar"). Já mudar só o
  // NÚMERO PRESERVA os existentes (aumenta duplicando o último com seu criativo, diminui cortando).
  const currentVariants = [...(spec.copyVariants ?? [])];
  if (kind === "from_scratch" && patch.regenerateCopy === true) {
    const defaults = await defaultsOnce();
    edit.copyVariants = await generateCopy(
      deps.ports.llm,
      {
        model: ac.model,
        goal: spec.objective ?? DEFAULT_CONVERSION_GOAL,
        variantsCount: Math.min(patch.variantsCount ?? spec.variantsCount ?? DEFAULT_VARIANTS, MAX_ADS_PER_DRAFT),
        businessContext: ac.businessContext,
        guidance: ac.guidance,
        ...(defaults.winnerCopy ? { winnerCopy: defaults.winnerCopy } : {}),
      },
      { orgId: ctx.orgId, adAccountId: ctx.adAccountId },
    );
  } else if (kind === "from_scratch" && patch.variantsCount != null && patch.variantsCount !== currentVariants.length) {
    // muda SÓ o nº: preserva os existentes (adjustAdCount). AUMENTAR ("quero 5 criativos diferentes")
    // tenta dar criativos DISTINTOS aos novos slots pela MESMA estratégia do create (o chat não edita
    // criativo por-anúncio, mas escolhe quantos + a estratégia decide quais); pool insuficiente →
    // entrega N mesmo assim (repete o melhor) + nota honesta. Diminuir = só corta.
    let variants = adjustAdCount(currentVariants, patch.variantsCount);
    if (variants.length > currentVariants.length && spec.creative) {
      // preenche os slots default/novos com criativos DISTINTOS, PRESERVANDO os que o dono já trocou
      // no site (por-anúncio) — nunca sobrescreve escolha explícita. Pool insuficiente → herda o padrão.
      const primary = chosenFromRef(spec.creative);
      const pool = await buildCreativePool(deps, ctx.orgId, ctx.adAccountId, ac.ref, ac.creativeSource);
      const filled = fillDistinctCreatives(variants, primary, pool.map((c) => c.ref));
      variants = filled.variants;
      // nota honesta (§8): ≥2 anúncios repetindo o melhor (sem distinto pra todos) → avisa no eco.
      if (filled.withoutDistinct >= 2) {
        refineNotes.push(`${filled.withoutDistinct} dos anúncios usam o melhor criativo (não achei criativos distintos pra todos) — dá pra trocar cada um no site.`);
      }
    }
    edit.copyVariants = variants;
  }

  // público (só from_scratch): thunk lazy (broad/keep não tocam a conta). O reuse SEMPRE nasce com
  // retrato (lê o público da fonte + buildResolvedSnapshot) — nunca um reuse_adset cru (Bug 3).
  if (kind === "from_scratch" && patch.audience) {
    const targeting = await resolveAudienceTargeting(patch.audience, spec.targeting, async () => {
      const sourceAdsetId = (await defaultsOnce()).sourceAdsetId;
      if (!sourceAdsetId) return undefined;
      const profile = await deps.ports.ads.getAudienceProfile(ac.ref, sourceAdsetId);
      return profile ? { kind: "reuse_adset", sourceAdsetId, resolved: buildResolvedSnapshot(profile) } : undefined;
    });
    if (targeting) edit.targeting = targeting;
  }
  // PÚBLICO EXPLÍCITO — edições (Slice 9, chat ⊇ site): CONVERTE reuse/broad→explicit se preciso e
  // aplica geo/raio/idade/gênero/interesses/behaviors/públicos salvos — igual ao editor do site.
  const wantsExplicit =
    kind === "from_scratch" &&
    Boolean(
      patch.removeGeo?.length || patch.addGeo?.length || patch.ageMin != null || patch.ageMax != null || patch.gender != null ||
        patch.radiusKm != null || patch.addressAreas?.length ||
        patch.removeInterests?.length || patch.addInterests?.length || patch.narrowInterests?.length ||
        patch.removeBehaviors?.length || patch.addBehaviors?.length || patch.narrowBehaviors?.length ||
        patch.addAudiences?.length || patch.excludeAudiences?.length || patch.removeAudiences?.length,
    );
  if (wantsExplicit) {
    // 1) base explícita — converte reuse/broad (mesmo "personalizar público" do site), preservando o herdado.
    let base = edit.targeting ?? spec.targeting;
    if (base?.kind !== "explicit") {
      if (base?.kind === "reuse_adset") {
        let snap = base.resolved;
        if (!snap) {
          const p = await deps.ports.ads.getAudienceProfile(ac.ref, base.sourceAdsetId);
          if (!p) return { kind: "blocked", reason: "não consegui ler o público herdado agora pra personalizar — tenta de novo em instantes." };
          snap = buildResolvedSnapshot(p);
        }
        base = snapshotToExplicit(snap);
      } else {
        base = { kind: "explicit", geo: [] }; // advantage_plus/ausente → começa do zero
      }
    }
    let expl: Extract<TargetingSpec, { readonly kind: "explicit" }> = base as Extract<TargetingSpec, { readonly kind: "explicit" }>;
    // 2) geo (add/remove) + idade + gênero
    if (patch.removeGeo?.length || patch.addGeo?.length || patch.ageMin != null || patch.ageMax != null || patch.gender != null) {
      const addGeoPrep = patch.addGeo?.length ? await prepareGeo(deps, ac.ref, patch.addGeo) : { kind: "ok" as const, geo: [] };
      if (addGeoPrep.kind === "blocked") return { kind: "blocked", reason: addGeoPrep.reason };
      const r = applyExplicitGeoEdit(expl, {
        ...(patch.removeGeo ? { removeGeo: patch.removeGeo } : {}),
        ...(addGeoPrep.geo.length > 0 ? { addGeo: addGeoPrep.geo } : {}),
        ...(patch.ageMin != null ? { ageMin: patch.ageMin } : {}),
        ...(patch.ageMax != null ? { ageMax: patch.ageMax } : {}),
        ...(patch.gender != null ? { genders: patch.gender === "men" ? [1] : patch.gender === "women" ? [2] : [] } : {}),
      });
      if (r.kind === "blocked") return { kind: "blocked", reason: r.reason };
      expl = r.targeting as typeof expl;
    }
    // 3) raio (cidade + endereço) — clampado, com aviso
    if (patch.radiusKm != null || patch.addressAreas?.length) {
      const gr = applyCityRadius(expl.geo, patch.radiusKm ?? undefined);
      const areas = buildRadiusAreas(patch.addressAreas);
      const mergedAreas = [...(expl.radiusAreas ?? []), ...areas.radiusAreas];
      expl = { ...expl, geo: gr.geo, ...(mergedAreas.length > 0 ? { radiusAreas: mergedAreas } : {}) };
      refineNotes.push(...gr.notes, ...areas.notes);
    }
    // 4) interesses (OR-widen / AND narrow / remove)
    if (patch.removeInterests?.length || patch.addInterests?.length || patch.narrowInterests?.length) {
      const addP = patch.addInterests?.length ? await prepareInterests(deps, ac.ref, patch.addInterests) : { kind: "ok" as const, interests: [] };
      if (addP.kind === "blocked") return { kind: "blocked", reason: addP.reason };
      const narrowP = patch.narrowInterests?.length ? await prepareInterests(deps, ac.ref, patch.narrowInterests) : { kind: "ok" as const, interests: [] };
      if (narrowP.kind === "blocked") return { kind: "blocked", reason: narrowP.reason };
      const r = applyExplicitInterestEdit(expl, {
        ...(patch.removeInterests ? { removeInterests: patch.removeInterests } : {}),
        ...(addP.interests.length > 0 ? { addInterests: addP.interests } : {}),
        ...(narrowP.interests.length > 0 ? { narrowInterests: narrowP.interests } : {}),
      });
      if (r.kind === "blocked") return { kind: "blocked", reason: r.reason };
      expl = r.targeting as typeof expl;
    }
    // 5) comportamentos
    if (patch.removeBehaviors?.length || patch.addBehaviors?.length || patch.narrowBehaviors?.length) {
      const addP = patch.addBehaviors?.length ? await prepareBehaviors(deps, ac.ref, patch.addBehaviors) : { kind: "ok" as const, interests: [] };
      if (addP.kind === "blocked") return { kind: "blocked", reason: addP.reason };
      const narrowP = patch.narrowBehaviors?.length ? await prepareBehaviors(deps, ac.ref, patch.narrowBehaviors) : { kind: "ok" as const, interests: [] };
      if (narrowP.kind === "blocked") return { kind: "blocked", reason: narrowP.reason };
      const r = applyExplicitBehaviorEdit(expl, {
        ...(patch.removeBehaviors ? { removeBehaviors: patch.removeBehaviors } : {}),
        ...(addP.interests.length > 0 ? { addBehaviors: addP.interests } : {}),
        ...(narrowP.interests.length > 0 ? { narrowBehaviors: narrowP.interests } : {}),
      });
      if (r.kind === "blocked") return { kind: "blocked", reason: r.reason };
      expl = r.targeting as typeof expl;
    }
    // 6) públicos salvos (incluir/excluir/remover, por NOME → id determinístico; ambíguo→pergunta)
    if (patch.addAudiences?.length || patch.excludeAudiences?.length || patch.removeAudiences?.length) {
      const add = await prepareAudiences(deps, ctx, ac.ref, patch.addAudiences ?? [], patch.excludeAudiences ?? []);
      if (add.kind === "blocked") return { kind: "blocked", reason: add.reason };
      const rem = patch.removeAudiences?.length ? await prepareAudiences(deps, ctx, ac.ref, patch.removeAudiences, []) : { kind: "ok" as const, includeIds: [], excludeIds: [], notes: [], sizeWarnings: [] };
      if (rem.kind === "blocked") return { kind: "blocked", reason: rem.reason };
      const rmSet = new Set(rem.includeIds);
      const inc = [...new Set([...(expl.customAudienceIncludeIds ?? []), ...add.includeIds])].filter((id) => !rmSet.has(id));
      const exc = [...new Set([...(expl.customAudienceExcludeIds ?? []), ...add.excludeIds])].filter((id) => !rmSet.has(id));
      const { customAudienceIncludeIds: _i, customAudienceExcludeIds: _e, ...rest } = expl;
      expl = { ...rest, ...(inc.length > 0 ? { customAudienceIncludeIds: inc } : {}), ...(exc.length > 0 ? { customAudienceExcludeIds: exc } : {}) };
      refineNotes.push(...add.notes);
    }
    edit.targeting = expl;
  }

  // COMPOSIÇÃO de criativo (recompor o rascunho existente): "deixa 2 iguais e 2 diferentes", "usa só
  // vídeo". O agente escolhe QUAIS; recompõe sobre o nº atual de anúncios. Sobrescreve os criativos
  // por-anúncio (é um pedido EXPLÍCITO de recomposição — diferente do aumento de contagem, que preserva).
  if (kind === "from_scratch" && spec.creative && (patch.distinctCreatives != null || patch.mediaPreference)) {
    const variants0 = edit.copyVariants ?? currentVariants;
    const primary = chosenFromRef(spec.creative);
    const seen = new Set<string>();
    let distinctList = [primary, ...(await buildCreativePool(deps, ctx.orgId, ctx.adAccountId, ac.ref, ac.creativeSource)).map((c) => c.ref)].filter(
      (c) => (seen.has(creativeKey(c)) ? false : (seen.add(creativeKey(c)), true)),
    );
    if (patch.mediaPreference === "video" || patch.mediaPreference === "image") {
      const filtered = filterByMedia(distinctList, patch.mediaPreference);
      if (filtered.length === 0) refineNotes.push(`Não achei criativo ${mediaLabelPt(patch.mediaPreference)} pra reusar — mantive os criativos que a conta tem.`);
      else distinctList = filtered;
    } else if (patch.mediaPreference === "mixed") {
      const mixed = interleaveMedia(distinctList);
      distinctList = mixed.ordered;
      if (!(mixed.hasVideo && mixed.hasImage)) refineNotes.push(`Você pediu vídeos e imagens, mas a conta só tem ${mixed.hasVideo ? "vídeos" : "imagens"} reusáveis — usei o que há.`);
    }
    const target = variants0.length;
    const distinctWanted = patch.distinctCreatives != null ? Math.max(1, Math.min(patch.distinctCreatives, target)) : target;
    const perAd = composeCreatives(target, distinctWanted, distinctList);
    edit.copyVariants = variants0.map((v, i) => (perAd[i] ? { ...v, creative: creativeRefOf(perAd[i]!) } : v));
    if (patch.distinctCreatives != null && distinctList.length < distinctWanted) {
      refineNotes.push(`Você pediu ${distinctWanted} criativos distintos, mas a conta só tem ${distinctList.length} — repeti pra completar os ${target} anúncios. Troque cada um no site.`);
    }
  }

  // EDIÇÃO do TEXTO da copy por anúncio (índice) — headline/primaryText/description/adName. Não toca
  // o criativo. Índice fora do rascunho → bloqueia honesto (nunca edita o anúncio errado).
  if (kind === "from_scratch" && patch.copyEdits?.length) {
    const arr = [...(edit.copyVariants ?? currentVariants)];
    for (const e of patch.copyEdits) {
      if (e.index < 0 || e.index >= arr.length) {
        return { kind: "blocked", reason: `esse rascunho tem ${arr.length} anúncio(s) — não achei o anúncio nº ${e.index + 1} pra editar a copy.` };
      }
      arr[e.index] = {
        ...arr[e.index]!,
        ...(e.headline != null ? { headline: e.headline } : {}),
        ...(e.primaryText != null ? { primaryText: e.primaryText } : {}),
        ...(e.description != null ? { description: e.description } : {}),
        ...(e.adName != null ? { adName: e.adName } : {}),
      };
    }
    edit.copyVariants = arr;
  }

  const result = applyDraftEdit(kind, spec, edit, { budgetCapMinor: ac.cfg.maxNewDailyBudgetMinor ?? null, hasPixel });
  if (!result.ok) return { kind: "blocked", reason: refineErrorReason(result.error) };

  const persisted = await persistDraftSpec(deps.db, { orgId: ctx.orgId, draftId, adAccountId: ctx.adAccountId }, result.value.spec);
  if (!persisted) return { kind: "blocked", reason: NOT_OPEN_REASON };
  const echo = [buildRefineEcho(kind, result.value.spec), ...refineNotes].join(" ");
  return { kind: "ok", echo };
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

/** Carrega o criativo FORÇADO (upload que o usuário mandou no WhatsApp, Slice 7) como ChosenCreative.
 *  Só `ready` + não-arquivado da conta; sem mídia utilizável → null (o create cai no blocked honesto). */
async function loadForcedCreative(
  deps: WorkerDeps,
  orgId: string,
  accountId: string,
  assetId: string,
): Promise<ChosenCreative | null> {
  const [asset] = await deps.db
    .select({
      id: creativeAssets.id,
      status: creativeAssets.status,
      metaImageHash: creativeAssets.metaImageHash,
      metaVideoId: creativeAssets.metaVideoId,
    })
    .from(creativeAssets)
    .where(
      and(
        eq(creativeAssets.id, assetId),
        eq(creativeAssets.orgId, orgId),
        eq(creativeAssets.adAccountId, accountId),
        isNull(creativeAssets.archivedAt),
      ),
    )
    .limit(1);
  if (!asset || asset.status !== "ready" || (!asset.metaImageHash && !asset.metaVideoId)) return null;
  return {
    ...(asset.metaImageHash ? { imageHash: asset.metaImageHash } : {}),
    ...(asset.metaVideoId ? { videoId: asset.metaVideoId } : {}),
    assetId: asset.id,
    origin: "upload",
    source: "library",
  };
}

/**
 * O anúncio-fonte "provado" (melhor por desempenho) está com o criativo fatigado? Fadiga é
 * detectada por CAMPANHA/ADSET (`entity_analyses.flags`), não por anúncio individual — então
 * resolve a campanha/adset do anúncio (`ad_creatives`) e checa se algum dos dois tem o sinal
 * `creative_fatigue` na última análise. Sem dado nenhum (nunca analisado) → assume não-fatigado
 * (nunca bloqueia por ausência de sinal).
 */
async function isSourceFatigued(
  deps: WorkerDeps,
  orgId: string,
  accountId: string,
  agentId: string,
  sourceAdId: string,
): Promise<boolean> {
  const [ad] = await deps.db
    .select({ campaignId: adCreatives.campaignId, adsetId: adCreatives.adsetId })
    .from(adCreatives)
    .where(and(eq(adCreatives.orgId, orgId), eq(adCreatives.adAccountId, accountId), eq(adCreatives.adId, sourceAdId)))
    .limit(1);
  const ids = [ad?.adsetId, ad?.campaignId].filter((id): id is string => Boolean(id));
  if (ids.length === 0) return false;
  const rows = await deps.db
    .select({ curatedJson: entityAnalyses.curatedJson })
    .from(entityAnalyses)
    .where(and(eq(entityAnalyses.agentId, agentId), inArray(entityAnalyses.entityId, ids)));
  // `creative_fatigue` é um healthSignal (curated_json), NÃO uma flag (flags é
  // cpa_acima_da_meta/roas_abaixo_da_meta/anomalia:* — outro conjunto, bug corrigido).
  return rows.some((r) => (r.curatedJson?.healthSignals ?? []).includes("creative_fatigue"));
}

/**
 * Pool ÚNICO de candidatos a criativo (decisão do dono): anúncios VEICULANDO + biblioteca.
 * Rank: o melhor VEICULANDO (provado por desempenho, via `inferCreationDefaults`) vence — SALVO
 * se estiver com o criativo fatigado (`isSourceFatigued`, pivô saúde), caso em que cai na
 * biblioteca por contexto (não reusa automaticamente um anúncio provado mas já cansado). Sem
 * criativo veiculando, cai no upload mais recente da biblioteca (`ready`, não-arquivado). Assim
 * um criativo que você subiu mas nunca veiculou também é candidato (antes era ignorado). O
 * picker manual segue podendo forçar qualquer asset. `null` = nenhum criativo em lugar nenhum.
 */
export async function chooseCreative(
  deps: WorkerDeps,
  orgId: string,
  accountId: string,
  agentId: string,
  ref: AdAccountRef,
  serving: { imageHash?: string; videoId?: string; sourceAdId?: string },
  strategy: CreativeSourceStrategy,
  match?: MatchContext & { readonly model: string },
): Promise<ChosenCreative | null> {
  const servingRef = async (): Promise<ChosenCreative | null> => {
    if (!serving.imageHash && !serving.videoId) return null;
    // gap real corrigido (pivô saúde): não reusar automaticamente um anúncio "provado" cujo
    // criativo já está fatigado (mesmo princípio de `rankCreatives.excludeFatigued`, adaptado
    // à granularidade real disponível — fadiga é sinal de campanha/adset, não de anúncio
    // individual). Sem sourceAdId (ex: picker manual) → nada pra checar, segue.
    if (serving.sourceAdId && (await isSourceFatigued(deps, orgId, accountId, agentId, serving.sourceAdId))) {
      return null;
    }
    return {
      ...(serving.imageHash ? { imageHash: serving.imageHash } : {}),
      ...(serving.videoId ? { videoId: serving.videoId } : {}),
      assetId: serving.sourceAdId ?? "reuse",
      origin: "reuse",
      source: "serving",
    };
  };

  // MODO PADRÃO (serving.best_performing = comportamento de hoje): reusa o melhor veiculando (provado
  // por desempenho, determinístico, SEM LLM); sem veiculando (ou fatigado), cai na biblioteca por contexto.
  if (strategy.mode === "serving" && (strategy.servingPick ?? "best_performing") === "best_performing") {
    return (await servingRef()) ?? (await chooseLibraryByContext(deps, orgId, accountId, match));
  }

  // MODOS COM LLM (serving.agent / library / both): monta o POOL de candidatos DESCRITOS por visão
  // (reusa o cache dos runs/uploads; computa fresh o que faltar, dentro do teto) e o LLM escolhe o
  // melhor ENCAIXE no contexto (objetivo/negócio/orientações). Desempenho é sinal, não veto.
  const pool: DescribedCandidate[] = [];
  if (strategy.mode === "serving" || strategy.mode === "both") {
    pool.push(...(await describeServingCandidates(deps, orgId, accountId, ref)));
  }
  if (strategy.mode === "library" || strategy.mode === "both") {
    pool.push(...(await describeLibraryCandidates(deps, orgId, accountId)));
  }
  if (pool.length === 0) {
    // pediu veiculando mas não há candidato descrito → cai no melhor veiculando; senão nada.
    return strategy.mode === "library" ? null : await servingRef();
  }

  let chosen = pool[0]!; // fallback: ordem (veiculando recentes primeiro, depois biblioteca)
  const described = pool.filter((c) => c.description.trim().length > 0);
  if (match && described.length > 0) {
    const picked = await pickLibraryCreativeByContext(
      deps.ports.llm,
      match.model,
      match,
      described.map(toLibraryCandidate),
    );
    if (picked) chosen = pool.find((c) => c.key === picked) ?? chosen;
  }
  return chosen.ref;
}

/** Um candidato a criativo com descrição (pro matcher) + a ref concreta (pro spec). Sinais de
 *  qualidade (S4c) são opcionais — vêm da visão cacheada, quando disponível. */
interface DescribedCandidate {
  readonly key: string;
  readonly description: string;
  readonly ref: ChosenCreative;
  readonly proofStrength?: "weak" | "medium" | "strong";
  readonly persuasionSignals?: number;
  readonly weaknesses?: readonly string[];
}

/** `DescribedCandidate` → `LibraryCandidate` (repassa os sinais de qualidade quando presentes, S4c). */
function toLibraryCandidate(c: DescribedCandidate): { assetId: string; description: string; proofStrength?: "weak" | "medium" | "strong"; persuasionSignals?: number; weaknesses?: readonly string[] } {
  return {
    assetId: c.key,
    description: c.description,
    ...(c.proofStrength ? { proofStrength: c.proofStrength } : {}),
    ...(c.persuasionSignals != null ? { persuasionSignals: c.persuasionSignals } : {}),
    ...(c.weaknesses && c.weaknesses.length > 0 ? { weaknesses: c.weaknesses } : {}),
  };
}

/** Escolha na BIBLIOTECA por contexto (o caminho de hoje quando não há veiculando). `null` = vazia. */
async function chooseLibraryByContext(
  deps: WorkerDeps,
  orgId: string,
  accountId: string,
  match?: MatchContext & { readonly model: string },
): Promise<ChosenCreative | null> {
  const pool = await describeLibraryCandidates(deps, orgId, accountId);
  if (pool.length === 0) return null;
  let chosen = pool[0]!; // recência
  const described = pool.filter((c) => c.description.trim().length > 0);
  if (match && described.length > 0) {
    const picked = await pickLibraryCreativeByContext(
      deps.ports.llm,
      match.model,
      match,
      described.map(toLibraryCandidate),
    );
    if (picked) chosen = pool.find((c) => c.key === picked) ?? chosen;
  }
  return chosen.ref;
}

/** Chave de identidade de um criativo p/ dedupe entre anúncios (mídia distinta). */
function creativeKey(c: ChosenCreative): string {
  return c.videoId ?? c.imageHash ?? c.assetId;
}

/** CreativeAssetRef (do spec) → ChosenCreative (pra semear o pool de distintos no refino de contagem). */
function chosenFromRef(ref: CreativeAssetRef): ChosenCreative {
  return {
    assetId: ref.assetId,
    origin: ref.origin,
    source: ref.origin === "reuse" ? "serving" : "library",
    ...(ref.metaImageHash ? { imageHash: ref.metaImageHash } : {}),
    ...(ref.metaVideoId ? { videoId: ref.metaVideoId } : {}),
  };
}

/** ChosenCreative → CreativeAssetRef (criativo próprio de um anúncio no spec). */
export function creativeRefOf(c: ChosenCreative): CreativeAssetRef {
  return {
    assetId: c.assetId,
    format: c.videoId ? "video" : "image",
    origin: c.origin,
    ...(c.imageHash ? { metaImageHash: c.imageHash } : {}),
    ...(c.videoId ? { metaVideoId: c.videoId } : {}),
  };
}

/**
 * Monta as variações de copy com criativos DISTINTOS 1:1 (multi-criativo) — cada anúncio ganha o
 * SEU criativo enquanto houver distinto; os slots ALÉM dos distintos ficam sem `creative` próprio e
 * herdam o `creative` padrão do spec (o melhor) no apply. Com <2 criativos distintos, nenhum ganha
 * ref própria (todos usam o padrão). PURO. (§13 DRY — mesma regra no create e no refino de contagem.)
 */
export function assignCreativesToVariants(
  baseCopy: readonly CopyVariant[],
  creatives: readonly ChosenCreative[],
): CopyVariant[] {
  if (creatives.length < 2) return [...baseCopy];
  return baseCopy.map((cv, i) => (creatives[i] ? { ...cv, creative: creativeRefOf(creatives[i]!) } : cv));
}

/**
 * Preenche os slots SEM criativo próprio com criativos DISTINTOS do pool, PRESERVANDO os slots que já
 * têm criativo escolhido explicitamente (ex: trocado no painel do site) e sem repetir mídia. Slot sem
 * distinto disponível herda o criativo padrão do spec (fica sem `creative`). Usado no aumento de
 * contagem por chat ("5 criativos diferentes"): o dono escolhe QUANTOS, a estratégia decide QUAIS, e
 * uma edição por-anúncio feita no site NUNCA é sobrescrita. PURO. Devolve também quantos slots ficaram
 * sem distinto próprio (usam o padrão) p/ a nota honesta. (§13 DRY — reusa creativeKey/creativeRefOf.)
 */
export function fillDistinctCreatives(
  variants: readonly CopyVariant[],
  primary: ChosenCreative,
  poolRefs: readonly ChosenCreative[],
): { readonly variants: CopyVariant[]; readonly withoutDistinct: number } {
  const used = new Set<string>([creativeKey(primary)]);
  for (const v of variants) if (v.creative) used.add(v.creative.metaVideoId ?? v.creative.metaImageHash ?? v.creative.assetId);
  const queue: ChosenCreative[] = [];
  for (const c of poolRefs) {
    const k = creativeKey(c);
    if (!used.has(k)) {
      used.add(k);
      queue.push(c);
    }
  }
  let qi = 0;
  const out = variants.map((v) => (v.creative ? v : queue[qi] ? { ...v, creative: creativeRefOf(queue[qi++]!) } : v));
  return { variants: out, withoutDistinct: out.filter((v) => !v.creative).length };
}

/** Contagem de anúncios pedida pelo dono, normalizada ao intervalo válido (1..MAX_ADS_PER_DRAFT). PURO. */
export function normalizeAdCount(adCount: number | undefined): number | undefined {
  if (adCount == null || !Number.isFinite(adCount)) return undefined;
  return Math.max(1, Math.min(Math.round(adCount), MAX_ADS_PER_DRAFT));
}

/** Preferência de MÍDIA que o dono pode pedir pra composição (o adapter/estratégia escolhe QUAIS). */
export const MEDIA_PREFERENCES = ["video", "image", "mixed"] as const;
export type MediaPreference = (typeof MEDIA_PREFERENCES)[number];

/** Lista compacta das copies pro eco (§8: o dono vê o que vai aprovar). Headline + 1ª linha do texto.
 *  Um bloco só (1 balão). PURO. */
export function describeCopiesBlock(variants: readonly CopyVariant[]): string {
  const lines = variants.map((v, i) => {
    const first = (v.primaryText ?? "").split("\n")[0]!.trim();
    const body = first.length > 90 ? `${first.slice(0, 90)}…` : first;
    return `${i + 1}. *${v.headline}*${body ? ` — ${body}` : ""}`;
  });
  return `Copies (${variants.length}):\n${lines.join("\n")}`;
}

/** Filtra o pool de criativos pela preferência de mídia. `video` = só vídeo (com capa); `image` =
 *  só imagem estática; `mixed`/ausente = todos. `mixed` NÃO filtra (a composição naturalmente mistura
 *  se o pool tem os dois). PURO. */
export function filterByMedia(refs: readonly ChosenCreative[], pref: MediaPreference | undefined): ChosenCreative[] {
  if (!pref || pref === "mixed") return [...refs];
  if (pref === "video") return refs.filter((c) => Boolean(c.videoId));
  return refs.filter((c) => Boolean(c.imageHash) && !c.videoId); // image estática
}

/**
 * Compõe a lista de criativos por-anúncio HONRANDO a composição pedida: `adCount` anúncios com
 * `distinctCount` criativos DISTINTOS (o resto REPETE, ciclando os distintos) — é o "2 iguais + 2
 * diferentes" (adCount 4, distinctCount 3 → [d0,d1,d2,d0], d0 repetido). `distinctList` já vem
 * deduplicado por mídia e priorizado (melhor primeiro). Distintos disponíveis < pedido → usa os que
 * há. Lista vazia → vazio (o caller cai no criativo padrão). PURO.
 */
export function composeCreatives(
  adCount: number,
  distinctCount: number,
  distinctList: readonly ChosenCreative[],
): ChosenCreative[] {
  if (distinctList.length === 0 || adCount <= 0) return [];
  const k = Math.max(1, Math.min(distinctCount, distinctList.length, adCount));
  const distinct = distinctList.slice(0, k);
  return Array.from({ length: adCount }, (_, i) => distinct[i < k ? i : i % k]!);
}

/** Rótulo PT da preferência de mídia (pro eco/nota). */
function mediaLabelPt(pref: MediaPreference): string {
  return pref === "video" ? "de vídeo" : pref === "image" ? "de imagem" : "de vídeo/imagem";
}

/**
 * Reordena o pool ALTERNANDO vídeo/imagem (v,i,v,i…) pra que os primeiros K distintos GARANTAM os dois
 * tipos quando ambos existem — "use vídeos E imagens" (mixed). Só reordenar (mixed=não-filtra) pegava os
 * K primeiros, que podiam ser todos do mesmo tipo. Devolve também se cada tipo existe (pra nota honesta). PURO.
 */
export function interleaveMedia(refs: readonly ChosenCreative[]): { ordered: ChosenCreative[]; hasVideo: boolean; hasImage: boolean } {
  const videos = refs.filter((c) => Boolean(c.videoId));
  const images = refs.filter((c) => Boolean(c.imageHash) && !c.videoId);
  const ordered: ChosenCreative[] = [];
  for (let i = 0; i < Math.max(videos.length, images.length); i++) {
    if (videos[i]) ordered.push(videos[i]!);
    if (images[i]) ordered.push(images[i]!);
  }
  return { ordered, hasVideo: videos.length > 0, hasImage: images.length > 0 };
}

/** Pool de candidatos (veiculando + biblioteca) conforme a ESTRATÉGIA do agente — mesma fonte de
 *  chooseCreative (números ao vivo + visão), reusada p/ pegar criativos DISTINTOS adicionais. */
async function buildCreativePool(
  deps: WorkerDeps,
  orgId: string,
  accountId: string,
  ref: AdAccountRef,
  strategy: CreativeSourceStrategy,
): Promise<DescribedCandidate[]> {
  const pool: DescribedCandidate[] = [];
  if (strategy.mode !== "library") pool.push(...(await describeServingCandidates(deps, orgId, accountId, ref)));
  if (strategy.mode !== "serving" || pool.length === 0) pool.push(...(await describeLibraryCandidates(deps, orgId, accountId)));
  // ENTREGÁVEL: um anúncio de VÍDEO exige capa (image_hash) no video_data — e ler o thumbnail do
  // vídeo pode falhar com o token (#10). Sem capa conhecida, o anúncio extra falharia no apply; então
  // o agente só ADICIONA extras que sabe montar: imagem sempre, vídeo só com capa. (O criativo
  // principal vem de chooseCreative, cuja capa é resolvida ao vivo em inferCreationDefaults.)
  return pool.filter((c) => !c.ref.videoId || Boolean(c.ref.imageHash));
}


/** Candidatos da BIBLIOTECA (uploads `ready`) com a DESCRIÇÃO de visão CACHEADA (feita no upload). */
async function describeLibraryCandidates(deps: WorkerDeps, orgId: string, accountId: string): Promise<DescribedCandidate[]> {
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
  if (withMedia.length === 0) return [];
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
  const resultByHash = new Map(visions.map((v) => [v.hash, v.result]));
  return withMedia.map((l) => {
    const result = resultByHash.get(hashOf.get(l.id)!);
    return {
      key: `lib:${l.id}`,
      description: describeVision(result),
      ...visionSignalsOf(result),
      ref: {
        ...(l.imageHash ? { imageHash: l.imageHash } : {}),
        ...(l.videoId ? { videoId: l.videoId } : {}),
        assetId: l.id,
        origin: "upload",
        source: "library",
      },
    };
  });
}

/** Candidatos VEICULANDO (X mais recentes de `ad_creatives`) com DESCRIÇÃO de visão cache-read-through:
 *  hit reusa o cache dos runs; MISS computa fresh (auto-cacheia) — imagem usa o url guardado, vídeo
 *  busca frames ao vivo (só o que falta, teto `SERVING_PICK_CANDIDATES`). Sem visão → copy (nunca mudo).
 *  ESCOPO (pivô saúde): ao contrário do caminho determinístico `best_performing` (`isSourceFatigued`
 *  em `chooseCreative`), este pool NÃO filtra criativo fatigado — o matcher LLM (`serving.agent`/
 *  `library`/`both`) ainda pode escolher um anúncio cansado. Não é esquecimento: é o próximo passo já
 *  planejado (plano do pivô saúde, decisão 7/S4c — "matcher recebe sinais de qualidade como contexto"),
 *  que depende do vision schema ganhar `persuasionSignals`/`weak_creative` antes de estender o filtro
 *  pra cá. */
async function describeServingCandidates(deps: WorkerDeps, orgId: string, accountId: string, ref: AdAccountRef): Promise<DescribedCandidate[]> {
  const rows = await deps.db
    .select({
      adId: adCreatives.adId,
      creativeId: adCreatives.creativeId,
      videoId: adCreatives.videoId,
      imageHash: adCreatives.imageHash,
      imageUrl: adCreatives.imageUrl,
      thumbnailUrl: adCreatives.thumbnailUrl,
      body: adCreatives.body,
      title: adCreatives.title,
      callToAction: adCreatives.callToAction,
    })
    .from(adCreatives)
    .where(and(eq(adCreatives.orgId, orgId), eq(adCreatives.adAccountId, accountId)))
    .orderBy(desc(adCreatives.capturedAt))
    .limit(SERVING_PICK_CANDIDATES);
  const usable = rows.filter((r) => r.creativeId && (r.imageHash || r.videoId));
  if (usable.length === 0) return [];

  // pré-computa a chave de visão de cada candidato e lê TODAS as descrições cacheadas numa ÚNICA
  // query (hit reusa o cache dos runs) — sem N+1 no turno de chat, espelhando a biblioteca.
  const keyed = usable.map((r) => {
    const copy = [r.title, r.body, r.callToAction].filter(Boolean).join(" ") || undefined;
    return { r, copy, contentHash: servingVisionKey(r.creativeId!, r.videoId, copy) };
  });
  const cachedRows = await deps.db
    .select({ hash: creativeVisionAnalyses.contentHash, result: creativeVisionAnalyses.result })
    .from(creativeVisionAnalyses)
    .where(
      and(
        inArray(creativeVisionAnalyses.contentHash, [...new Set(keyed.map((k) => k.contentHash))]),
        eq(creativeVisionAnalyses.analyzerVersion, deps.visionAnalyzerVersion),
      ),
    );
  const cachedByHash = new Map(cachedRows.map((v) => [v.hash, v.result]));

  const vision = createVisionResolver({
    db: deps.db,
    llm: deps.ports.llm,
    model: deps.analysis.visionModel,
    analyzerVersion: deps.visionAnalyzerVersion,
    logger: deps.logger,
  });

  const out: DescribedCandidate[] = [];
  for (const { r, copy, contentHash } of keyed) {
    const wasCached = cachedByHash.has(contentHash);
    let visionResult: unknown = wasCached ? cachedByHash.get(contentHash) : undefined;
    let description = wasCached ? describeVision(visionResult) : "";
    if (!wasCached) {
      // MISS: monta a mídia e computa fresh (auto-cacheia). Imagem = url guardado; vídeo = frames ao vivo.
      let imageUrls: string[] = [];
      if (r.videoId) {
        try {
          imageUrls = await deps.ports.ads.getVideoFrames(ref, r.videoId);
        } catch {
          /* sem frames → cai no fallback de copy */
        }
      } else if (r.imageUrl ?? r.thumbnailUrl) {
        imageUrls = [(r.imageUrl ?? r.thumbnailUrl)!];
      }
      if (imageUrls.length > 0) {
        const result = await vision.resolve({ creativeId: r.creativeId!, imageUrls, contentHash, ...(copy ? { copy } : {}) });
        if (result) {
          description = describeVision(result);
          visionResult = result;
        }
      }
    }
    if (!description) description = copy ? `Anúncio que já veicula. Texto: ${copy}` : "Anúncio que já veicula.";
    out.push({
      key: `srv:${r.adId}`,
      description,
      ...visionSignalsOf(visionResult),
      ref: {
        ...(r.imageHash ? { imageHash: r.imageHash } : {}),
        ...(r.videoId ? { videoId: r.videoId } : {}),
        assetId: r.adId,
        origin: "reuse",
        source: "serving",
      },
    });
  }
  return out;
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

/** Sinais de qualidade da visão cacheada (S4c) — contexto extra pro matcher, nunca critério sozinho. */
function visionSignalsOf(result: unknown): {
  proofStrength?: "weak" | "medium" | "strong";
  persuasionSignals?: number;
  weaknesses?: readonly string[];
} {
  const r = (result ?? {}) as { proofStrength?: "weak" | "medium" | "strong"; persuasionSignals?: number; weaknesses?: readonly string[] };
  return {
    ...(r.proofStrength ? { proofStrength: r.proofStrength } : {}),
    ...(typeof r.persuasionSignals === "number" ? { persuasionSignals: r.persuasionSignals } : {}),
    ...(r.weaknesses && r.weaknesses.length > 0 ? { weaknesses: r.weaknesses } : {}),
  };
}

/** Criar do zero reusando o criativo/página/pixel da conta + copy gerada. */
export async function proposeCreateCampaign(
  deps: WorkerDeps,
  ctx: DraftProposalContext,
  args: {
    readonly goal?: ConversionGoal;
    readonly budgetReais?: number;
    readonly forcedCreativeAssetId?: string;
    /** públicos DESCRITOS pelo dono (nome/descrição) — resolvidos determinístico p/ id. */
    readonly includeAudiences?: readonly string[];
    readonly excludeAudiences?: readonly string[];
    /** geo/idade/gênero EXPLÍCITOS (Fase 1, subfatia 3a) — nomes de lugar resolvidos p/ id real. */
    readonly geo?: readonly string[];
    readonly ageMin?: number;
    readonly ageMax?: number;
    readonly gender?: "all" | "men" | "women";
    /** interesses EXPLÍCITOS (Fase 2, subfatia 4) — nomes/termos resolvidos p/ id real na Meta. */
    readonly interests?: readonly string[];
    /** comportamentos EXPLÍCITOS (Slice 4) — nomes resolvidos p/ id real (catálogo da Meta). */
    readonly behaviors?: readonly string[];
    /** raio (km) em torno das CIDADES indicadas (Slice 5) — clampado 17–80 km. */
    readonly radiusKm?: number;
    /** raio em torno de ENDEREÇOS de rua (Slice 5) — a Meta geocodifica; clampado 1–80 km. */
    readonly addressAreas?: readonly AddressArea[];
    /** nº de ANÚNCIOS pedido pelo dono (chat/site) — o agente escolhe N criativos distintos pela
     *  estratégia; extras (sem distinto) repetem o melhor. Clampado 1..MAX_ADS_PER_DRAFT. */
    readonly adCount?: number;
    /** COMPOSIÇÃO de criativo (Fatia 8): quantos criativos DISTINTOS entre os anúncios (o resto
     *  repete). Ex: 4 anúncios com 3 distintos = "2 iguais + 2 diferentes". O agente escolhe QUAIS. */
    readonly distinctCreatives?: number;
    /** preferência de MÍDIA da composição — "video" | "image" | "mixed". O agente escolhe os assets. */
    readonly mediaPreference?: MediaPreference;
  },
  origin: DraftOrigin = "on_demand",
  opts: { readonly autonomous?: boolean; readonly minMonthlyReach?: number; readonly requireResolvedAudience?: boolean } = {},
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

  // AUTÔNOMO (proativo, Fatia 8): ambíguo/inexistente é DESCARTADO (nunca pergunta — não há humano
  // no loop) e anotado no eco/rationale. Interativo (chat): ambíguo→pergunta, como sempre.
  const auto = opts.autonomous === true;
  const aud = await prepareAudiences(deps, ctx, ac.ref, args.includeAudiences ?? [], args.excludeAudiences ?? [], auto);
  if (aud.kind === "blocked") return { kind: "blocked", reason: aud.reason };
  // Autônomo que EXIGE público específico (ex: remarketing): se nenhum público de inclusão resolveu,
  // NÃO cria amplo às cegas (perderia a intenção + mentiria no nudge) — degrada pra recomendação humana.
  if (auto && opts.requireResolvedAudience && aud.includeIds.length === 0) {
    return { kind: "blocked", reason: PROACTIVE_AUDIENCE_UNRESOLVED_REASON };
  }
  const geoPrep = await prepareGeo(deps, ac.ref, args.geo ?? [], auto);
  if (geoPrep.kind === "blocked") return { kind: "blocked", reason: geoPrep.reason };
  const interestPrep = await prepareInterests(deps, ac.ref, args.interests ?? [], auto);
  if (interestPrep.kind === "blocked") return { kind: "blocked", reason: interestPrep.reason };
  const behaviorPrep = await prepareBehaviors(deps, ac.ref, args.behaviors ?? [], auto);
  if (behaviorPrep.kind === "blocked") return { kind: "blocked", reason: behaviorPrep.reason };
  const droppedNames = [...aud.dropped, ...geoPrep.dropped, ...interestPrep.dropped, ...behaviorPrep.dropped];
  // raio (Slice 5): aplica às cidades resolvidas + monta áreas por endereço (clampado + notas).
  const geoRadius = applyCityRadius(geoPrep.geo, args.radiusKm);
  const areas = buildRadiusAreas(args.addressAreas);
  const hasExplicitPrimitive =
    geoPrep.geo.length > 0 ||
    args.ageMin !== undefined ||
    args.ageMax !== undefined ||
    (args.gender && args.gender !== "all") ||
    interestPrep.interests.length > 0 ||
    behaviorPrep.interests.length > 0 ||
    areas.radiusAreas.length > 0;

  const defaults = await deps.ports.ads.inferCreationDefaults(ac.ref);
  const goal = args.goal ?? defaults.objectiveGoal ?? DEFAULT_CONVERSION_GOAL;
  // Criativo: FORÇADO (o que o usuário mandou no WhatsApp, Slice 7) OU pool único — melhor
  // veiculando (provado) OU, sem nenhum, o upload da biblioteca que MELHOR CASA com o contexto
  // (objetivo + negócio + orientações) via matcher LLM barato.
  const chosen = args.forcedCreativeAssetId
    ? await loadForcedCreative(deps, ctx.orgId, ctx.adAccountId, args.forcedCreativeAssetId)
    : await chooseCreative(
        deps,
        ctx.orgId,
        ctx.adAccountId,
        ctx.agentId,
        ac.ref,
        {
          ...(defaults.imageHash ? { imageHash: defaults.imageHash } : {}),
          ...(defaults.videoId ? { videoId: defaults.videoId } : {}),
          ...(defaults.sourceAdId ? { sourceAdId: defaults.sourceAdId } : {}),
        },
        ac.creativeSource,
        { goal, businessContext: ac.businessContext, guidance: ac.guidance, model: ac.model },
      );
  // Página é obrigatória (object_story_spec). Vem do anúncio veiculando; conta sem NENHUM
  // anúncio não tem página inferível — nesse caso nem um upload da biblioteca cria (falta a Page).
  if (!defaults.pageId || !chosen) {
    // criativo JÁ resolvido (ex: o usuário mandou um no WhatsApp) mas falta a Página → a mensagem
    // de "me manda um criativo" confundiria; o bloqueio real é a Página, que vem de um anúncio ativo.
    if (chosen && !defaults.pageId) {
      return {
        kind: "blocked",
        reason: "recebi o criativo, mas essa conta ainda não tem uma Página de onde eu monte o anúncio — ela vem de um anúncio ativo. Conecte uma conta com anúncios (ou publique um) que eu crio a campanha.",
      };
    }
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
  // Transparência do teto (§8 clareza pro dono): pediu mais que o teto de gasto novo →
  // o eco/card mostram "pediu X, virou Y" (mesmo helper/campo do escalar).
  const { dailyBudgetMinor, clampedByCap } = clampNewBudget(requested, ac.cfg.maxNewDailyBudgetMinor);

  // COMPOSIÇÃO de criativo (Fatia 7/8): o agente monta N anúncios (adCount) com uma COMPOSIÇÃO pedida
  // — quantos DISTINTOS vs repetidos (distinctCreatives, ex: "2 iguais + 2 diferentes") e a mídia
  // (mediaPreference: vídeo/imagem/misto). O agente escolhe QUAIS criativos (estratégia); o usuário
  // troca o asset específico no site. Criativo forçado (WhatsApp) = anúncio único (comportamento antigo).
  const requestedAdCount = args.forcedCreativeAssetId ? undefined : normalizeAdCount(args.adCount);
  const compositionNotes: string[] = [];
  // pool DISTINTO priorizado (o melhor `chosen` primeiro), deduplicado por mídia, filtrado por preferência.
  const poolRefs = args.forcedCreativeAssetId
    ? []
    : (await buildCreativePool(deps, ctx.orgId, ctx.adAccountId, ac.ref, ac.creativeSource)).map((c) => c.ref);
  const seenKey = new Set<string>();
  let distinctList = [chosen, ...poolRefs].filter((c) => (seenKey.has(creativeKey(c)) ? false : (seenKey.add(creativeKey(c)), true)));
  if (args.mediaPreference === "video" || args.mediaPreference === "image") {
    const filtered = filterByMedia(distinctList, args.mediaPreference);
    if (filtered.length === 0) compositionNotes.push(`Não achei criativo ${mediaLabelPt(args.mediaPreference)} pra reusar — usei os criativos que a conta tem. Você troca cada um no site.`);
    else distinctList = filtered;
  } else if (args.mediaPreference === "mixed") {
    // "vídeos E imagens" → GARANTE os dois tipos entre os distintos (alterna); avisa se só há um tipo.
    const mixed = interleaveMedia(distinctList);
    distinctList = mixed.ordered;
    if (!(mixed.hasVideo && mixed.hasImage)) compositionNotes.push(`Você pediu vídeos e imagens, mas a conta só tem ${mixed.hasVideo ? "vídeos" : "imagens"} reusáveis — usei o que há. Você troca cada um no site.`);
  }
  // targetVariants: adCount pedido vence; senão, multi só quando há ≥2 distintos (senão o padrão de copy).
  const targetVariants = args.forcedCreativeAssetId
    ? DEFAULT_VARIANTS
    : (requestedAdCount ?? (distinctList.length >= 2 ? Math.min(distinctList.length, AGENT_MAX_CREATIVE_ADS) : DEFAULT_VARIANTS));
  // distintos desejados: pedido explícito (clampado) OU todos distintos (padrão).
  const distinctWanted = args.distinctCreatives != null ? Math.max(1, Math.min(args.distinctCreatives, targetVariants)) : targetVariants;
  const perAd = args.forcedCreativeAssetId ? [] : composeCreatives(targetVariants, distinctWanted, distinctList);
  // nota honesta (§8) quando não há criativos distintos suficientes pra composição pedida.
  if (args.distinctCreatives != null && distinctList.length < distinctWanted) {
    compositionNotes.push(`Você pediu ${distinctWanted} criativos distintos, mas a conta só tem ${distinctList.length}${args.mediaPreference && args.mediaPreference !== "mixed" ? ` de ${mediaLabelPt(args.mediaPreference)}` : ""} — repeti pra completar os ${targetVariants} anúncios. Você troca cada um no site.`);
  }

  const baseCopy: CopyVariant[] = await generateCopy(
    deps.ports.llm,
    {
      model: ac.model,
      goal,
      variantsCount: targetVariants,
      businessContext: ac.businessContext,
      guidance: ac.guidance,
      // aterramento no que já performa (§7): a copy dos melhores anúncios veiculando.
      ...(defaults.winnerCopy ? { winnerCopy: defaults.winnerCopy } : {}),
    },
    { orgId: ctx.orgId, adAccountId: ctx.adAccountId },
  );
  // cada anúncio ganha SEU criativo (1:1 com a copy), honrando a composição; forced/1-criativo →
  // herdam o padrão. Fonte única da regra (§13): `assignCreativesToVariants`.
  const copyVariants: CopyVariant[] = assignCreativesToVariants(baseCopy, perAd);
  // RECONCILIA: generateCopy pode devolver MENOS que o pedido (filter/slice) → o nº real é o do
  // array (evita spec.variantsCount ≠ copyVariants.length + eco prometendo variações que não existem).
  const variantsCount = copyVariants.length;
  // nº de criativos DISTINTOS de fato entre os anúncios (pro eco honesto de composição).
  const distinctUsed = new Set(copyVariants.map((v) => v.creative?.metaVideoId ?? v.creative?.metaImageHash ?? "default")).size;

  // Criativo LÍDER (padrão do rascunho) = 1º da composição — RESPEITA mediaPreference (que pode ter
  // filtrado o `chosen` cross-mídia); anúncio ÚNICO herda este padrão em vez do `chosen` da mídia
  // errada (correção do achado do reviewer §8: pediu vídeo, não recebe imagem em silêncio). Forced/
  // sem pool → perAd vazio → cai no `chosen`.
  const leadCreative = perAd[0] ?? chosen;
  const reuseImageHash = leadCreative.imageHash;
  const reuseVideoId = leadCreative.videoId;
  // VÍDEO se tem video_id (o imageHash acompanha como CAPA do vídeo, não descaracteriza). Anúncio de
  // imagem tem imageHash e NÃO tem videoId → o videoId é o discriminador correto.
  const isVideo = Boolean(reuseVideoId);
  // público específico (sem fonte — geo amplo + o público) quando o dono indicou; senão a estratégia padrão.
  const hasAudience = aud.includeIds.length > 0 || aud.excludeIds.length > 0;
  // P0.2/P1: reuse_adset resolve+cacheia o público REAL da fonte AGORA (não só no apply) — o eco
  // mostra cidades/idade/expansão de verdade, e a leitura falhar BLOQUEIA em vez de virar
  // Advantage+ silencioso depois de já ter prometido "o público que já converte".
  let audienceProfile: AudienceProfile | null = null;
  let targeting: NonNullable<CampaignDraftSpec["targeting"]>;
  if (hasExplicitPrimitive || hasAudience) {
    // COMPÕE, não escolhe (reanálise crítica do plano): geo/idade/gênero/interesses explícitos +
    // público salvo (quando indicado) entram no MESMO `explicit` (kind SUPERSET — colapso do antigo
    // `custom_audiences`). Só público salvo (sem primitivo) = geo amplo (BR) + o público. A montagem
    // é PURA e compartilhada (`assembleExplicitTargeting`) — mesma fonte usada pela edição de público.
    targeting = assembleExplicitTargeting({
      geo: geoRadius.geo,
      ...(areas.radiusAreas.length > 0 ? { radiusAreas: areas.radiusAreas } : {}),
      ...(args.ageMin !== undefined ? { ageMin: args.ageMin } : {}),
      ...(args.ageMax !== undefined ? { ageMax: args.ageMax } : {}),
      ...(args.gender ? { gender: args.gender } : {}),
      interests: interestPrep.interests,
      behaviors: behaviorPrep.interests,
      includeAudienceIds: aud.includeIds,
      excludeAudienceIds: aud.excludeIds,
    });
  } else {
    const baseTargeting = resolveCreationTargeting(defaults);
    if (baseTargeting.kind === "reuse_adset") {
      audienceProfile = await deps.ports.ads.getAudienceProfile(ac.ref, baseTargeting.sourceAdsetId);
      if (!audienceProfile) {
        return { kind: "blocked", reason: "não consegui ler o público da fonte agora — não vou herdar às cegas. Tenta de novo em instantes." };
      }
    }
    targeting = baseTargeting.kind === "reuse_adset" && audienceProfile ? { ...baseTargeting, resolved: buildResolvedSnapshot(audienceProfile) } : baseTargeting;
  }
  const spec: CampaignDraftSpec = {
    version: 1,
    currency: ac.currency,
    dailyBudgetMinor,
    ...(clampedByCap ? { requestedDailyBudgetMinor: requested } : {}),
    activation: ac.creationActivation,
    objective: goal,
    targeting,
    variantsCount,
    copyVariants,
    creative: {
      assetId: leadCreative.assetId,
      format: isVideo ? "video" : "image",
      origin: leadCreative.origin,
      ...(reuseImageHash ? { metaImageHash: reuseImageHash } : {}),
      ...(reuseVideoId ? { metaVideoId: reuseVideoId } : {}),
    },
    pageId: defaults.pageId,
    ...(defaults.pixelId ? { pixelId: defaults.pixelId } : {}),
    ...(defaults.linkUrl ? { linkUrl: defaults.linkUrl } : {}),
  };
  // Piso de alcance (Fatia 8): no AUTÔNOMO, não cria (nem propõe) público estreito demais — degrada
  // honesto pra revisão humana. Best-effort: estimativa indisponível NÃO bloqueia (não inventa risco).
  if (auto && opts.minMonthlyReach != null && (await reachBelowFloor(deps, ac.ref, targeting, goal, opts.minMonthlyReach, defaults.pixelId))) {
    return { kind: "blocked", reason: PROACTIVE_REACH_FLOOR_REASON };
  }
  const { draftId, approvalId } = await persistDraftAndApproval(deps, ctx, "from_scratch", spec, origin);
  // eco honesto sobre a FONTE do criativo (veiculando/provado × biblioteca) e do PÚBLICO
  // (herdado de um adset provado × amplo/Advantage+ no cold-start).
  const creativeSourcePhrase =
    leadCreative.source === "serving"
      ? "reusando o criativo que melhor performa na sua conta"
      : "reusando um criativo da sua biblioteca (você não tem anúncio ativo pra eu comparar desempenho)";
  const audienceSourcePhrase =
    spec.targeting?.kind === "reuse_adset" ? " e o público que já converte" : spec.targeting?.kind === "explicit" ? " pro público que você indicou" : "";
  // Transparência (§clareza pro dono): se o #1 por desempenho for um formato que ainda não sei
  // clonar (carrossel/catálogo), avisa que peguei o melhor de imagem/vídeo no lugar.
  // eco do nº de anúncios + COMPOSIÇÃO real (§8): descreve distintos vs repetidos de fato, não uma
  // promessa genérica ("criativos distintos") que pode não bater com o que o dono pediu.
  const repeats = variantsCount - distinctUsed;
  const adsPhrase =
    variantsCount >= 2 && distinctUsed >= 2
      ? `montando **${variantsCount} anúncios** (${distinctUsed} criativo(s) distinto(s)${repeats > 0 ? `, ${repeats} repetido(s)` : ""} + copy própria)`
      : variantsCount >= 2
        ? `montando **${variantsCount} anúncios** (mesmo criativo, copy própria em cada)`
        : `e ${variantsCount} variações de copy novas (baseadas no que já converte)`;
  const lines = [
    `Vou **criar uma campanha de ${goal}** ${creativeSourcePhrase}${audienceSourcePhrase}, ${adsPhrase}.`,
  ];
  for (const n of compositionNotes) lines.push(n);
  lines.push(describeCopiesBlock(copyVariants));
  if (defaults.unsupportedTopFormat) {
    lines.push(`Obs: seu anúncio de melhor desempenho é um **${unsupportedFormatPt(defaults.unsupportedTopFormat)}**, que eu ainda não sei clonar — então usei o melhor criativo de imagem/vídeo que você tem.`);
  }
  const budgetPhrase = clampedByCap
    ? `${money(dailyBudgetMinor / MINOR_PER_UNIT, ac.currency)}/dia (você pediu ${money(requested / MINOR_PER_UNIT, ac.currency)}, mas seu teto de gasto novo é ${money(dailyBudgetMinor / MINOR_PER_UNIT, ac.currency)})`
    : `${money(dailyBudgetMinor / MINOR_PER_UNIT, ac.currency)}/dia`;
  const audiencePhrase = audienceEchoPhrase({
    targetingKind: spec.targeting?.kind,
    ...(audienceProfile ? { resolvedAudienceDescription: describeResolvedAudience(audienceProfile) } : {}),
    ...(spec.targeting?.kind === "explicit" ? { explicitAudienceDescription: describeExplicitAudience(spec.targeting) } : {}),
  });
  lines.push(
    `Público: ${audiencePhrase}.`,
    `Gasto novo: ${budgetPhrase} · Página: ${defaults.pageId}${defaults.pixelId ? ` · Pixel: ${defaults.pixelId}` : ""} · ${activationPhrase(spec.activation)}.`,
  );
  for (const n of aud.notes) lines.push(n);
  for (const n of [...geoRadius.notes, ...areas.notes]) lines.push(n);
  if (droppedNames.length > 0) lines.push(`Deixei de fora (não achei ou ambíguo na conta): ${droppedNames.join(", ")}.`);
  // alcance combinado (delivery_estimate ao vivo) quando o dono indicou público; superior ao
  // por-público → substitui o `sizeWarnings`, que fica de fallback quando a estimativa não vem.
  const reachNote = hasAudience || hasExplicitPrimitive ? await reachNoteFor(deps, ac.ref, targeting, goal, defaults.pixelId) : null;
  if (reachNote) lines.push(reachNote);
  else for (const w of aud.sizeWarnings) lines.push(w);
  lines.push(`Confirma? (você pode trocar o criativo no site antes de aprovar)`);
  return { kind: "draft", echo: joinBalloons(lines), approvalId, draftId };
}

/**
 * Resolve uma OFERTA de criativo (Slice 7 — ponte estado→turno): o usuário mandou um criativo no
 * WhatsApp e disse "sim". Com rascunho pendente → TROCA o criativo dele (segue aguardando aprovação);
 * sem rascunho → propõe CRIAR uma campanha semeada com o criativo. Devolve a resposta pronta pro chat.
 */
export async function applyOfferedCreative(
  deps: WorkerDeps,
  ctx: DraftProposalContext,
  offer: { readonly assetId: string; readonly draftId?: string },
): Promise<string> {
  if (offer.draftId) {
    const [asset] = await deps.db
      .select({
        format: creativeAssets.format,
        origin: creativeAssets.origin,
        status: creativeAssets.status,
        metaImageHash: creativeAssets.metaImageHash,
        metaVideoId: creativeAssets.metaVideoId,
      })
      .from(creativeAssets)
      .where(
        and(
          eq(creativeAssets.id, offer.assetId),
          eq(creativeAssets.orgId, ctx.orgId),
          eq(creativeAssets.adAccountId, ctx.adAccountId),
          isNull(creativeAssets.archivedAt),
        ),
      )
      .limit(1);
    if (!asset || asset.status !== "ready") return "esse criativo ainda não está pronto — me manda de novo daqui a pouco.";
    const [row] = await deps.db
      .select({ spec: campaignDrafts.spec, kind: campaignDrafts.kind, status: campaignDrafts.status })
      .from(campaignDrafts)
      .where(
        and(
          eq(campaignDrafts.id, offer.draftId),
          eq(campaignDrafts.orgId, ctx.orgId),
          eq(campaignDrafts.adAccountId, ctx.adAccountId),
        ),
      )
      .limit(1);
    if (!row || row.status !== "proposed" || row.kind !== "from_scratch") {
      return "esse rascunho não está mais aberto pra troca — mas guardei o criativo na sua biblioteca.";
    }
    const spec = row.spec as CampaignDraftSpec;
    const creative: CreativeAssetRef = {
      assetId: offer.assetId,
      format: asset.format,
      origin: asset.origin,
      ...(asset.metaImageHash ? { metaImageHash: asset.metaImageHash } : {}),
      ...(asset.metaVideoId ? { metaVideoId: asset.metaVideoId } : {}),
    };
    // Grava pelo núcleo compartilhado (UPDATE GUARDADO por status): fecha a corrida com o apply
    // virando `creating` entre a leitura e este write — sem sobrescrever um rascunho já em voo.
    const persisted = await persistDraftSpec(
      deps.db,
      { orgId: ctx.orgId, draftId: offer.draftId, adAccountId: ctx.adAccountId },
      { ...spec, creative },
    );
    if (!persisted) return "esse rascunho não está mais aberto pra troca — mas guardei o criativo na sua biblioteca.";
    return "Troquei o criativo do rascunho pra esse que você mandou. Ele segue aguardando sua aprovação — é só aprovar quando quiser.";
  }

  const proposal = await proposeCreateCampaign(deps, ctx, { forcedCreativeAssetId: offer.assetId }, "on_demand");
  if (proposal.kind === "draft") return proposal.echo;
  if (proposal.kind === "blocked") return proposal.reason;
  return "não consegui montar a campanha agora — tenta de novo em instantes.";
}

/**
 * CÓPIA FIEL de uma campanha específica (Fatia 7): lê a estrutura ESCOPADA à campanha-base
 * (CBO/ABO, objetivo, N criativos, geo/idade) — NÃO account-wide — e monta um rascunho que
 * reusa os criativos por REFERÊNCIA (preserva destino WhatsApp), trocando só o público quando
 * pedido. Nasce PAUSADA. Objetivo divergente = para e explica (§7). Refino via adjust_draft.
 */
export async function proposeCopyCampaign(
  deps: WorkerDeps,
  ctx: DraftProposalContext,
  args: {
    readonly sourceCampaignId: string;
    readonly sourceName?: string;
    /** públicos DESCRITOS pelo dono (nome/descrição) — resolvidos determinístico p/ id. */
    readonly includeAudiences?: readonly string[];
    readonly excludeAudiences?: readonly string[];
    readonly budgetReais?: number;
    readonly goal?: ConversionGoal;
    /** geo/idade/gênero EXPLÍCITOS pra TROCAR os da original (Fase 1, subfatia 3a) — quando
     *  ausentes, mantém o da campanha-base. */
    readonly geo?: readonly string[];
    readonly ageMin?: number;
    readonly ageMax?: number;
    readonly gender?: "all" | "men" | "women";
    /** interesses EXPLÍCITOS pra TROCAR os da original (Slice 6) — quando ausentes, a cópia HERDA os
     *  interesses da fonte (com id, via `interestGroupRefs`/snapshot); passar aqui SUBSTITUI. */
    readonly interests?: readonly string[];
    /** comportamentos EXPLÍCITOS pra TROCAR (Slice 4) — mesma regra dos interesses na cópia. */
    readonly behaviors?: readonly string[];
    /** raio (km) nas cidades (Slice 5) + raio por endereço (clampados). */
    readonly radiusKm?: number;
    readonly addressAreas?: readonly AddressArea[];
    /** nº de ANÚNCIOS pedido — a cópia reusa os anúncios da base; adCount RECORTA quantos reusar
     *  (não inventa além do que a base tem). Clampado 1..(nº de anúncios da base). */
    readonly adCount?: number;
  },
  origin: DraftOrigin = "on_demand",
  opts: { readonly autonomous?: boolean; readonly minMonthlyReach?: number } = {},
): Promise<ChatDraftProposal> {
  const ac = await loadAgentContext(deps, ctx);
  if (!ac) return { kind: "blocked", reason: "não consegui acessar a conta agora" };
  if (!ac.enabled.has("create_campaign")) {
    return { kind: "blocked", reason: "criar/copiar campanha está desligado para este agente (ligue em ações permitidas)" };
  }

  // AUTÔNOMO (proativo): descarta+anota o não-resolvido; interativo: ambíguo→pergunta.
  const auto = opts.autonomous === true;
  const aud = await prepareAudiences(deps, ctx, ac.ref, args.includeAudiences ?? [], args.excludeAudiences ?? [], auto);
  if (aud.kind === "blocked") return { kind: "blocked", reason: aud.reason };
  const geoPrep = await prepareGeo(deps, ac.ref, args.geo ?? [], auto);
  if (geoPrep.kind === "blocked") return { kind: "blocked", reason: geoPrep.reason };
  const interestPrep = await prepareInterests(deps, ac.ref, args.interests ?? [], auto);
  if (interestPrep.kind === "blocked") return { kind: "blocked", reason: interestPrep.reason };
  const behaviorPrep = await prepareBehaviors(deps, ac.ref, args.behaviors ?? [], auto);
  if (behaviorPrep.kind === "blocked") return { kind: "blocked", reason: behaviorPrep.reason };
  const droppedNames = [...aud.dropped, ...geoPrep.dropped, ...interestPrep.dropped, ...behaviorPrep.dropped];
  const areas = buildRadiusAreas(args.addressAreas);
  const hasExplicitPrimitive =
    geoPrep.geo.length > 0 ||
    args.ageMin !== undefined ||
    args.ageMax !== undefined ||
    (args.gender && args.gender !== "all") ||
    interestPrep.interests.length > 0 ||
    behaviorPrep.interests.length > 0 ||
    args.radiusKm !== undefined ||
    areas.radiusAreas.length > 0;

  let structure;
  try {
    structure = await deps.ports.ads.readCampaignStructure(ac.ref, args.sourceCampaignId);
  } catch {
    return { kind: "blocked", reason: "não consegui ler a estrutura dessa campanha na Meta agora — tenta de novo em instantes" };
  }
  if (structure.creativeRefs.length === 0) {
    return { kind: "blocked", reason: "essa campanha não tem anúncios que eu consiga reusar pra copiar — confere se ela tem anúncios ativos" };
  }
  // adCount na cópia = RECORTE (a cópia reusa os anúncios da base; não inventa criativo novo). Pediu
  // menos → recorta; pediu mais que a base tem → copia todos + nota honesta (§8).
  const requestedAdCount = normalizeAdCount(args.adCount);
  const creativeRefs =
    requestedAdCount != null ? structure.creativeRefs.slice(0, Math.min(requestedAdCount, structure.creativeRefs.length)) : structure.creativeRefs;
  const adCountNote =
    requestedAdCount != null && requestedAdCount > structure.creativeRefs.length
      ? `Você pediu ${requestedAdCount} anúncios, mas "${args.sourceName ?? structure.name}" só tem ${structure.creativeRefs.length} — copiei os ${structure.creativeRefs.length}. Pra somar mais, dá pra criar do zero (aí eu escolho criativos da conta).`
      : null;

  // Parar e explicar (§7): trocar o objetivo muda o mecanismo (pode perder o destino WhatsApp
  // / exigir formulário). Não cria silenciosamente o oposto.
  if (args.goal && args.goal !== structure.objective) {
    return {
      kind: "blocked",
      reason: `essa campanha otimiza *${goalNounPt(structure.objective)}* — copiar como *${goalNounPt(args.goal)}* trocaria o mecanismo (pode perder o destino de WhatsApp e exigir outra configuração). Pra manter fiel eu copio com o mesmo objetivo (${goalNounPt(structure.objective)}); se você quer mesmo o outro objetivo, aí é criar uma campanha nova do zero. Como prefere?`,
    };
  }

  const goal = structure.objective;
  const hasAudience = aud.includeIds.length > 0 || aud.excludeIds.length > 0;
  // P0.2 (subfatia 2): structure.targeting JÁ é o AudienceProfile da fonte (readCampaignStructure
  // leu — sem chamada extra); só falta cachear+ecoar. Diferente de proposeCreateCampaign, aqui a
  // leitura já bloqueou lá em cima (try/catch de readCampaignStructure) se tivesse falhado.
  const resolvedSnapshot = buildResolvedSnapshot(structure.targeting);
  // Colapso (Slice 1): trocar o público na cópia = `explicit` com a geo/idade da fonte reconstruída
  // em chips (flattenSnapshotGeo — representável: países/regiões/cidades) + o público salvo trocado.
  // Sem troca de público = reuse_adset fiel (com retrato). Raio (Slice 5) aplica ao geo escolhido.
  const geoBase = geoPrep.geo.length > 0 ? geoPrep.geo : flattenSnapshotGeo(resolvedSnapshot.geo);
  const geoRadius = applyCityRadius(geoBase, args.radiusKm);
  const targeting: NonNullable<CampaignDraftSpec["targeting"]> =
    hasExplicitPrimitive || hasAudience
      ? {
          kind: "explicit",
          geo: geoRadius.geo,
          ...(areas.radiusAreas.length > 0 ? { radiusAreas: areas.radiusAreas } : {}),
          ...(args.ageMin !== undefined ? { ageMin: args.ageMin } : resolvedSnapshot.ageMin !== undefined ? { ageMin: resolvedSnapshot.ageMin } : {}),
          ...(args.ageMax !== undefined ? { ageMax: args.ageMax } : resolvedSnapshot.ageMax !== undefined ? { ageMax: resolvedSnapshot.ageMax } : {}),
          ...(args.gender === "men" ? { genders: [1] } : args.gender === "women" ? { genders: [2] } : {}),
          // Slice 6: sobrescreveu → usa o novo; senão HERDA os grupos da fonte (com id, do snapshot) —
          // a cópia fiel não perde mais interesses/comportamentos ao virar explicit.
          ...(interestPrep.interests.length > 0 ? { interestGroups: [interestPrep.interests] } : resolvedSnapshot.interestGroups && resolvedSnapshot.interestGroups.length > 0 ? { interestGroups: resolvedSnapshot.interestGroups } : {}),
          ...(behaviorPrep.interests.length > 0 ? { behaviorGroups: [behaviorPrep.interests] } : resolvedSnapshot.behaviorGroups && resolvedSnapshot.behaviorGroups.length > 0 ? { behaviorGroups: resolvedSnapshot.behaviorGroups } : {}),
          ...(hasAudience ? { customAudienceIncludeIds: aud.includeIds, customAudienceExcludeIds: aud.excludeIds } : {}),
        }
      : { kind: "reuse_adset", sourceAdsetId: structure.sourceAdsetId, resolved: resolvedSnapshot };

  // Budget da cópia é sempre DIÁRIO (o create só escreve daily). Fonte com budget DIÁRIO →
  // reusa; fonte VITALÍCIA → NÃO trata o total como diário (overspend); usa um diário inicial
  // seguro e avisa. Override explícito do usuário sempre vence.
  const sourceIsLifetime = structure.dailyBudgetMinor === undefined && structure.lifetimeBudgetMinor !== undefined;
  const sourceDailyMinor = structure.dailyBudgetMinor ?? DEFAULT_STARTER_BUDGET_MINOR;
  const requested = args.budgetReais ? Math.round(args.budgetReais * MINOR_PER_UNIT) : sourceDailyMinor;
  const cap = ac.cfg.maxNewDailyBudgetMinor;
  const dailyBudgetMinor = cap != null ? Math.min(requested, cap) : requested;

  const baseName = args.sourceName ?? structure.name;
  const name = `${baseName}${aud.includeIds.length ? " — REMARKETING" : " — cópia"}`;

  const spec: CampaignDraftSpec = {
    version: 1,
    currency: ac.currency,
    dailyBudgetMinor,
    activation: ac.creationActivation,
    objective: goal,
    targeting,
    creativeRefs,
    sourceCampaignId: args.sourceCampaignId,
    budgetMode: structure.budgetMode,
    specialAdCategories: structure.specialAdCategories,
    // pixel da fonte → o createAdSet monta o promoted_object (conversão não falha). Mensagens não tem.
    ...(structure.pixelId ? { pixelId: structure.pixelId } : {}),
    name,
  };
  // Piso de alcance (Fatia 8) — igual ao create: autônomo não replica pra público estreito demais.
  if (auto && opts.minMonthlyReach != null && (await reachBelowFloor(deps, ac.ref, targeting, goal, opts.minMonthlyReach, structure.pixelId))) {
    return { kind: "blocked", reason: PROACTIVE_REACH_FLOOR_REASON };
  }
  const { draftId, approvalId } = await persistDraftAndApproval(deps, ctx, "from_scratch", spec, origin, {
    level: "campaign",
    id: args.sourceCampaignId,
  });

  // P0.2: mostra o público REAL herdado (cidades/idade/expansão), não só "mantendo geo/idade" genérico.
  const audienceLine =
    targeting.kind === "explicit"
      ? `\n• *Público:* ${describeExplicitAudience(targeting)}`
      : hasAudience
        ? `\n• *Público:* remarketing selecionado${aud.excludeIds.length ? " (com exclusões)" : ""} — ${describeResolvedAudience(structure.targeting)}`
        : `\n• *Público:* o mesmo da campanha-base — ${describeResolvedAudience(structure.targeting)}`;
  const budgetLine = sourceIsLifetime
    ? `• *Orçamento:* ${structure.budgetMode.toUpperCase()} · ${money(dailyBudgetMinor / MINOR_PER_UNIT, ac.currency)}/dia (a original usa orçamento vitalício; comecei com um diário seguro — ajuste se quiser)`
    : `• *Orçamento:* ${structure.budgetMode.toUpperCase()} · ${money(dailyBudgetMinor / MINOR_PER_UNIT, ac.currency)}/dia`;
  // alcance combinado (delivery_estimate ao vivo) só quando o dono trocou o público (senão o
  // targeting é o mesmo da base, alcance já conhecido). Superior ao por-público (`sizeWarnings`).
  const reachNote = hasAudience || hasExplicitPrimitive ? await reachNoteFor(deps, ac.ref, targeting, goal, structure.pixelId) : null;
  const reachLines = reachNote ? [reachNote] : aud.sizeWarnings;
  const echo = [
    `Vou *copiar a estrutura* de "${baseName}" numa campanha nova:`,
    budgetLine,
    `• *Anúncios:* ${creativeRefs.length} da original, reusados (mantém o criativo e o destino/WhatsApp)${audienceLine}`,
    `• *Objetivo:* ${goalNounPt(goal)} · ${activationPhrase(spec.activation)}.`,
    ...(adCountNote ? [adCountNote] : []),
    ...aud.notes,
    ...geoRadius.notes,
    ...areas.notes,
    ...(droppedNames.length > 0 ? [`Deixei de fora (não achei ou ambíguo na conta): ${droppedNames.join(", ")}.`] : []),
    ...reachLines,
    `Confirma? (dá pra ajustar orçamento/público antes)`,
  ].join("\n");
  return { kind: "draft", echo, approvalId, draftId };
}

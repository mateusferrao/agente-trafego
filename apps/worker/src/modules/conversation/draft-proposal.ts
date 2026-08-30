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
  ACTION_PARAM_MODE,
  ACTION_PARAM_PCT,
  BUDGET_MODE_INCREASE,
  DEFAULT_CONVERSION_GOAL,
  DEFAULT_CURRENCY,
  toGuardrailConfig,
  type Action,
  type AgentId,
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
} from "@trafego/shared";
import type { AdAccountRef } from "@trafego/shared/ports";
import type { WorkerDeps } from "../../composition.js";
import { createAnalysisRepo } from "../analysis/repo.js";
import { loadEnabledTools } from "../tools/enabled.js";
import { generateCopy } from "../copy/generate-copy.js";
import { createVisionResolver, creativeContentHash, servingVisionKey } from "../vision/resolver.js";
import { pickLibraryCreativeByContext, type MatchContext } from "../creative/match-library.js";
import { joinBalloons } from "../notify/split.js";
import { withTimeout } from "./with-timeout.js";

const MINOR_PER_UNIT = 100;
const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_VARIANTS = 2;
const DEFAULT_STARTER_BUDGET_MINOR = 3000;
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
  return [placesLabel, ageLabel, genderLabel, interestsLabel, behaviorsLabel, "sem expansão de público", audienceLabel].filter((s): s is string => Boolean(s)).join(", ");
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
  return [placesLabel, ageLabel, expansionLabel].filter((s): s is string => Boolean(s)).join(", ");
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
    creativeSource: resolveCreativeSourceStrategy(mc),
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
async function loadAccountAudiences(deps: WorkerDeps, ctx: DraftProposalContext, ref: AdAccountRef): Promise<CustomAudience[]> {
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
  | { readonly kind: "ok"; readonly includeIds: string[]; readonly excludeIds: string[]; readonly notes: string[]; readonly sizeWarnings: string[] }
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
): Promise<AudiencePrep> {
  if (includeQueries.length === 0 && excludeQueries.length === 0) return { kind: "ok", includeIds: [], excludeIds: [], notes: [], sizeWarnings: [] };
  const audiences = await loadAccountAudiences(deps, ctx, ref);
  if (audiences.length === 0) return { kind: "blocked", reason: "não achei públicos salvos nessa conta — confere no Gerenciador ou rode uma análise que eu cacheio os públicos" };
  const byId = new Map(audiences.map((a) => [a.id, a]));
  const acc = { name: (a: CustomAudience) => a.name, keys: (a: CustomAudience) => [a.id] };

  const resolve = (q: string): { id: string } | { blocked: string } => {
    const m = resolveNamedMatch(audiences, q, acc);
    if (m.kind === "one") return { id: m.row.id };
    if (m.kind === "none") return { blocked: `não achei um público chamado "${q}" na conta. Chega perto? me diga o nome exato (posso listar com "quais públicos eu tenho").` };
    const opts = m.rows.map((r, i) => `${i + 1}. ${r.name}`).join("\n");
    return { blocked: `achei mais de um público parecido com "${q}":\n${opts}\nQual desses? (me diz o nome exato)` };
  };

  const includeIds: string[] = [];
  for (const q of includeQueries) {
    const r = resolve(q);
    if ("blocked" in r) return { kind: "blocked", reason: r.blocked };
    includeIds.push(r.id);
  }
  const excludeIds: string[] = [];
  for (const q of excludeQueries) {
    const r = resolve(q);
    if ("blocked" in r) return { kind: "blocked", reason: r.blocked };
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
  return { kind: "ok", includeIds, excludeIds, notes, sizeWarnings };
}

/** Rótulo PT do tipo de geo (vocabulário Meta fica no adapter — aqui só o kind neutro). */
function geoKindPt(kind: "country" | "region" | "city"): string {
  return kind === "country" ? "país" : kind === "region" ? "região" : "cidade";
}

const MAX_GEO_AMBIGUOUS_OPTIONS = 5;

type GeoPrep =
  | { readonly kind: "ok"; readonly geo: readonly { readonly key: string; readonly name: string; readonly kind: "country" | "region" | "city" }[] }
  | { readonly kind: "blocked"; readonly reason: string };

/**
 * Resolve geo pedida (por NOME) → lugar real na Meta (Fase 1, subfatia 3a). Mesma honestidade de
 * `prepareAudiences`: 1 match → resolve; 0 → honesto; 2+ → PERGUNTA com opções numeradas, nunca chuta.
 */
async function prepareGeo(deps: WorkerDeps, ref: AdAccountRef, queries: readonly string[]): Promise<GeoPrep> {
  if (queries.length === 0) return { kind: "ok", geo: [] };
  const resolved: { key: string; name: string; kind: "country" | "region" | "city" }[] = [];
  for (const q of queries) {
    const matches = await deps.ports.ads.searchGeo(ref, q, ["country", "region", "city"]);
    if (matches.length === 0) {
      return { kind: "blocked", reason: `não achei "${q}" na busca de localização da Meta — confere o nome? (cidade, região ou país)` };
    }
    if (matches.length === 1) {
      resolved.push(matches[0]!);
      continue;
    }
    const opts = matches
      .slice(0, MAX_GEO_AMBIGUOUS_OPTIONS)
      .map((m, i) => `${i + 1}. ${m.name}${m.countryCode ? ` (${m.countryCode})` : ""} — ${geoKindPt(m.kind)}`)
      .join("\n");
    return { kind: "blocked", reason: `achei mais de um lugar parecido com "${q}":\n${opts}\nQual desses? (me diz mais específico, tipo "Belo Horizonte, MG")` };
  }
  return { kind: "ok", geo: resolved };
}

const MAX_INTEREST_AMBIGUOUS_OPTIONS = 5;

type InterestPrep =
  | { readonly kind: "ok"; readonly interests: readonly { readonly id: string; readonly name: string }[] }
  | { readonly kind: "blocked"; readonly reason: string };

/**
 * Resolve interesse pedido (por NOME) → interesse real na Meta (Fase 2, subfatia 4). Mesma
 * honestidade de `prepareGeo`/`prepareAudiences`: 1 match → resolve; 0 → honesto; 2+ → PERGUNTA
 * numerada — NUNCA pega o de maior audiência automaticamente (decisão do produto).
 */
async function prepareInterests(deps: WorkerDeps, ref: AdAccountRef, queries: readonly string[]): Promise<InterestPrep> {
  if (queries.length === 0) return { kind: "ok", interests: [] };
  const resolved: { id: string; name: string }[] = [];
  for (const q of queries) {
    const matches = await deps.ports.ads.searchInterests(ref, q);
    if (matches.length === 0) {
      return { kind: "blocked", reason: `não achei o interesse "${q}" na busca da Meta — confere o termo?` };
    }
    if (matches.length === 1) {
      resolved.push({ id: matches[0]!.id, name: matches[0]!.name });
      continue;
    }
    const opts = matches
      .slice(0, MAX_INTEREST_AMBIGUOUS_OPTIONS)
      .map((m, i) => `${i + 1}. ${m.name}${m.path && m.path.length > 0 ? ` (${m.path.join(" > ")})` : ""}`)
      .join("\n");
    return { kind: "blocked", reason: `achei mais de um interesse parecido com "${q}":\n${opts}\nQual desses? (me diz o nome exato)` };
  }
  return { kind: "ok", interests: resolved };
}

/**
 * Resolve comportamento (behavior) pedido (por NOME) → behavior real (Slice 4). Mesma honestidade
 * do interesse; usa `searchBehaviors` (a Meta não busca behavior no servidor → o adapter filtra a
 * enum cacheada). Reusa `InterestPrep` (opção de direcionamento detalhado, mesmo shape {id,name}).
 */
async function prepareBehaviors(deps: WorkerDeps, ref: AdAccountRef, queries: readonly string[]): Promise<InterestPrep> {
  if (queries.length === 0) return { kind: "ok", interests: [] };
  const resolved: { id: string; name: string }[] = [];
  for (const q of queries) {
    const matches = await deps.ports.ads.searchBehaviors(ref, q);
    if (matches.length === 0) {
      return { kind: "blocked", reason: `não achei o comportamento "${q}" no catálogo da Meta — confere o termo?` };
    }
    if (matches.length === 1) {
      resolved.push({ id: matches[0]!.id, name: matches[0]!.name });
      continue;
    }
    const opts = matches
      .slice(0, MAX_INTEREST_AMBIGUOUS_OPTIONS)
      .map((m, i) => `${i + 1}. ${m.name}${m.path && m.path.length > 0 ? ` (${m.path.join(" > ")})` : ""}`)
      .join("\n");
    return { kind: "blocked", reason: `achei mais de um comportamento parecido com "${q}":\n${opts}\nQual desses? (me diz o nome exato)` };
  }
  return { kind: "ok", interests: resolved };
}

type ExplicitGeo = Extract<TargetingSpec, { readonly kind: "explicit" }>["geo"][number];
type AddressArea = { readonly address: string; readonly radiusKm: number };

/** Aplica um raio (km) às CIDADES/REGIÕES do geo resolvido (Slice 5) — clampa pro limite da Meta
 *  (cidade 17–80 km) + nota. País ignora raio. Puro (usa `clampRadius` do core). */
function applyCityRadius(geo: readonly ExplicitGeo[], radiusKm: number | undefined): { geo: ExplicitGeo[]; notes: string[] } {
  if (!radiusKm) return { geo: [...geo], notes: [] };
  const { radius, note } = clampRadius(radiusKm, "kilometer", "city");
  const next = geo.map((g) => (g.kind === "country" ? g : { ...g, radius, distanceUnit: "kilometer" as const }));
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
  const { dailyBudgetMinor: newDailyMinor, clampedByCap } = clampNewBudget(requested, ac.cfg.maxNewDailyBudgetMinor);
  const spec: CampaignDraftSpec = {
    version: 1,
    currency: ac.currency,
    dailyBudgetMinor: newDailyMinor,
    ...(clampedByCap ? { requestedDailyBudgetMinor: requested } : {}),
    activation: "active",
  };
  const { draftId, approvalId } = await persistDraftAndApproval(deps, ctx, "duplicate", spec, origin, {
    level,
    id: chosen.entityId,
    name: label, // nome do vencedor → card mostra "Duplicar conjunto <nome>" (não o id cru)
  });
  const budgetLine = clampedByCap
    ? `Gasto novo: ${money(newDailyMinor / MINOR_PER_UNIT, ac.currency)}/dia (você pediu ${money(requested / MINOR_PER_UNIT, ac.currency)}, mas seu teto de gasto novo é ${money(newDailyMinor / MINOR_PER_UNIT, ac.currency)}) · ${activationPhrase("active")}.`
    : `Gasto novo: ${money(newDailyMinor / MINOR_PER_UNIT, ac.currency)}/dia · ${activationPhrase("active")}.`;
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
  if (spec.copyVariants && spec.copyVariants.length > 0) {
    lines.push(`${spec.copyVariants.length} variação(ões) de copy. Ex: "${spec.copyVariants[0]!.headline}".`);
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

export interface RefineDraftPatch {
  readonly budgetReais?: number;
  readonly activation?: "active" | "paused";
  readonly variantsCount?: number;
  readonly regenerateCopy?: boolean;
  /** público (só from_scratch): `reuse` = herda o conjunto que converte; `broad` = a Meta escolhe. */
  readonly audience?: "reuse" | "broad";
  /** nome da campanha (chat leve — ajuste de intenção única, só from_scratch). */
  readonly campaignName?: string;
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
  const loaded = await loadDraftForEdit(deps.db, { orgId: ctx.orgId, draftId });
  if (!loaded) return { kind: "blocked", reason: NOT_OPEN_REASON };
  const { kind, spec } = loaded;

  const ac = await loadAgentContext(deps, ctx);
  if (!ac) return { kind: "blocked", reason: "não consegui acessar a conta agora" };

  const edit: MutableEdit = {};
  if (patch.budgetReais != null) edit.budgetMinor = Math.round(patch.budgetReais * MINOR_PER_UNIT);
  if (patch.activation) edit.activation = patch.activation;
  if (kind === "from_scratch" && patch.campaignName != null) edit.campaignName = patch.campaignName;

  // copy (só from_scratch): regenerar re-aterra na copy que já performa (LLM na casca → fragmento).
  const variantsCount = patch.variantsCount ?? spec.variantsCount ?? DEFAULT_VARIANTS;
  const needCopy = kind === "from_scratch" && (patch.regenerateCopy === true || (patch.variantsCount != null && patch.variantsCount !== (spec.variantsCount ?? 0)));
  if (needCopy) {
    const defaults = await deps.ports.ads.inferCreationDefaults(ac.ref);
    edit.copyVariants = await generateCopy(
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

  // público (só from_scratch): thunk lazy (broad/keep não tocam a conta). O reuse SEMPRE nasce com
  // retrato (lê o público da fonte + buildResolvedSnapshot) — nunca um reuse_adset cru (Bug 3).
  if (kind === "from_scratch" && patch.audience) {
    const targeting = await resolveAudienceTargeting(patch.audience, spec.targeting, async () => {
      const sourceAdsetId = (await deps.ports.ads.inferCreationDefaults(ac.ref)).sourceAdsetId;
      if (!sourceAdsetId) return undefined;
      const profile = await deps.ports.ads.getAudienceProfile(ac.ref, sourceAdsetId);
      return profile ? { kind: "reuse_adset", sourceAdsetId, resolved: buildResolvedSnapshot(profile) } : undefined;
    });
    if (targeting) edit.targeting = targeting;
  }
  // editar (remover/adicionar geo, estreitar idade) o público EXPLÍCITO já resolvido (Fase 1,
  // subfatia 3a). Adicionar resolve na hora (ambíguo→pergunta); remover/idade não chamam a Meta.
  if (kind === "from_scratch" && spec.targeting?.kind === "explicit" && (patch.removeGeo?.length || patch.addGeo?.length || patch.ageMin != null || patch.ageMax != null || patch.gender != null)) {
    const addGeoPrep = patch.addGeo?.length ? await prepareGeo(deps, ac.ref, patch.addGeo) : { kind: "ok" as const, geo: [] };
    if (addGeoPrep.kind === "blocked") return { kind: "blocked", reason: addGeoPrep.reason };
    const r = applyExplicitGeoEdit(spec.targeting, {
      ...(patch.removeGeo ? { removeGeo: patch.removeGeo } : {}),
      ...(addGeoPrep.geo.length > 0 ? { addGeo: addGeoPrep.geo } : {}),
      ...(patch.ageMin != null ? { ageMin: patch.ageMin } : {}),
      ...(patch.ageMax != null ? { ageMax: patch.ageMax } : {}),
      ...(patch.gender != null ? { genders: patch.gender === "men" ? [1] : patch.gender === "women" ? [2] : [] } : {}),
    });
    if (r.kind === "blocked") return { kind: "blocked", reason: r.reason };
    edit.targeting = r.targeting;
  }
  // editar (remover/adicionar) INTERESSES do público EXPLÍCITO já resolvido (Fase 2, subfatia 4).
  // Mesma honestidade: adicionar resolve na hora (ambíguo→pergunta); remover não chama a Meta.
  // Lê de `edit.targeting` quando a geo já foi editada NESTE mesmo patch (evita perder a edição).
  if (kind === "from_scratch" && (patch.removeInterests?.length || patch.addInterests?.length || patch.narrowInterests?.length)) {
    const targetingBefore = edit.targeting ?? spec.targeting;
    if (targetingBefore?.kind !== "explicit") {
      return { kind: "blocked", reason: "esse rascunho não tem um público explícito pra editar interesses — crie mirando geo/idade/gênero primeiro." };
    }
    const addInterestPrep = patch.addInterests?.length ? await prepareInterests(deps, ac.ref, patch.addInterests) : { kind: "ok" as const, interests: [] };
    if (addInterestPrep.kind === "blocked") return { kind: "blocked", reason: addInterestPrep.reason };
    const narrowPrep = patch.narrowInterests?.length ? await prepareInterests(deps, ac.ref, patch.narrowInterests) : { kind: "ok" as const, interests: [] };
    if (narrowPrep.kind === "blocked") return { kind: "blocked", reason: narrowPrep.reason };
    const r = applyExplicitInterestEdit(targetingBefore, {
      ...(patch.removeInterests ? { removeInterests: patch.removeInterests } : {}),
      ...(addInterestPrep.interests.length > 0 ? { addInterests: addInterestPrep.interests } : {}),
      ...(narrowPrep.interests.length > 0 ? { narrowInterests: narrowPrep.interests } : {}),
    });
    if (r.kind === "blocked") return { kind: "blocked", reason: r.reason };
    edit.targeting = r.targeting;
  }
  // editar COMPORTAMENTOS (Slice 4) — espelho dos interesses (add via catálogo, remove sem chamada).
  if (kind === "from_scratch" && (patch.removeBehaviors?.length || patch.addBehaviors?.length || patch.narrowBehaviors?.length)) {
    const targetingBefore = edit.targeting ?? spec.targeting;
    if (targetingBefore?.kind !== "explicit") {
      return { kind: "blocked", reason: "esse rascunho não tem um público explícito pra editar comportamentos — crie mirando geo/idade/gênero primeiro." };
    }
    const addBehaviorPrep = patch.addBehaviors?.length ? await prepareBehaviors(deps, ac.ref, patch.addBehaviors) : { kind: "ok" as const, interests: [] };
    if (addBehaviorPrep.kind === "blocked") return { kind: "blocked", reason: addBehaviorPrep.reason };
    const narrowBehaviorPrep = patch.narrowBehaviors?.length ? await prepareBehaviors(deps, ac.ref, patch.narrowBehaviors) : { kind: "ok" as const, interests: [] };
    if (narrowBehaviorPrep.kind === "blocked") return { kind: "blocked", reason: narrowBehaviorPrep.reason };
    const r = applyExplicitBehaviorEdit(targetingBefore, {
      ...(patch.removeBehaviors ? { removeBehaviors: patch.removeBehaviors } : {}),
      ...(addBehaviorPrep.interests.length > 0 ? { addBehaviors: addBehaviorPrep.interests } : {}),
      ...(narrowBehaviorPrep.interests.length > 0 ? { narrowBehaviors: narrowBehaviorPrep.interests } : {}),
    });
    if (r.kind === "blocked") return { kind: "blocked", reason: r.reason };
    edit.targeting = r.targeting;
  }

  const result = applyDraftEdit(kind, spec, edit, { budgetCapMinor: ac.cfg.maxNewDailyBudgetMinor ?? null, hasPixel: true });
  if (!result.ok) return { kind: "blocked", reason: refineErrorReason(result.error) };

  const persisted = await persistDraftSpec(deps.db, { orgId: ctx.orgId, draftId }, result.value.spec);
  if (!persisted) return { kind: "blocked", reason: NOT_OPEN_REASON };
  return { kind: "ok", echo: buildRefineEcho(kind, result.value.spec) };
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
  ref: AdAccountRef,
  serving: { imageHash?: string; videoId?: string; sourceAdId?: string },
  strategy: CreativeSourceStrategy,
  match?: MatchContext & { readonly model: string },
): Promise<ChosenCreative | null> {
  const servingRef = (): ChosenCreative | null =>
    serving.imageHash || serving.videoId
      ? {
          ...(serving.imageHash ? { imageHash: serving.imageHash } : {}),
          ...(serving.videoId ? { videoId: serving.videoId } : {}),
          assetId: serving.sourceAdId ?? "reuse",
          origin: "reuse",
          source: "serving",
        }
      : null;

  // MODO PADRÃO (serving.best_performing = comportamento de hoje): reusa o melhor veiculando (provado
  // por desempenho, determinístico, SEM LLM); sem veiculando, cai na biblioteca por contexto.
  if (strategy.mode === "serving" && (strategy.servingPick ?? "best_performing") === "best_performing") {
    return servingRef() ?? (await chooseLibraryByContext(deps, orgId, accountId, match));
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
    return strategy.mode === "library" ? null : servingRef();
  }

  let chosen = pool[0]!; // fallback: ordem (veiculando recentes primeiro, depois biblioteca)
  const described = pool.filter((c) => c.description.trim().length > 0);
  if (match && described.length > 0) {
    const picked = await pickLibraryCreativeByContext(
      deps.ports.llm,
      match.model,
      match,
      described.map((c) => ({ assetId: c.key, description: c.description })),
    );
    if (picked) chosen = pool.find((c) => c.key === picked) ?? chosen;
  }
  return chosen.ref;
}

/** Um candidato a criativo com descrição (pro matcher) + a ref concreta (pro spec). */
interface DescribedCandidate {
  readonly key: string;
  readonly description: string;
  readonly ref: ChosenCreative;
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
      described.map((c) => ({ assetId: c.key, description: c.description })),
    );
    if (picked) chosen = pool.find((c) => c.key === picked) ?? chosen;
  }
  return chosen.ref;
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
  const descByHash = new Map(visions.map((v) => [v.hash, describeVision(v.result)]));
  return withMedia.map((l) => ({
    key: `lib:${l.id}`,
    description: descByHash.get(hashOf.get(l.id)!) ?? "",
    ref: {
      ...(l.imageHash ? { imageHash: l.imageHash } : {}),
      ...(l.videoId ? { videoId: l.videoId } : {}),
      assetId: l.id,
      origin: "upload",
      source: "library",
    },
  }));
}

/** Candidatos VEICULANDO (X mais recentes de `ad_creatives`) com DESCRIÇÃO de visão cache-read-through:
 *  hit reusa o cache dos runs; MISS computa fresh (auto-cacheia) — imagem usa o url guardado, vídeo
 *  busca frames ao vivo (só o que falta, teto `SERVING_PICK_CANDIDATES`). Sem visão → copy (nunca mudo). */
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
    let description = wasCached ? describeVision(cachedByHash.get(contentHash)) : "";
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
        if (result) description = describeVision(result);
      }
    }
    if (!description) description = copy ? `Anúncio que já veicula. Texto: ${copy}` : "Anúncio que já veicula.";
    out.push({
      key: `srv:${r.adId}`,
      description,
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
  },
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

  // resolve os públicos pedidos → ids (determinístico; ambíguo/inexistente → pergunta).
  const aud = await prepareAudiences(deps, ctx, ac.ref, args.includeAudiences ?? [], args.excludeAudiences ?? []);
  if (aud.kind === "blocked") return { kind: "blocked", reason: aud.reason };
  // geo explícita (Fase 1, subfatia 3a) — mesma honestidade (ambíguo→pergunta, nunca chuta).
  const geoPrep = await prepareGeo(deps, ac.ref, args.geo ?? []);
  if (geoPrep.kind === "blocked") return { kind: "blocked", reason: geoPrep.reason };
  // interesses explícitos (Fase 2, subfatia 4) — mesma honestidade (ambíguo→pergunta, nunca chuta).
  const interestPrep = await prepareInterests(deps, ac.ref, args.interests ?? []);
  if (interestPrep.kind === "blocked") return { kind: "blocked", reason: interestPrep.reason };
  // comportamentos explícitos (Slice 4) — mesma honestidade (ambíguo→pergunta).
  const behaviorPrep = await prepareBehaviors(deps, ac.ref, args.behaviors ?? []);
  if (behaviorPrep.kind === "blocked") return { kind: "blocked", reason: behaviorPrep.reason };
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
        ac.ref,
        {
          ...(defaults.imageHash ? { imageHash: defaults.imageHash } : {}),
          ...(defaults.videoId ? { videoId: defaults.videoId } : {}),
          ...(defaults.sourceAdId ? { sourceAdId: defaults.sourceAdId } : {}),
        },
        ac.creativeSource,
        { goal, businessContext: ac.businessContext, guidance: ac.guidance, model: ac.model },
      );
  const reuseImageHash = chosen?.imageHash;
  const reuseVideoId = chosen?.videoId;
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
    // `custom_audiences`). Só público salvo (sem primitivo) = geo amplo (BR) + o público.
    // geo default (BR) só quando NÃO há cidade NEM área por endereço (senão a Meta uniria BR ∪ raio,
    // ampliando o público) — com áreas por endereço, geo fica vazio e `radiusAreas` carrega o alvo.
    const geoBase = geoRadius.geo.length > 0 ? geoRadius.geo : areas.radiusAreas.length > 0 ? [] : [{ key: "BR", name: "Brasil", kind: "country" as const }];
    targeting = {
      kind: "explicit",
      geo: geoBase,
      ...(areas.radiusAreas.length > 0 ? { radiusAreas: areas.radiusAreas } : {}),
      ...(args.ageMin !== undefined ? { ageMin: args.ageMin } : {}),
      ...(args.ageMax !== undefined ? { ageMax: args.ageMax } : {}),
      ...(args.gender === "men" ? { genders: [1] } : args.gender === "women" ? { genders: [2] } : {}),
      ...(interestPrep.interests.length > 0 ? { interestGroups: [interestPrep.interests] } : {}),
      ...(behaviorPrep.interests.length > 0 ? { behaviorGroups: [behaviorPrep.interests] } : {}),
      ...(hasAudience ? { customAudienceIncludeIds: aud.includeIds, customAudienceExcludeIds: aud.excludeIds } : {}),
    };
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
    activation: "active",
    objective: goal,
    targeting,
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
  const audienceSourcePhrase =
    spec.targeting?.kind === "reuse_adset" ? " e o público que já converte" : spec.targeting?.kind === "explicit" ? " pro público que você indicou" : "";
  // Transparência (§clareza pro dono): se o #1 por desempenho for um formato que ainda não sei
  // clonar (carrossel/catálogo), avisa que peguei o melhor de imagem/vídeo no lugar.
  const lines = [
    `Vou **criar uma campanha de ${goal}** ${creativeSourcePhrase}${audienceSourcePhrase} e ${variantsCount} variações de copy novas (baseadas no que já converte).`,
  ];
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
    `Gasto novo: ${budgetPhrase} · Página: ${defaults.pageId}${defaults.pixelId ? ` · Pixel: ${defaults.pixelId}` : ""} · ${activationPhrase("active")}.`,
  );
  for (const n of aud.notes) lines.push(n);
  for (const n of [...geoRadius.notes, ...areas.notes]) lines.push(n);
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
    /** interesses EXPLÍCITOS pra TROCAR os da original (Fase 2, subfatia 4) — quando ausentes,
     *  a cópia fiel não herda interesses da fonte: `structure.targeting.interests` só traz NOMES
     *  pra display (sem `id`), então não dá pra remontar um `flexible_spec` válido sem rebuscar —
     *  ausência = sem interesses no rascunho, não "mantém os da original". */
    readonly interests?: readonly string[];
    /** comportamentos EXPLÍCITOS pra TROCAR (Slice 4) — mesma regra dos interesses na cópia. */
    readonly behaviors?: readonly string[];
    /** raio (km) nas cidades (Slice 5) + raio por endereço (clampados). */
    readonly radiusKm?: number;
    readonly addressAreas?: readonly AddressArea[];
  },
  origin: DraftOrigin = "on_demand",
): Promise<ChatDraftProposal> {
  const ac = await loadAgentContext(deps, ctx);
  if (!ac) return { kind: "blocked", reason: "não consegui acessar a conta agora" };
  if (!ac.enabled.has("create_campaign")) {
    return { kind: "blocked", reason: "criar/copiar campanha está desligado para este agente (ligue em ações permitidas)" };
  }

  // resolve os públicos pedidos → ids (determinístico; ambíguo/inexistente → pergunta).
  const aud = await prepareAudiences(deps, ctx, ac.ref, args.includeAudiences ?? [], args.excludeAudiences ?? []);
  if (aud.kind === "blocked") return { kind: "blocked", reason: aud.reason };
  const geoPrep = await prepareGeo(deps, ac.ref, args.geo ?? []);
  if (geoPrep.kind === "blocked") return { kind: "blocked", reason: geoPrep.reason };
  const interestPrep = await prepareInterests(deps, ac.ref, args.interests ?? []);
  if (interestPrep.kind === "blocked") return { kind: "blocked", reason: interestPrep.reason };
  const behaviorPrep = await prepareBehaviors(deps, ac.ref, args.behaviors ?? []);
  if (behaviorPrep.kind === "blocked") return { kind: "blocked", reason: behaviorPrep.reason };
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
          ...(interestPrep.interests.length > 0 ? { interestGroups: [interestPrep.interests] } : {}),
          ...(behaviorPrep.interests.length > 0 ? { behaviorGroups: [behaviorPrep.interests] } : {}),
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
    activation: "paused",
    objective: goal,
    targeting,
    creativeRefs: structure.creativeRefs,
    sourceCampaignId: args.sourceCampaignId,
    budgetMode: structure.budgetMode,
    specialAdCategories: structure.specialAdCategories,
    // pixel da fonte → o createAdSet monta o promoted_object (conversão não falha). Mensagens não tem.
    ...(structure.pixelId ? { pixelId: structure.pixelId } : {}),
    name,
  };
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
    `• *Anúncios:* ${structure.creativeRefs.length} da original, reusados (mantém o criativo e o destino/WhatsApp)${audienceLine}`,
    `• *Objetivo:* ${goalNounPt(goal)} · ${activationPhrase("paused")}.`,
    ...aud.notes,
    ...geoRadius.notes,
    ...areas.notes,
    ...reachLines,
    `Confirma? (dá pra ajustar orçamento/público antes)`,
  ].join("\n");
  return { kind: "draft", echo, approvalId, draftId };
}

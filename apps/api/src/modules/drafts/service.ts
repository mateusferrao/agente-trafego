import { createHash } from "node:crypto";
import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  adAccounts,
  adCreatives,
  agents,
  agentToolBindings,
  campaignDrafts,
  creativeAssets,
  guardrailConfigs,
  platformConnections,
  type Database,
} from "@trafego/db";
import { applyDraftEdit, buildResolvedSnapshot, computeApplyPreview, describeDeliveryEstimate, planScaleMove, resolveEnabledTools, type BudgetLevel, type DraftEdit, type RefineError, type ScaleAggressivePreference } from "@trafego/core";
import { applyExplicitGeoEdit, applyExplicitInterestEdit, loadDraftForEdit, persistDraftSpec, resolveAudienceTargeting } from "@trafego/campaign-drafts";
import { toMinorUnits, minorToMajor, resolveCreationActivation, type CreationActivation, type ToolBindingMode } from "@trafego/shared";
import {
  ACTION_PARAM_MODE,
  ACTION_PARAM_PCT,
  APPROVAL_TTL_HOURS,
  BUDGET_MODE_INCREASE,
  DEFAULT_CURRENCY,
  MAX_ADS_PER_DRAFT,
  buildCreativeAnalyzeJob,
  buildCreativeVideoPollJob,
  toGuardrailConfig,
  type CampaignDraftSpec,
} from "@trafego/shared";
import type { Action, AgentId, CreativeAssetRef, DraftId, OrgId, TargetingSpec } from "@trafego/shared/types";
import type { AdAccountRef, ApprovalPort, CredentialVaultPort, SchedulerPort, StoragePort } from "@trafego/shared/ports";
import type { AdsPlatformPort } from "@trafego/shared/ports";
import { ingestCreativeImage, ingestCreativeVideo } from "@trafego/creative-library";
import { buildExplicitFromInput, serializeExplicitAudience } from "../../lib/audience.js";
import type {
  AudienceOutput,
  CreativeAssetOutput,
  DeliveryEstimateInput,
  DraftApprovalOutput,
  GeoSearchResultOutput,
  InterestSearchResultOutput,
  ScaleWinnerInput,
  ScaleWinnerOutput,
  ServingCreativeOutput,
  SetDraftCreativeInput,
  UpdateDraftInput,
  UploadCreativeArgs,
  UploadCreativeOutput,
} from "./schema.js";

/** Content-types aceitos no upload (declarado + allowlist; a Meta rejeita o resto na subida). */
const ALLOWED_IMAGE_TYPES: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const ALLOWED_VIDEO_TYPES: ReadonlySet<string> = new Set(["video/mp4", "video/quicktime"]);
export function isAllowedCreativeType(contentType: string): boolean {
  return ALLOWED_IMAGE_TYPES.has(contentType) || ALLOWED_VIDEO_TYPES.has(contentType);
}

const APPROVAL_TTL_MS = APPROVAL_TTL_HOURS * 60 * 60 * 1000;
/** Teto de tempo e tamanho do fetch da miniatura (fbcdn) — não pendura o handler da API nem
 *  materializa payload gigante em memória (a thumb da Meta é pequena; isto é a rede de segurança). */
const THUMB_FETCH_TIMEOUT_MS = 8000;
const THUMB_MAX_BYTES = 5 * 1024 * 1024;
/** Cap de segurança do picker de anúncios veiculando (o web trunca + "ver mais" + busca; a
 *  paginação server-side robusta é fast-follow). Evita payload patológico em contas gigantes. */
const SERVING_PICKER_CAP = 200;

const DRAFT_NOT_OPEN_MSG = "esse rascunho não está mais aberto pra ajuste.";
const ACCOUNT_UNAVAILABLE_MSG = "não consegui acessar a conta agora";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** Geo AGRUPADO do snapshot → lista plana `{key,name,kind}` (semente do converter modo, Slice 8).
 *  País usa o código como nome (o snapshot não guarda nome legível de país). */
function flattenSnapshotGeoForOutput(
  geo: { countries?: readonly string[]; regions?: readonly { key: string; name: string }[]; cities?: readonly { key: string; name: string }[] },
): { key: string; name: string; kind: "country" | "region" | "city" }[] {
  return [
    ...(geo.countries ?? []).map((c) => ({ key: c, name: c, kind: "country" as const })),
    ...(geo.regions ?? []).map((r) => ({ key: r.key, name: r.name, kind: "region" as const })),
    ...(geo.cities ?? []).map((c) => ({ key: c.key, name: c.name, kind: "city" as const })),
  ];
}

/** Baixa a imagem de uma miniatura de uma URL da plataforma (fbcdn/Meta) com rede de segurança:
 *  teto de tempo (URL lenta não pendura o handler), só content-type de imagem (não ecoa tipo
 *  arbitrário inline) e cap de tamanho (não materializa payload gigante). Falha/timeout/violação
 *  → null (o card cai no fallback). Compartilhado pelas miniaturas de rascunho e de biblioteca. */
async function fetchThumbImage(url: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const res = await fetch(url, { signal: AbortSignal.timeout(THUMB_FETCH_TIMEOUT_MS) }).catch(() => null);
  if (!res || !res.ok) return null;
  const contentType = res.headers.get("content-type") ?? "image/jpeg";
  if (!contentType.startsWith("image/")) return null; // não ecoa content-type arbitrário inline
  if (Number(res.headers.get("content-length") ?? 0) > THUMB_MAX_BYTES) return null;
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > THUMB_MAX_BYTES) return null; // fallback quando não veio content-length
  return { bytes, contentType };
}

/** Traduz o erro TIPADO do núcleo de refino p/ mensagem amigável (§13 — o quê + o que fazer). */
export function refineErrorMessage(error: RefineError): string {
  switch (error.code) {
    case "field_not_editable":
      return "Numa escala eu mantenho o que já converte (público, criativo e copy do vencedor). Pra mexer nisso, o caminho é criar uma campanha nova.";
    case "empty_variants":
      return "Toda campanha precisa de pelo menos um anúncio. Edite este em vez de remover.";
    case "objective_requires_pixel":
      return "Esse objetivo precisa do rastreamento de conversões (pixel) configurado na Meta, e esta conta ainda não tem. Configure no Gerenciador de Eventos da Meta, ou escolha um objetivo que não precise disso (como mensagens ou engajamento).";
  }
}

export interface DraftsServiceDeps {
  readonly db: Database;
  readonly adsPlatform: AdsPlatformPort;
  readonly vault: CredentialVaultPort;
  readonly approvals: ApprovalPort;
  /** Storage do blob original (F7) — mesma porta do intake WhatsApp (convergência). */
  readonly storage: StoragePort;
  /** enfileira o poll de status de vídeo (upload async). */
  readonly scheduler: SchedulerPort;
}

/** Conta + agente + token + cfg resolvidos p/ operar uma escala. */
interface ScaleContext {
  readonly agentId: string;
  readonly ref: AdAccountRef;
  readonly currency: string;
  readonly cfg: ReturnType<typeof toGuardrailConfig>;
  /** Preferência do passo agressivo (autonomy_policy) — default "ask". */
  readonly scaleAggressivePreference: ScaleAggressivePreference;
  /** Ativação da criação/escala (autonomy_policy) — default "paused" (2ª aprovação de ativação).
   *  MESMA fonte do chat (§7): o site não pode furar a barreira ativando direto. */
  readonly creationActivation: CreationActivation;
  /** Tool-keys habilitadas (bindings, mesma fonte do chat/apply) — gate da escala. */
  readonly enabled: ReadonlySet<string>;
}

export function createDraftsService(deps: DraftsServiceDeps) {
  async function loadScaleContext(orgId: string, accountId: string): Promise<ScaleContext | null> {
    const [row] = await deps.db
      .select({
        metaAdAccountId: adAccounts.adAccountId,
        currency: adAccounts.currency,
        accountToken: adAccounts.tokenCripto,
        connToken: platformConnections.tokenCripto,
        agentId: agents.id,
        autonomyPolicy: agents.autonomyPolicy,
      })
      .from(adAccounts)
      .leftJoin(platformConnections, eq(adAccounts.connectionId, platformConnections.id))
      .leftJoin(agents, eq(agents.adAccountId, adAccounts.id))
      .where(and(eq(adAccounts.id, accountId), eq(adAccounts.orgId, orgId)))
      .limit(1);
    if (!row || !row.agentId) return null;
    const encrypted = row.connToken ?? row.accountToken;
    if (!encrypted) return null;

    const [g] = await deps.db
      .select()
      .from(guardrailConfigs)
      .where(and(eq(guardrailConfigs.agentId, row.agentId), eq(guardrailConfigs.orgId, orgId)))
      .limit(1);

    const bindings = await deps.db
      .select({ toolKey: agentToolBindings.toolKey, mode: agentToolBindings.mode })
      .from(agentToolBindings)
      .where(and(eq(agentToolBindings.agentId, row.agentId), eq(agentToolBindings.orgId, orgId)));
    const bindingMap = new Map<string, ToolBindingMode>(bindings.map((b) => [b.toolKey, b.mode as ToolBindingMode]));
    const cfg = toGuardrailConfig(g);
    const enabled = resolveEnabledTools(bindingMap, new Set((cfg.allowedActions ?? []) as string[]));

    return {
      agentId: row.agentId,
      ref: { adAccountId: row.metaAdAccountId, accessToken: deps.vault.decrypt(encrypted) },
      currency: row.currency ?? DEFAULT_CURRENCY,
      cfg,
      scaleAggressivePreference: row.autonomyPolicy?.scaleAggressivePreference ?? "ask",
      creationActivation: resolveCreationActivation(row.autonomyPolicy ?? undefined),
      enabled,
    };
  }

  /** URL FRESCA (fbcdn) de um frame/imagem de um criativo AO VIVO, pelo id do anúncio. Vídeo →
   *  frame HD (`getVideoFrames`), fallback thumbnail do anúncio; imagem → imagem do anúncio. Fonte
   *  ÚNICA do reuse (miniatura de rascunho + de anúncio da conta). A URL do fbcdn expira → o caller
   *  baixa os bytes na hora (`fetchThumbImage`) e nunca a manda crua pro browser. */
  async function resolveLiveThumbUrl(ref: AdAccountRef, adId: string, videoId: string | null): Promise<string | undefined> {
    if (videoId) {
      const frame = (await deps.adsPlatform.getVideoFrames(ref, videoId))[0];
      if (frame) return frame;
      const [c] = await deps.adsPlatform.getCreatives(ref, [adId]);
      return c?.thumbnailUrl ?? c?.imageUrl;
    }
    const [c] = await deps.adsPlatform.getCreatives(ref, [adId]);
    return c?.imageUrl ?? c?.thumbnailUrl;
  }

  /** Ref de reuse de um upload da BIBLIOTECA (uuid). Só `ready` + não-arquivado da mesma conta. */
  async function resolveLibraryCreative(orgId: OrgId, accountId: string, assetId: string): Promise<CreativeAssetRef | null> {
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
          eq(creativeAssets.id, assetId),
          eq(creativeAssets.orgId, orgId),
          eq(creativeAssets.adAccountId, accountId),
          isNull(creativeAssets.archivedAt),
        ),
      )
      .limit(1);
    if (!asset || asset.status !== "ready") return null;
    return {
      assetId,
      format: asset.format,
      origin: asset.origin,
      ...(asset.metaImageHash ? { metaImageHash: asset.metaImageHash } : {}),
      ...(asset.metaVideoId ? { metaVideoId: asset.metaVideoId } : {}),
    };
  }

  /** Ref de reuse de um anúncio AO VIVO (ad id da Meta): busca o video_id / image_hash FRESCO (não
   *  o ad_creatives stale). Vídeo → metaVideoId; imagem → metaImageHash (Slice 12). */
  async function resolveServingCreative(orgId: OrgId, accountId: string, adId: string): Promise<CreativeAssetRef | null> {
    const ctx = await loadScaleContext(orgId, accountId);
    if (!ctx) return null;
    const [c] = await deps.adsPlatform.getCreatives(ctx.ref, [adId]);
    // VÍDEO: carrega TAMBÉM a capa (metaImageHash = video_data.image_hash do anúncio-fonte) — a Meta
    // exige capa no video_data e ler os thumbnails do vídeo pode falhar (#10). Sem capa → o apply cai
    // no fallback de thumbnails; com ela, cria direto.
    if (c?.videoId) return { assetId: adId, format: "video", origin: "reuse", metaVideoId: c.videoId, ...(c.imageHash ? { metaImageHash: c.imageHash } : {}) };
    if (c?.imageHash) return { assetId: adId, format: "image", origin: "reuse", metaImageHash: c.imageHash };
    return null;
  }

  /**
   * Edição CONSOLIDADA de um rascunho (painel "Editar rascunho", Slice 7). Resolve os fragmentos
   * de IO (público→targeting, asset/serving→creative) na CASCA, monta o `DraftEdit` neutro, aplica
   * o núcleo puro `applyDraftEdit` (clamp/guards/merge) e persiste com UPDATE guardado por status.
   * Chat e site convergem aqui (§13 DRY). Erro tipado do núcleo → mensagem amigável (§13). A
   * auditoria é cross-cutting (hook onResponse), não copiada aqui.
   */
  async function updateDraftImpl(
    orgId: OrgId,
    accountId: string,
    draftId: string,
    input: UpdateDraftInput,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const loaded = await loadDraftForEdit(deps.db, { orgId, draftId, adAccountId: accountId });
    if (!loaded) return { ok: false, message: DRAFT_NOT_OPEN_MSG };
    const { kind, spec } = loaded;

    // Contexto de conta (token/cfg) + defaults (page/pixel/público) carregados UMA vez, sob demanda
    // (cap de budget, inferir público, re-resolver pixel do objetivo). Nomes/ativação/copy não
    // tocam a conta → não pagam a query.
    let ctxCache: ScaleContext | null | undefined;
    const getCtx = async (): Promise<ScaleContext | null> => {
      if (ctxCache === undefined) ctxCache = await loadScaleContext(orgId, accountId);
      return ctxCache;
    };
    let defaultsCache: Awaited<ReturnType<AdsPlatformPort["inferCreationDefaults"]>> | null | undefined;
    const getDefaults = async () => {
      if (defaultsCache === undefined) {
        const ctx = await getCtx();
        defaultsCache = ctx ? await deps.adsPlatform.inferCreationDefaults(ctx.ref) : null;
      }
      return defaultsCache;
    };

    const edit: Mutable<DraftEdit> = {};
    if (input.activation) edit.activation = input.activation;
    if (input.campaignName != null) edit.campaignName = input.campaignName;
    if (input.adsetName != null) edit.adsetName = input.adsetName;
    if (input.suffixLabel != null) edit.suffixLabel = input.suffixLabel;

    let budgetCapMinor: number | null = null;
    if (input.budgetReais != null) {
      const ctx = await getCtx();
      if (!ctx) return { ok: false, message: ACCOUNT_UNAVAILABLE_MSG };
      edit.budgetMinor = toMinorUnits(input.budgetReais, ctx.currency);
      budgetCapMinor = ctx.cfg.maxNewDailyBudgetMinor ?? null;
    }

    // Objetivo (só from_scratch): re-resolve o pixel DA CONTA (não de spec.pixelId). O guard do
    // núcleo bloqueia objetivo-que-exige-pixel sem pixel; quando há, grava o pixel no spec.
    let hasPixel = true;
    if (input.objective) {
      const defaults = await getDefaults();
      if (!defaults) return { ok: false, message: ACCOUNT_UNAVAILABLE_MSG };
      hasPixel = Boolean(defaults.pixelId);
      edit.objective = input.objective;
      if (defaults.pixelId) edit.pixelId = defaults.pixelId;
    }

    if (input.audience) {
      // reuse SEMPRE nasce com retrato (lê o público da fonte + buildResolvedSnapshot) — nunca um
      // reuse_adset cru (senão o apply leria AS-IS e a Meta ligaria expansão no default). Bug 3.
      const targeting = await resolveAudienceTargeting(input.audience, spec.targeting, async () => {
        const defaults = await getDefaults();
        const sourceAdsetId = defaults?.sourceAdsetId;
        const ctx = await getCtx();
        if (!sourceAdsetId || !ctx) return undefined;
        const profile = await deps.adsPlatform.getAudienceProfile(ctx.ref, sourceAdsetId);
        return profile ? { kind: "reuse_adset", sourceAdsetId, resolved: buildResolvedSnapshot(profile) } : undefined;
      });
      if (input.audience === "reuse" && targeting?.kind !== "reuse_adset") {
        return { ok: false, message: "não achei um público provado pra herdar nesta conta." };
      }
      if (targeting) edit.targeting = targeting;
    }

    // SUBSTITUIÇÃO TOTAL do público explícito (Slice 8) — o editor manda o estado COMPLETO resolvido
    // (raio/behaviors/grupos/públicos salvos) e também CONVERTE reuse/broad → explicit. Quando presente,
    // vence os diffs abaixo (que são o caminho antigo de edição incremental).
    if (input.explicitAudience) {
      edit.targeting = buildExplicitFromInput(input.explicitAudience);
    }

    // público EXPLÍCITO (Fase 1, subfatia 3b) — remove/adiciona geo(s) já resolvido pelo
    // autocomplete + estreita idade. Converge com o chat no mesmo núcleo (applyExplicitGeoEdit).
    if (!input.explicitAudience && spec.targeting?.kind === "explicit" && (input.removeGeo?.length || input.addGeo?.length || input.ageMin != null || input.ageMax != null || input.genders != null)) {
      const r = applyExplicitGeoEdit(spec.targeting, {
        ...(input.removeGeo ? { removeGeo: input.removeGeo } : {}),
        ...(input.addGeo ? { addGeo: input.addGeo } : {}),
        ...(input.ageMin != null ? { ageMin: input.ageMin } : {}),
        ...(input.ageMax != null ? { ageMax: input.ageMax } : {}),
        ...(input.genders != null ? { genders: input.genders } : {}),
      });
      if (r.kind === "blocked") return { ok: false, message: r.reason };
      edit.targeting = r.targeting;
    }

    // interesses do público EXPLÍCITO (Fase 2, subfatia 4) — remove/adiciona já resolvido pelo
    // autocomplete. Converge com o chat no mesmo núcleo (applyExplicitInterestEdit). Lê de
    // `edit.targeting` quando a geo já foi editada NESTE mesmo patch (evita perder a edição).
    if (!input.explicitAudience && (input.removeInterests?.length || input.addInterests?.length)) {
      const targetingBefore = edit.targeting ?? spec.targeting;
      if (targetingBefore?.kind !== "explicit") {
        return { ok: false, message: "esse rascunho não tem um público explícito pra editar interesses." };
      }
      const r = applyExplicitInterestEdit(targetingBefore, {
        ...(input.removeInterests ? { removeInterests: input.removeInterests } : {}),
        ...(input.addInterests ? { addInterests: input.addInterests } : {}),
      });
      if (r.kind === "blocked") return { ok: false, message: r.reason };
      edit.targeting = r.targeting;
    }

    if (input.creative) {
      const creative =
        input.creative.kind === "asset"
          ? await resolveLibraryCreative(orgId, accountId, input.creative.assetId)
          : await resolveServingCreative(orgId, accountId, input.creative.adId);
      if (!creative) return { ok: false, message: "não consegui usar esse criativo — tente outro." };
      edit.creative = creative;
    }

    if (input.copyEdits || input.removeAdIndex != null || input.addAd) {
      let variants = [...(spec.copyVariants ?? [])];
      for (const e of input.copyEdits ?? []) {
        const current = variants[e.index];
        if (!current) continue;
        // criativo PRÓPRIO do anúncio (Fatia 7): resolve biblioteca/ao-vivo → CreativeAssetRef; falha
        // = mantém o atual (não quebra a edição de copy). Só site (o chat não mexe em criativo).
        let ownCreative = current.creative;
        if (e.creative) {
          const resolved =
            e.creative.kind === "asset"
              ? await resolveLibraryCreative(orgId, accountId, e.creative.assetId)
              : await resolveServingCreative(orgId, accountId, e.creative.adId);
          if (!resolved) return { ok: false, message: "não consegui usar esse criativo — tente outro." };
          ownCreative = resolved;
        }
        variants[e.index] = {
          ...current,
          ...(e.primaryText !== undefined ? { primaryText: e.primaryText } : {}),
          ...(e.headline !== undefined ? { headline: e.headline } : {}),
          ...(e.description !== undefined ? { description: e.description } : {}),
          ...(e.cta !== undefined ? { cta: e.cta } : {}),
          ...(e.adName !== undefined ? { adName: e.adName } : {}),
          ...(ownCreative ? { creative: ownCreative } : {}),
        };
      }
      if (input.removeAdIndex != null) variants = variants.filter((_, i) => i !== input.removeAdIndex);
      // adiciona 1 anúncio DUPLICANDO o último (copy + criativo próprio) — preserva os existentes;
      // o dono edita a partir dele. Cap de anúncios/rascunho (rede contra explosão de custo/UI).
      // `adName` limpo no clone → cai no fallback indexado do apply (evita 2 anúncios com nome igual).
      if (input.addAd && variants.length > 0 && variants.length < MAX_ADS_PER_DRAFT) {
        const { adName: _drop, ...last } = variants[variants.length - 1]!;
        variants = [...variants, { ...last }];
      }
      edit.copyVariants = variants; // applyDraftEdit ressincroniza spec.variantsCount = copyVariants.length
    }

    const result = applyDraftEdit(kind, spec, edit, { budgetCapMinor, hasPixel });
    if (!result.ok) return { ok: false, message: refineErrorMessage(result.error) };

    const persisted = await persistDraftSpec(deps.db, { orgId, draftId, adAccountId: accountId }, result.value.spec);
    if (!persisted) return { ok: false, message: DRAFT_NOT_OPEN_MSG };
    return { ok: true };
  }

  return {
    updateDraft: updateDraftImpl,
    /**
     * Rascunhos de campanha aguardando aprovação (card de rascunho no inbox) — inclui os 2
     * momentos que compartilham o card (P0.1): `draft` (pedindo OK pra criar, gasto novo ainda
     * não existe) e `activation` (já criado PAUSADO, pedindo OK pra ativar). O site distingue
     * pelo `approvalKind` na resposta.
     */
    async listPendingDrafts(orgId: OrgId): Promise<DraftApprovalOutput[]> {
      const pending = (await deps.approvals.listPendingByOrg(orgId)).filter(
        (a) => a.kind === "draft" || a.kind === "activation",
      );
      if (pending.length === 0) return [];

      // sinais do "antes" por agente (cache — vários rascunhos podem ser do mesmo agente): guardrail
      // + criação habilitada (mesma fonte do apply-draft: resolveEnabledTools).
      const signalsCache = new Map<string, { dryRun: boolean; killSwitch: boolean; enabled: Set<string> }>();
      const signalsFor = async (agentId: string): Promise<{ dryRun: boolean; killSwitch: boolean; enabled: Set<string> }> => {
        const cached = signalsCache.get(agentId);
        if (cached) return cached;
        const [g] = await deps.db
          .select({ dryRun: guardrailConfigs.dryRun, killSwitch: guardrailConfigs.killSwitch, allowedActions: guardrailConfigs.allowedActions })
          .from(guardrailConfigs)
          .where(and(eq(guardrailConfigs.agentId, agentId), eq(guardrailConfigs.orgId, orgId)))
          .limit(1);
        const bindings = await deps.db
          .select({ toolKey: agentToolBindings.toolKey, mode: agentToolBindings.mode })
          .from(agentToolBindings)
          .where(and(eq(agentToolBindings.agentId, agentId), eq(agentToolBindings.orgId, orgId)));
        const bindingMap = new Map<string, ToolBindingMode>(bindings.map((b) => [b.toolKey, b.mode as ToolBindingMode]));
        const enabled = resolveEnabledTools(bindingMap, new Set((g?.allowedActions ?? []) as string[]));
        const s = { dryRun: g?.dryRun ?? false, killSwitch: g?.killSwitch ?? false, enabled };
        signalsCache.set(agentId, s);
        return s;
      };

      const out: DraftApprovalOutput[] = [];
      for (const appr of pending) {
        const [d] = await deps.db
          .select({
            id: campaignDrafts.id,
            kind: campaignDrafts.kind,
            origin: campaignDrafts.origin,
            spec: campaignDrafts.spec,
            sourceRef: campaignDrafts.sourceRef,
            accountId: campaignDrafts.adAccountId,
            createdIds: campaignDrafts.createdIds,
          })
          .from(campaignDrafts)
          .where(and(eq(campaignDrafts.id, appr.draftId), eq(campaignDrafts.orgId, orgId)))
          .limit(1);
        if (!d) continue;
        const [acc] = await deps.db
          .select({ name: adAccounts.name, status: adAccounts.status })
          .from(adAccounts)
          .where(and(eq(adAccounts.id, d.accountId), eq(adAccounts.orgId, orgId)))
          .limit(1);
        const spec = d.spec as CampaignDraftSpec;
        const sig = await signalsFor(appr.agentId);
        const creationToolKey = d.kind === "duplicate" ? "duplicate_scale" : "create_campaign";
        const applyPreview = computeApplyPreview({
          dryRun: sig.dryRun,
          killSwitch: sig.killSwitch,
          accountAvailable: acc?.status === "active",
          // ativação não tem gate de binding (só trava/conta/ensaio); criação = a capacidade habilitada.
          capabilityEnabled: appr.kind === "activation" ? true : sig.enabled.has(creationToolKey),
          kind: appr.kind,
        });
        out.push({
          id: appr.id,
          approvalKind: appr.kind,
          applyPreview,
          accountId: d.accountId,
          accountName: acc?.name ?? "conta",
          status: appr.status,
          expiresAt: appr.expiresAt ? appr.expiresAt.toISOString() : null,
          draftId: d.id,
          kind: d.kind,
          origin: d.origin,
          objective: spec.objective ?? null,
          dailyBudgetMajor: minorToMajor(spec.dailyBudgetMinor, spec.currency),
          clampedFromMajor:
            spec.requestedDailyBudgetMinor && spec.requestedDailyBudgetMinor > spec.dailyBudgetMinor
              ? minorToMajor(spec.requestedDailyBudgetMinor, spec.currency)
              : null,
          currency: spec.currency,
          activation: spec.activation,
          sourceLevel: d.sourceRef?.level ?? null,
          sourceName: d.sourceRef?.name ?? null,
          pageId: spec.pageId ?? null,
          pixelId: spec.pixelId ?? null,
          campaignName: spec.campaignName ?? null,
          adsetName: spec.adsetName ?? null,
          suffixLabel: spec.suffixLabel ?? null,
          variantsCount: spec.variantsCount ?? null,
          copyVariants: spec.copyVariants
            ? spec.copyVariants.map((c) => ({
                primaryText: c.primaryText,
                headline: c.headline,
                description: c.description ?? null,
                cta: c.cta ?? null,
                adName: c.adName ?? null,
                creative: c.creative ? { format: c.creative.format, origin: c.creative.origin } : null,
              }))
            : null,
          creative: spec.creative ? { format: spec.creative.format, origin: spec.creative.origin } : null,
          audience:
            spec.targeting?.kind === "reuse_adset" ? "reuse" : spec.targeting?.kind === "advantage_plus" ? "broad" : null,
          explicitAudience: spec.targeting?.kind === "explicit" ? serializeExplicitAudience(spec.targeting) : null,
          // semente do CONVERTER MODO: rascunho reuse com retrato → geo/idade herdados; broad → vazio.
          // TOLERÂNCIA (rascunho antigo): reuse SEM `resolved` (proposto por worker pré-snapshot)
          // ainda vira convertível com semente vazia — o editor abre e o dono monta o público do
          // zero. Não resolvemos ao vivo aqui de propósito: /approvals é lista (N chamadas Meta =
          // latência + rate-limit); rascunho é transitório (24h) e o novo já nasce com `resolved`.
          convertibleAudience:
            spec.targeting?.kind === "reuse_adset"
              ? spec.targeting.resolved
                ? {
                    geo: flattenSnapshotGeoForOutput(spec.targeting.resolved.geo),
                    ageMin: spec.targeting.resolved.ageMin ?? null,
                    ageMax: spec.targeting.resolved.ageMax ?? null,
                  }
                : { geo: [], ageMin: null, ageMax: null }
              : spec.targeting?.kind === "advantage_plus"
                ? { geo: [], ageMin: null, ageMax: null }
                : null,
          createdIds: appr.kind === "activation" ? (d.createdIds as Record<string, unknown>) : null,
        });
      }
      return out;
    },

    /**
     * Escala um vencedor (CTA do site). Escala inteligente por passo: raise → aprovação de
     * AÇÃO (adjust_budget); duplicate → rascunho (campaign_drafts + aprovação de rascunho).
     */
    async scaleWinner(
      orgId: OrgId,
      accountId: string,
      input: ScaleWinnerInput,
    ): Promise<ScaleWinnerOutput | null> {
      const ctx = await loadScaleContext(orgId, accountId);
      if (!ctx) return null;

      // Gate por binding (A2): escalar precisa de ao menos uma capacidade — subir budget
      // (adjust_budget) OU duplicar (duplicate_scale). Ambas desligadas → escala indisponível
      // (o CTA já some no site). Os ramos concretos abaixo também barram a sua capacidade.
      const canRaise = ctx.enabled.has("adjust_budget");
      const canDuplicate = ctx.enabled.has("duplicate_scale");
      if (!canRaise && !canDuplicate) return null;

      const state = await deps.adsPlatform.readEntityState(ctx.ref, input.entityId);
      const sourceDailyMinor = Number(state["daily_budget"] ?? 0);
      const budgetLevel: BudgetLevel =
        input.entityLevel === "adset" && sourceDailyMinor > 0 ? "adset" : "campaign";

      const scalePct = ctx.cfg.scalePct ?? 50;
      let move = planScaleMove({
        scalePct,
        maxBudgetChangePct: ctx.cfg.maxBudgetChangePct,
        budgetLevel,
        preference: ctx.scaleAggressivePreference,
        ...(input.choice ? { choice: input.choice } : {}),
      });
      const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS);

      // passo agressivo, intent aberto, sem resposta ainda → PERGUNTA (nada é criado).
      // O site renderiza as 2 opções e re-chama com `choice`; o chat pergunta e reusa o mesmo caminho.
      // Só oferece o que está habilitado: capacidade off → força o outro ramo (sem "ask" morto).
      if (move.move === "ask") {
        if (canRaise && canDuplicate) {
          return { move: "ask", raisePct: move.raisePct, duplicatePct: move.duplicatePct };
        }
        move = canRaise
          ? { move: "raise_budget", pct: move.raisePct, level: budgetLevel }
          : { move: "duplicate", scalePct: move.duplicatePct };
      }

      // capacidade concreta desligada → escala indisponível por esse ramo (rede; o CTA some no site).
      if (move.move === "raise_budget" && !canRaise) return null;
      if (move.move === "duplicate" && !canDuplicate) return null;

      if (move.move === "raise_budget") {
        const action: Action = {
          id: `scale:${input.entityId}`,
          type: "adjust_budget",
          target: { level: input.entityLevel, id: input.entityId },
          params: { [ACTION_PARAM_MODE]: BUDGET_MODE_INCREASE, [ACTION_PARAM_PCT]: move.pct },
          source: "llm",
          riskLevel: "medium",
          reason: `escalar o vencedor: +${move.pct}% de budget`,
        };
        const appr = await deps.approvals.upsertPending({
          orgId,
          agentId: ctx.agentId as AgentId,
          runId: null,
          action,
          expiresAt,
        });
        return { move: "raise_budget", approvalId: appr.id };
      }

      // duplicate: budget novo = source * (1 + scalePct%), JÁ clampado ao teto de gasto novo
      // aqui (o card mostra o valor real; o guardrail do apply é rede redundante). §8.
      const requestedMinor = Math.round(sourceDailyMinor * (1 + move.scalePct / 100));
      const cap = ctx.cfg.maxNewDailyBudgetMinor;
      const newDailyBudgetMinor = cap != null ? Math.min(requestedMinor, cap) : requestedMinor;
      const spec: CampaignDraftSpec = {
        version: 1,
        currency: ctx.currency,
        dailyBudgetMinor: newDailyBudgetMinor,
        ...(newDailyBudgetMinor < requestedMinor ? { requestedDailyBudgetMinor: requestedMinor } : {}),
        // G4: respeita a política do agente (default "paused" → 2ª aprovação de ativação), igual ao
        // chat. Antes hardcodava "active" → a escala pelo site ia ao ar com 1 OK, furando o §7.
        activation: ctx.creationActivation,
      };
      const [draftRow] = await deps.db
        .insert(campaignDrafts)
        .values({
          orgId,
          adAccountId: accountId,
          agentId: ctx.agentId,
          kind: "duplicate",
          status: "proposed",
          origin: "on_demand",
          spec,
          sourceRef: { level: input.entityLevel, id: input.entityId, ...(input.entityName ? { name: input.entityName } : {}) },
        })
        .returning({ id: campaignDrafts.id });

      const appr = await deps.approvals.upsertDraftPending({
        orgId,
        agentId: ctx.agentId as AgentId,
        runId: null,
        contactId: null,
        draftId: draftRow!.id as DraftId,
        expiresAt,
      });
      return { move: "duplicate", approvalId: appr.id };
    },

    /** Biblioteca de criativos da conta (aba Criativos). */
    async listCreatives(orgId: OrgId, accountId: string): Promise<CreativeAssetOutput[]> {
      const rows = await deps.db
        .select({
          id: creativeAssets.id,
          origin: creativeAssets.origin,
          format: creativeAssets.format,
          status: creativeAssets.status,
          metaImageHash: creativeAssets.metaImageHash,
          metaVideoId: creativeAssets.metaVideoId,
          createdAt: creativeAssets.createdAt,
        })
        .from(creativeAssets)
        // arquivados (soft-delete) somem da biblioteca — não são oferecidos pra reuso.
        .where(and(eq(creativeAssets.orgId, orgId), eq(creativeAssets.adAccountId, accountId), isNull(creativeAssets.archivedAt)))
        .orderBy(desc(creativeAssets.createdAt));
      return rows.map((r) => ({
        id: r.id,
        origin: r.origin,
        format: r.format,
        status: r.status,
        metaImageHash: r.metaImageHash,
        metaVideoId: r.metaVideoId,
        createdAt: r.createdAt.toISOString(),
      }));
    },

    /** Troca o criativo de um rascunho `from_scratch` proposto (picker "trocar criativo"). Org-scoped;
     *  só rascunho aberto da mesma conta. `asset` = upload da biblioteca; `serving` = reuse de um
     *  anúncio ao vivo (busca o video_id FRESCO). null → 404 (não editável / criativo inválido). */
    /** Troca o criativo de um rascunho (picker) — DELEGA ao `updateDraft` (via única). Propaga o
     *  resultado tipado (ok/message) → a rota devolve 422 com a mensagem GRANULAR (não um 404 cego). */
    async setDraftCreative(
      orgId: OrgId,
      accountId: string,
      draftId: string,
      input: SetDraftCreativeInput,
    ): Promise<{ ok: true } | { ok: false; message: string }> {
      return updateDraftImpl(orgId, accountId, draftId, { creative: input });
    },

    /** Alterna o PÚBLICO de um rascunho (card /approvals) — DELEGA ao `updateDraft` (via única).
     *  Propaga a mensagem granular do núcleo (ex.: "não achei um público provado pra herdar"). */
    async setDraftTargeting(
      orgId: OrgId,
      accountId: string,
      draftId: string,
      audience: "reuse" | "broad",
    ): Promise<{ ok: true; audience: "reuse" | "broad" } | { ok: false; message: string }> {
      const r = await updateDraftImpl(orgId, accountId, draftId, { audience });
      return r.ok ? { ok: true, audience } : r;
    },

    /** Estimativa de alcance (Slice 7) — recalcula ao editar o público no site. Monta o targeting
     *  EXPLÍCITO a partir do que o editor mandou (já resolvido) + objetivo/pixel do rascunho, e
     *  devolve a nota legível (ou null quando a Meta não estimou / público abaixo do piso). */
    async estimateDelivery(
      orgId: OrgId,
      accountId: string,
      draftId: string,
      input: DeliveryEstimateInput,
    ): Promise<{ ok: true; note: string | null } | { ok: false; message: string }> {
      const loaded = await loadDraftForEdit(deps.db, { orgId, draftId, adAccountId: accountId });
      if (!loaded) return { ok: false, message: DRAFT_NOT_OPEN_MSG };
      const ctx = await loadScaleContext(orgId, accountId);
      if (!ctx) return { ok: false, message: ACCOUNT_UNAVAILABLE_MSG };
      const targeting: TargetingSpec = buildExplicitFromInput(input);
      const goal = loaded.spec.objective ?? "lead";
      try {
        const estimate = await deps.adsPlatform.getDeliveryEstimate(ctx.ref, { targeting, goal, ...(loaded.spec.pixelId ? { pixelId: loaded.spec.pixelId } : {}) });
        return { ok: true, note: describeDeliveryEstimate(estimate) };
      } catch {
        return { ok: true, note: null }; // estimativa é enriquecimento — nunca vira erro pro usuário
      }
    },

    /** Busca de geo (Fase 1, subfatia 3b) — autocomplete de cidade/região/país no editor de
     *  rascunho. Conta/agente inexistente → array vazio (o front trata como "sem resultado",
     *  não erro — mesma honestidade do fluxo por chat, sem vazar detalhe técnico). */
    async searchGeo(orgId: OrgId, accountId: string, query: string): Promise<GeoSearchResultOutput[]> {
      const ctx = await loadScaleContext(orgId, accountId);
      if (!ctx) return [];
      const results = await deps.adsPlatform.searchGeo(ctx.ref, query, ["country", "region", "city"]);
      return results.map((r) => ({ key: r.key, name: r.name, kind: r.kind, countryCode: r.countryCode ?? null }));
    },

    /** Busca de interesses (Fase 2, subfatia 4) — autocomplete no editor de rascunho. Mesma
     *  honestidade do `searchGeo`: conta/agente inexistente → array vazio, não erro. */
    async searchInterests(orgId: OrgId, accountId: string, query: string): Promise<InterestSearchResultOutput[]> {
      const ctx = await loadScaleContext(orgId, accountId);
      if (!ctx) return [];
      const results = await deps.adsPlatform.searchInterests(ctx.ref, query);
      return results.map((r) => ({ id: r.id, name: r.name, audienceSize: r.audienceSize ?? null, path: r.path ? [...r.path] : null }));
    },

    /** Busca de comportamentos (Slice 8) — autocomplete no editor (filtro local sobre a enum cacheada). */
    async searchBehaviors(orgId: OrgId, accountId: string, query: string): Promise<InterestSearchResultOutput[]> {
      const ctx = await loadScaleContext(orgId, accountId);
      if (!ctx) return [];
      const results = await deps.adsPlatform.searchBehaviors(ctx.ref, query);
      return results.map((r) => ({ id: r.id, name: r.name, audienceSize: r.audienceSize ?? null, path: r.path ? [...r.path] : null }));
    },

    /** Públicos salvos da conta (Slice 8) — o editor lista e filtra local (include/exclude). */
    async listAudiences(orgId: OrgId, accountId: string): Promise<AudienceOutput[]> {
      const ctx = await loadScaleContext(orgId, accountId);
      if (!ctx) return [];
      const results = await deps.adsPlatform.listCustomAudiences(ctx.ref);
      return results.map((a) => ({ id: a.id, name: a.name, isLookalike: a.isLookalike ?? false, approximateCount: a.approximateCount ?? null }));
    },

    /** Anúncios AO VIVO da conta oferecidos como candidatos de reuse no picker (lê ad_creatives,
     *  ranqueado campeã→pior). Só VÍDEO por ora (imagem ao vivo precisa de image_hash — fast-follow);
     *  o pick fresco (setDraftCreative serving) confirma o video_id atual. */
    async listServingCreatives(orgId: OrgId, accountId: string): Promise<ServingCreativeOutput[]> {
      const rows = await deps.db
        .select({
          adId: adCreatives.adId,
          title: adCreatives.title,
          body: adCreatives.body,
          callToAction: adCreatives.callToAction,
          tier: adCreatives.tier,
          videoId: adCreatives.videoId,
          imageHash: adCreatives.imageHash,
          imageUrl: adCreatives.imageUrl,
          thumbnailUrl: adCreatives.thumbnailUrl,
        })
        .from(adCreatives)
        .where(and(eq(adCreatives.adAccountId, accountId), eq(adCreatives.orgId, orgId)))
        // ordena por DATA (mais recente capturado primeiro) — o usuário acha o criativo novo; o
        // picker trunca + "ver mais" + busca. Cap de segurança (paginação server-side = fast-follow).
        .orderBy(desc(adCreatives.capturedAt))
        .limit(SERVING_PICKER_CAP);
      // reusável ao vivo = VÍDEO (video_id) OU IMAGEM (image_hash). O pick fresco confirma na Meta.
      return rows
        .filter((r) => r.videoId || r.imageHash)
        .map((r) => ({
          adId: r.adId,
          title: r.title,
          copy: r.body,
          cta: r.callToAction,
          tier: r.tier,
          format: r.videoId ? ("video" as const) : ("image" as const),
          thumbnailUrl: r.thumbnailUrl ?? r.imageUrl,
        }));
    },

    /** Blob original de um criativo (preview). Org-scoped pelo assetId — nunca confia em ref
     *  do cliente. Devolve bytes+contentType+etag (content-addressed) ou null (404). */
    async getCreativeBlob(
      orgId: OrgId,
      accountId: string,
      assetId: string,
    ): Promise<{ bytes: Uint8Array; contentType: string; etag: string } | null> {
      const [row] = await deps.db
        .select({ storageRef: creativeAssets.storageRef })
        .from(creativeAssets)
        .where(
          and(
            eq(creativeAssets.id, assetId),
            eq(creativeAssets.orgId, orgId),
            eq(creativeAssets.adAccountId, accountId),
          ),
        )
        .limit(1);
      if (!row?.storageRef) return null;
      return deps.storage.get(row.storageRef);
    },

    /**
     * Miniatura de um criativo da BIBLIOTECA (aba Criativos). IMAGEM → serve o blob original
     * (content-addressed, mesma fonte do /blob). VÍDEO → o `<img>` não renderiza o arquivo de
     * vídeo, então busca um frame HD FRESCO da Meta (getVideoFrames pelo metaVideoId) e faz stream
     * dos bytes — a URL do fbcdn expira, nunca a mandamos crua pro browser. ETag estável pelo id do
     * criativo (metaVideoId) → o browser cacheia e revalida com 304 SEM tocar na Meta. Vídeo ainda
     * `pending` (Meta processando) ou sem frame acessível (token sem permissão, #10) → null → o card
     * cai no placeholder. Org-scoped pelo assetId; `null` = 404 (criativo/preview indisponível).
     */
    async getCreativeThumb(
      orgId: OrgId,
      accountId: string,
      assetId: string,
      ifNoneMatch?: string,
    ): Promise<{ notModified: true; etag: string } | { bytes: Uint8Array; contentType: string; etag: string } | null> {
      const [row] = await deps.db
        .select({
          format: creativeAssets.format,
          status: creativeAssets.status,
          storageRef: creativeAssets.storageRef,
          metaVideoId: creativeAssets.metaVideoId,
        })
        .from(creativeAssets)
        .where(
          and(
            eq(creativeAssets.id, assetId),
            eq(creativeAssets.orgId, orgId),
            eq(creativeAssets.adAccountId, accountId),
          ),
        )
        .limit(1);
      if (!row) return null;

      // imagem → blob original (mesma fonte do /blob; ETag content-addressed do próprio blob).
      if (row.format === "image") {
        if (!row.storageRef) return null;
        const blob = await deps.storage.get(row.storageRef);
        return blob ? { bytes: blob.bytes, contentType: blob.contentType, etag: blob.etag } : null;
      }

      // vídeo → só quando PRONTO (Meta terminou de processar) e com video_id.
      if (row.status !== "ready" || !row.metaVideoId) return null;
      const etag = createHash("sha256").update(`creative-thumb:${row.metaVideoId}`).digest("hex").slice(0, 32);
      if (ifNoneMatch === `"${etag}"`) return { notModified: true, etag };

      const ctx = await loadScaleContext(orgId, accountId);
      if (!ctx) return null;
      const url = (await deps.adsPlatform.getVideoFrames(ctx.ref, row.metaVideoId))[0];
      if (!url) return null;
      const img = await fetchThumbImage(url);
      return img ? { bytes: img.bytes, contentType: img.contentType, etag } : null;
    },

    /**
     * Miniatura ESTÁVEL de um ANÚNCIO da conta (picker "trocar criativo" → seção "anúncios da conta").
     * Igual à da biblioteca: busca FRESCO da Meta (frame HD do vídeo / imagem do anúncio) e faz stream
     * dos bytes — a URL do fbcdn EXPIRA, nunca a mandamos crua pro browser (era a causa do "sem
     * preview"). ETag estável pelo id do vídeo/hash → 304 sem tocar na Meta. Org-scoped pelo adId;
     * `null` = 404 (anúncio/preview indisponível).
     */
    async getServingCreativeThumb(
      orgId: OrgId,
      accountId: string,
      adId: string,
      ifNoneMatch?: string,
    ): Promise<{ notModified: true; etag: string } | { bytes: Uint8Array; contentType: string; etag: string } | null> {
      const [row] = await deps.db
        .select({ videoId: adCreatives.videoId, imageHash: adCreatives.imageHash })
        .from(adCreatives)
        .where(and(eq(adCreatives.adId, adId), eq(adCreatives.adAccountId, accountId), eq(adCreatives.orgId, orgId)))
        .limit(1);
      if (!row) return null;
      const stableId = row.videoId ?? row.imageHash ?? adId;
      const etag = createHash("sha256").update(`serving-thumb:${stableId}`).digest("hex").slice(0, 32);
      if (ifNoneMatch === `"${etag}"`) return { notModified: true, etag };

      const ctx = await loadScaleContext(orgId, accountId);
      if (!ctx) return null;
      const url = await resolveLiveThumbUrl(ctx.ref, adId, row.videoId ?? null);
      if (!url) return null;
      const img = await fetchThumbImage(url);
      return img ? { bytes: img.bytes, contentType: img.contentType, etag } : null;
    },

    /**
     * Miniatura do criativo de um rascunho (card /approvals) — FIEL ao spec + cache HTTP por ETag
     * estável. `upload` → blob do StoragePort (mesmo lookup do getCreativeBlob). `reuse` → busca
     * FRESCO da Meta (getVideoFrames p/ vídeo HD, getCreatives p/ imagem) e faz stream dos bytes —
     * a URL do fbcdn expira, então nunca a mandamos crua pro browser. O ETag é estável pelo id do
     * criativo (metaVideoId/hash) → o browser cacheia e revalida com 304 SEM tocar na Meta. Cache
     * COMPARTILHADO no StoragePort (1 fetch serve todos os viewers) = fast-follow. Org-scoped pelo
     * draftId; `null` = 404 (rascunho/criativo/preview indisponível).
     */
    async getDraftCreativeThumb(
      orgId: OrgId,
      accountId: string,
      draftId: string,
      ifNoneMatch?: string,
      adIndex?: number,
    ): Promise<{ notModified: true; etag: string } | { bytes: Uint8Array; contentType: string; etag: string } | null> {
      const [draft] = await deps.db
        .select({ spec: campaignDrafts.spec })
        .from(campaignDrafts)
        .where(and(eq(campaignDrafts.id, draftId), eq(campaignDrafts.orgId, orgId), eq(campaignDrafts.adAccountId, accountId)))
        .limit(1);
      if (!draft) return null;
      const spec = draft.spec as CampaignDraftSpec;
      // Preview POR ANÚNCIO (G): resolve o criativo próprio do anúncio, caindo no criativo padrão do
      // rascunho quando o anúncio não tem um seu (ou quando `adIndex` ausente = thumb geral).
      const creative =
        (adIndex !== undefined ? spec.copyVariants?.[adIndex]?.creative : undefined) ?? spec.creative;
      if (!creative) return null;

      // upload → blob do StoragePort (content-addressed; ETag do próprio blob).
      if (creative.origin === "upload") {
        const [row] = await deps.db
          .select({ storageRef: creativeAssets.storageRef })
          .from(creativeAssets)
          .where(and(eq(creativeAssets.id, creative.assetId), eq(creativeAssets.orgId, orgId), eq(creativeAssets.adAccountId, accountId)))
          .limit(1);
        if (!row?.storageRef) return null;
        const blob = await deps.storage.get(row.storageRef);
        return blob ? { bytes: blob.bytes, contentType: blob.contentType, etag: blob.etag } : null;
      }

      // reuse → ETag ESTÁVEL pelo id do criativo: revalidação (If-None-Match) responde 304 sem
      // NENHUMA chamada à Meta. Só busca fresco no miss.
      const stableId = creative.metaVideoId ?? creative.metaImageHash ?? creative.assetId;
      const etag = createHash("sha256").update(`draft-thumb:${stableId}`).digest("hex").slice(0, 32);
      if (ifNoneMatch === `"${etag}"`) return { notModified: true, etag };

      const ctx = await loadScaleContext(orgId, accountId);
      if (!ctx) return null;
      // frames HD do vídeo — MAS o System User token pode não ter permissão pro endpoint
      // `/{video_id}?fields=thumbnails` (erro Meta #10). Sem frames, cai no thumbnail do ANÚNCIO
      // (getCreatives), que é acessível — o card é 64px, então o selo já basta. (helper compartilhado)
      const url = await resolveLiveThumbUrl(ctx.ref, creative.assetId, creative.format === "video" ? creative.metaVideoId ?? null : null);
      if (!url) return null;
      const img = await fetchThumbImage(url);
      return img ? { bytes: img.bytes, contentType: img.contentType, etag } : null;
    },

    /**
     * Exclui um criativo da biblioteca — HÍBRIDO com guarda de referência (fast-follow #707).
     * Org-scoped pelo assetId (nunca confia no cliente). NUNCA quebra nada:
     *  - EM USO (algum `campaign_drafts` `proposed`/`creating`/`created` referencia
     *    `spec.creative.assetId`) → **arquiva** (soft): seta `archived_at`, mantém linha+blob
     *    (preview de rascunho antigo + histórico seguem; a Meta é independente do nosso blob) e
     *    o asset some da biblioteca/picker → não é mais oferecido pra reuso.
     *  - LIVRE (zero referências) → **apaga de vez**: blob no storage (idempotente) + a linha.
     * `null` = não existe (404); `{ok:true, archived:true|false}` = arquivado × excluído.
     */
    async deleteCreative(
      orgId: OrgId,
      accountId: string,
      assetId: string,
    ): Promise<{ ok: true; archived: boolean } | null> {
      const [row] = await deps.db
        .select({ storageRef: creativeAssets.storageRef })
        .from(creativeAssets)
        .where(
          and(
            eq(creativeAssets.id, assetId),
            eq(creativeAssets.orgId, orgId),
            eq(creativeAssets.adAccountId, accountId),
          ),
        )
        .limit(1);
      if (!row) return null;

      const [{ n } = { n: 0 }] = await deps.db
        .select({ n: count() })
        .from(campaignDrafts)
        .where(
          and(
            eq(campaignDrafts.orgId, orgId),
            eq(campaignDrafts.adAccountId, accountId),
            inArray(campaignDrafts.status, ["proposed", "creating", "created"]),
            sql`${campaignDrafts.spec} -> 'creative' ->> 'assetId' = ${assetId}`,
          ),
        );

      const scope = and(
        eq(creativeAssets.id, assetId),
        eq(creativeAssets.orgId, orgId),
        eq(creativeAssets.adAccountId, accountId),
      );
      if (n > 0) {
        // em uso → arquiva (mantém a ref pra não quebrar nada; some das listagens/picker).
        await deps.db.update(creativeAssets).set({ archivedAt: sql`now()` }).where(scope);
        return { ok: true, archived: true };
      }
      // livre → apaga de vez. Blob antes da linha → se o storage falhar, a linha fica (retry).
      if (row.storageRef) await deps.storage.delete(row.storageRef);
      await deps.db.delete(creativeAssets).where(scope);
      return { ok: true, archived: false };
    },

    /** Upload de criativo pela web (multipart, imagem OU vídeo) → StoragePort → Meta
     *  (image_hash / video_id) → asset. Vídeo processa async (pending + poll). Mesma
     *  ingestão do intake WhatsApp (convergência). */
    async uploadCreative(
      orgId: OrgId,
      accountId: string,
      input: UploadCreativeArgs,
    ): Promise<UploadCreativeOutput | null> {
      const ctx = await loadScaleContext(orgId, accountId);
      if (!ctx) return null;
      const common = { orgId, adAccountId: accountId, ref: ctx.ref, bytes: input.bytes, contentType: input.contentType, filename: input.filename };

      if (ALLOWED_VIDEO_TYPES.has(input.contentType)) {
        const v = await ingestCreativeVideo({ db: deps.db, storage: deps.storage, ads: deps.adsPlatform }, common);
        // vídeo novo (não deduped-ready) → enfileira o poll que flipa pending→ready/error.
        if (v.status === "pending") {
          await deps.scheduler.enqueue(
            buildCreativeVideoPollJob({ orgId, adAccountId: accountId, assetId: v.assetId, metaVideoId: v.metaVideoId, attempt: 1 }),
          );
        }
        return { assetId: v.assetId, format: "video", status: v.status, metaImageHash: null, metaVideoId: v.metaVideoId };
      }

      const img = await ingestCreativeImage({ db: deps.db, storage: deps.storage, ads: deps.adsPlatform }, common);
      // imagem já `ready` → analisa a visão 1x (cache), pra biblioteca ter a descrição.
      await deps.scheduler.enqueue(buildCreativeAnalyzeJob({ orgId, adAccountId: accountId, assetId: img.assetId }));
      return { assetId: img.assetId, format: "image", status: "ready", metaImageHash: img.metaImageHash, metaVideoId: null };
    },
  };
}

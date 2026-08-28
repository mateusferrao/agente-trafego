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
import { planScaleMove, rankAdCreatives, resolveEnabledTools, type BudgetLevel, type ScaleAggressivePreference } from "@trafego/core";
import type { ToolBindingMode } from "@trafego/shared";
import {
  ACTION_PARAM_MODE,
  ACTION_PARAM_PCT,
  APPROVAL_TTL_HOURS,
  BUDGET_MODE_INCREASE,
  DEFAULT_CURRENCY,
  buildCreativeAnalyzeJob,
  buildCreativeVideoPollJob,
  toGuardrailConfig,
  type CampaignDraftSpec,
} from "@trafego/shared";
import type { Action, AgentId, CreativeAssetRef, DraftId, OrgId, TargetingSpec } from "@trafego/shared/types";
import type { AdAccountRef, ApprovalPort, CredentialVaultPort, SchedulerPort, StoragePort } from "@trafego/shared/ports";
import type { AdsPlatformPort } from "@trafego/shared/ports";
import { ingestCreativeImage, ingestCreativeVideo } from "@trafego/creative-library";
import type {
  CreativeAssetOutput,
  DraftApprovalOutput,
  ScaleWinnerInput,
  ScaleWinnerOutput,
  ServingCreativeOutput,
  SetDraftCreativeInput,
  UploadCreativeArgs,
  UploadCreativeOutput,
} from "./schema.js";

/** Content-types aceitos no upload (declarado + allowlist; a Meta rejeita o resto na subida). */
const ALLOWED_IMAGE_TYPES: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const ALLOWED_VIDEO_TYPES: ReadonlySet<string> = new Set(["video/mp4", "video/quicktime"]);
export function isAllowedCreativeType(contentType: string): boolean {
  return ALLOWED_IMAGE_TYPES.has(contentType) || ALLOWED_VIDEO_TYPES.has(contentType);
}

// unidade menor → maior. Assume moeda de 2 casas (BRL/USD/EUR); moedas sem centavos
// (JPY/CLP) = fast-follow (derivar a subunidade da moeda). Beta é BRL.
const MINOR_PER_UNIT = 100;
const APPROVAL_TTL_MS = APPROVAL_TTL_HOURS * 60 * 60 * 1000;
/** Teto de tempo e tamanho do fetch da miniatura (fbcdn) — não pendura o handler da API nem
 *  materializa payload gigante em memória (a thumb da Meta é pequena; isto é a rede de segurança). */
const THUMB_FETCH_TIMEOUT_MS = 8000;
const THUMB_MAX_BYTES = 5 * 1024 * 1024;

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
      enabled,
    };
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

  /** Ref de reuse de um anúncio AO VIVO (ad id da Meta): busca o video_id FRESCO (não o
   *  ad_creatives stale). Só vídeo hoje — imagem ao vivo precisa de image_hash (fast-follow). */
  async function resolveServingCreative(orgId: OrgId, accountId: string, adId: string): Promise<CreativeAssetRef | null> {
    const ctx = await loadScaleContext(orgId, accountId);
    if (!ctx) return null;
    const [c] = await deps.adsPlatform.getCreatives(ctx.ref, [adId]);
    if (!c?.videoId) return null;
    return { assetId: adId, format: "video", origin: "reuse", metaVideoId: c.videoId };
  }

  return {
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
          .select({ name: adAccounts.name })
          .from(adAccounts)
          .where(and(eq(adAccounts.id, d.accountId), eq(adAccounts.orgId, orgId)))
          .limit(1);
        const spec = d.spec as CampaignDraftSpec;
        out.push({
          id: appr.id,
          approvalKind: appr.kind,
          accountId: d.accountId,
          accountName: acc?.name ?? "conta",
          status: appr.status,
          expiresAt: appr.expiresAt ? appr.expiresAt.toISOString() : null,
          draftId: d.id,
          kind: d.kind,
          origin: d.origin,
          objective: spec.objective ?? null,
          dailyBudgetMajor: spec.dailyBudgetMinor / MINOR_PER_UNIT,
          clampedFromMajor:
            spec.requestedDailyBudgetMinor && spec.requestedDailyBudgetMinor > spec.dailyBudgetMinor
              ? spec.requestedDailyBudgetMinor / MINOR_PER_UNIT
              : null,
          currency: spec.currency,
          activation: spec.activation,
          sourceLevel: d.sourceRef?.level ?? null,
          sourceName: d.sourceRef?.name ?? null,
          pageId: spec.pageId ?? null,
          pixelId: spec.pixelId ?? null,
          variantsCount: spec.variantsCount ?? null,
          copyVariants: spec.copyVariants
            ? spec.copyVariants.map((c) => ({
                primaryText: c.primaryText,
                headline: c.headline,
                description: c.description ?? null,
                cta: c.cta ?? null,
              }))
            : null,
          creative: spec.creative ? { format: spec.creative.format, origin: spec.creative.origin } : null,
          audience:
            spec.targeting?.kind === "reuse_adset" ? "reuse" : spec.targeting?.kind === "advantage_plus" ? "broad" : null,
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
        activation: "active",
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
    async setDraftCreative(
      orgId: OrgId,
      accountId: string,
      draftId: string,
      input: SetDraftCreativeInput,
    ): Promise<{ ok: true } | null> {
      const [draft] = await deps.db
        .select({ spec: campaignDrafts.spec, kind: campaignDrafts.kind, status: campaignDrafts.status })
        .from(campaignDrafts)
        .where(
          and(
            eq(campaignDrafts.id, draftId),
            eq(campaignDrafts.orgId, orgId),
            eq(campaignDrafts.adAccountId, accountId),
          ),
        )
        .limit(1);
      if (!draft || draft.status !== "proposed" || draft.kind !== "from_scratch") return null;
      const creative =
        input.kind === "asset"
          ? await resolveLibraryCreative(orgId, accountId, input.assetId)
          : await resolveServingCreative(orgId, accountId, input.adId);
      if (!creative) return null;
      const spec = draft.spec as CampaignDraftSpec;
      await deps.db
        .update(campaignDrafts)
        .set({ spec: { ...spec, creative } })
        .where(eq(campaignDrafts.id, draftId));
      return { ok: true };
    },

    /** Alterna o PÚBLICO de um rascunho from_scratch proposto (card /approvals). `broad` = Advantage+
     *  (a Meta escolhe). `reuse` = herda o conjunto provado — reusa o que já está no spec, senão
     *  re-infere ao vivo (inferCreationDefaults); sem conjunto provado disponível → null (nada pra
     *  herdar). Org-scoped; só rascunho aberto. */
    async setDraftTargeting(
      orgId: OrgId,
      accountId: string,
      draftId: string,
      audience: "reuse" | "broad",
    ): Promise<{ ok: true; audience: "reuse" | "broad" } | null> {
      const [draft] = await deps.db
        .select({ spec: campaignDrafts.spec, kind: campaignDrafts.kind, status: campaignDrafts.status })
        .from(campaignDrafts)
        .where(and(eq(campaignDrafts.id, draftId), eq(campaignDrafts.orgId, orgId), eq(campaignDrafts.adAccountId, accountId)))
        .limit(1);
      if (!draft || draft.status !== "proposed" || draft.kind !== "from_scratch") return null;
      const spec = draft.spec as CampaignDraftSpec;

      let targeting: TargetingSpec;
      if (audience === "broad") {
        targeting = { kind: "advantage_plus" };
      } else if (spec.targeting?.kind === "reuse_adset") {
        targeting = spec.targeting; // já herda — mantém o conjunto
      } else {
        const ctx = await loadScaleContext(orgId, accountId);
        if (!ctx) return null;
        const defaults = await deps.adsPlatform.inferCreationDefaults(ctx.ref);
        if (!defaults.sourceAdsetId) return null; // sem público provado pra herdar
        targeting = { kind: "reuse_adset", sourceAdsetId: defaults.sourceAdsetId };
      }
      await deps.db
        .update(campaignDrafts)
        .set({ spec: { ...spec, targeting } })
        .where(eq(campaignDrafts.id, draftId));
      return { ok: true, audience };
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
          thumbnailUrl: adCreatives.thumbnailUrl,
          spend: adCreatives.spend,
          cpa: adCreatives.cpa,
          roas: adCreatives.roas,
        })
        .from(adCreatives)
        .where(and(eq(adCreatives.adAccountId, accountId), eq(adCreatives.orgId, orgId)));
      return rankAdCreatives(rows)
        .filter((r) => r.videoId) // reusável ao vivo = vídeo (imagem = fast-follow)
        .map((r) => ({
          adId: r.adId,
          title: r.title,
          copy: r.body,
          cta: r.callToAction,
          tier: r.tier,
          format: "video" as const,
          thumbnailUrl: r.thumbnailUrl,
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
    ): Promise<{ notModified: true; etag: string } | { bytes: Uint8Array; contentType: string; etag: string } | null> {
      const [draft] = await deps.db
        .select({ spec: campaignDrafts.spec })
        .from(campaignDrafts)
        .where(and(eq(campaignDrafts.id, draftId), eq(campaignDrafts.orgId, orgId), eq(campaignDrafts.adAccountId, accountId)))
        .limit(1);
      if (!draft) return null;
      const creative = (draft.spec as CampaignDraftSpec).creative;
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
      let url: string | undefined;
      if (creative.format === "video" && creative.metaVideoId) {
        // frames HD do vídeo — MAS o System User token pode não ter permissão pro endpoint
        // `/{video_id}?fields=thumbnails` (erro Meta #10). Sem frames, cai no thumbnail do
        // ANÚNCIO (getCreatives), que é acessível — o card é 64px, então o selo já basta.
        url = (await deps.adsPlatform.getVideoFrames(ctx.ref, creative.metaVideoId))[0];
        if (!url) {
          const [c] = await deps.adsPlatform.getCreatives(ctx.ref, [creative.assetId]);
          url = c?.thumbnailUrl ?? c?.imageUrl;
        }
      } else {
        const [c] = await deps.adsPlatform.getCreatives(ctx.ref, [creative.assetId]);
        url = c?.imageUrl ?? c?.thumbnailUrl;
      }
      if (!url) return null;
      // rede de segurança: teto de tempo (fbcdn lento não pendura a API) + só imagem + cap de
      // tamanho (não materializa payload gigante). Falha/timeout → null (o card mostra fallback).
      const res = await fetch(url, { signal: AbortSignal.timeout(THUMB_FETCH_TIMEOUT_MS) }).catch(() => null);
      if (!res || !res.ok) return null;
      const contentType = res.headers.get("content-type") ?? "image/jpeg";
      if (!contentType.startsWith("image/")) return null; // não ecoa content-type arbitrário inline
      if (Number(res.headers.get("content-length") ?? 0) > THUMB_MAX_BYTES) return null;
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength > THUMB_MAX_BYTES) return null; // fallback quando não veio content-length
      return { bytes, contentType, etag };
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

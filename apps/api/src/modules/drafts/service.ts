import { and, desc, eq } from "drizzle-orm";
import {
  adAccounts,
  agents,
  campaignDrafts,
  creativeAssets,
  guardrailConfigs,
  platformConnections,
  type Database,
} from "@trafego/db";
import { planScaleMove, type BudgetLevel, type ScaleAggressivePreference } from "@trafego/core";
import {
  ACTION_PARAM_MODE,
  ACTION_PARAM_PCT,
  APPROVAL_TTL_HOURS,
  BUDGET_MODE_INCREASE,
  toGuardrailConfig,
  type CampaignDraftSpec,
} from "@trafego/shared";
import type { Action, AgentId, CreativeAssetRef, DraftId, OrgId } from "@trafego/shared/types";
import type { AdAccountRef, ApprovalPort, CredentialVaultPort, StoragePort } from "@trafego/shared/ports";
import type { AdsPlatformPort } from "@trafego/shared/ports";
import { ingestCreativeImage } from "@trafego/creative-library";
import type {
  CreativeAssetOutput,
  DraftApprovalOutput,
  ScaleWinnerInput,
  ScaleWinnerOutput,
  UploadCreativeInput,
  UploadCreativeOutput,
} from "./schema.js";

// unidade menor → maior. Assume moeda de 2 casas (BRL/USD/EUR); moedas sem centavos
// (JPY/CLP) = fast-follow (derivar a subunidade da moeda). Beta é BRL.
const MINOR_PER_UNIT = 100;
const APPROVAL_TTL_MS = APPROVAL_TTL_HOURS * 60 * 60 * 1000;

export interface DraftsServiceDeps {
  readonly db: Database;
  readonly adsPlatform: AdsPlatformPort;
  readonly vault: CredentialVaultPort;
  readonly approvals: ApprovalPort;
  /** Storage do blob original (F7) — mesma porta do intake WhatsApp (convergência). */
  readonly storage: StoragePort;
}

/** Conta + agente + token + cfg resolvidos p/ operar uma escala. */
interface ScaleContext {
  readonly agentId: string;
  readonly ref: AdAccountRef;
  readonly currency: string;
  readonly cfg: ReturnType<typeof toGuardrailConfig>;
  /** Preferência do passo agressivo (autonomy_policy) — default "ask". */
  readonly scaleAggressivePreference: ScaleAggressivePreference;
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

    return {
      agentId: row.agentId,
      ref: { adAccountId: row.metaAdAccountId, accessToken: deps.vault.decrypt(encrypted) },
      currency: row.currency ?? "BRL",
      cfg: toGuardrailConfig(g),
      scaleAggressivePreference: row.autonomyPolicy?.scaleAggressivePreference ?? "ask",
    };
  }

  return {
    /** Rascunhos de campanha aguardando aprovação (card de rascunho no inbox). */
    async listPendingDrafts(orgId: OrgId): Promise<DraftApprovalOutput[]> {
      const pending = (await deps.approvals.listPendingByOrg(orgId)).filter((a) => a.kind === "draft");
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
          accountId: d.accountId,
          accountName: acc?.name ?? "conta",
          status: appr.status,
          expiresAt: appr.expiresAt ? appr.expiresAt.toISOString() : null,
          draftId: d.id,
          kind: d.kind,
          origin: d.origin,
          objective: spec.objective ?? null,
          dailyBudgetMajor: spec.dailyBudgetMinor / MINOR_PER_UNIT,
          currency: spec.currency,
          activation: spec.activation,
          sourceLabel: d.sourceRef ? `${d.sourceRef.level}:${d.sourceRef.id}` : null,
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

      const state = await deps.adsPlatform.readEntityState(ctx.ref, input.entityId);
      const sourceDailyMinor = Number(state["daily_budget"] ?? 0);
      const budgetLevel: BudgetLevel =
        input.entityLevel === "adset" && sourceDailyMinor > 0 ? "adset" : "campaign";

      const scalePct = ctx.cfg.scalePct ?? 50;
      const move = planScaleMove({
        scalePct,
        maxBudgetChangePct: ctx.cfg.maxBudgetChangePct,
        budgetLevel,
        preference: ctx.scaleAggressivePreference,
        ...(input.choice ? { choice: input.choice } : {}),
      });
      const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS);

      // passo agressivo, intent aberto, sem resposta ainda → PERGUNTA (nada é criado).
      // O site renderiza as 2 opções e re-chama com `choice`; o chat pergunta e reusa o mesmo caminho.
      if (move.move === "ask") {
        return { move: "ask", raisePct: move.raisePct, duplicatePct: move.duplicatePct };
      }

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
          sourceRef: { level: input.entityLevel, id: input.entityId },
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
        .where(and(eq(creativeAssets.orgId, orgId), eq(creativeAssets.adAccountId, accountId)))
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

    /** Troca o criativo de um rascunho `from_scratch` proposto (picker "trocar criativo").
     *  Org-scoped; só rascunho aberto + asset pronto da mesma conta. null → 404 (não editável). */
    async setDraftCreative(
      orgId: OrgId,
      accountId: string,
      draftId: string,
      assetId: string,
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
          ),
        )
        .limit(1);
      if (!asset || asset.status !== "ready") return null;
      const spec = draft.spec as CampaignDraftSpec;
      const creative: CreativeAssetRef = {
        assetId,
        format: asset.format,
        origin: asset.origin,
        ...(asset.metaImageHash ? { metaImageHash: asset.metaImageHash } : {}),
        ...(asset.metaVideoId ? { metaVideoId: asset.metaVideoId } : {}),
      };
      await deps.db
        .update(campaignDrafts)
        .set({ spec: { ...spec, creative } })
        .where(eq(campaignDrafts.id, draftId));
      return { ok: true };
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

    /** Upload de imagem pela web → sobe pra Meta (image_hash) → asset na biblioteca. */
    async uploadCreative(
      orgId: OrgId,
      accountId: string,
      input: UploadCreativeInput,
    ): Promise<UploadCreativeOutput | null> {
      const ctx = await loadScaleContext(orgId, accountId);
      if (!ctx) return null;
      const bytes = new Uint8Array(Buffer.from(input.imageBase64, "base64"));
      // INGESTÃO compartilhada (mesma fonte do intake WhatsApp): blob → StoragePort → Meta
      // (image_hash) → creative_asset dedupado. Convergência total dos dois caminhos.
      const { assetId, metaImageHash } = await ingestCreativeImage(
        { db: deps.db, storage: deps.storage, ads: deps.adsPlatform },
        { orgId, adAccountId: accountId, ref: ctx.ref, bytes, contentType: input.contentType, filename: input.filename },
      );
      return { assetId, metaImageHash };
    },
  };
}

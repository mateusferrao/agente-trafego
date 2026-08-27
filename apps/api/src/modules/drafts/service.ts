import { and, eq } from "drizzle-orm";
import {
  adAccounts,
  agents,
  campaignDrafts,
  guardrailConfigs,
  platformConnections,
  type Database,
} from "@trafego/db";
import { planScaleMove, type BudgetLevel } from "@trafego/core";
import {
  ACTION_PARAM_MODE,
  ACTION_PARAM_PCT,
  BUDGET_MODE_INCREASE,
  toGuardrailConfig,
  type CampaignDraftSpec,
} from "@trafego/shared";
import type { Action, AgentId, DraftId, OrgId } from "@trafego/shared/types";
import type { AdAccountRef, ApprovalPort, CredentialVaultPort } from "@trafego/shared/ports";
import type { AdsPlatformPort } from "@trafego/shared/ports";
import type { DraftApprovalOutput, ScaleWinnerInput, ScaleWinnerOutput } from "./schema.js";

const MINOR_PER_UNIT = 100;
const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

export interface DraftsServiceDeps {
  readonly db: Database;
  readonly adsPlatform: AdsPlatformPort;
  readonly vault: CredentialVaultPort;
  readonly approvals: ApprovalPort;
}

/** Conta + agente + token + cfg resolvidos p/ operar uma escala. */
interface ScaleContext {
  readonly agentId: string;
  readonly ref: AdAccountRef;
  readonly currency: string;
  readonly cfg: ReturnType<typeof toGuardrailConfig>;
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
          .where(eq(campaignDrafts.id, appr.draftId))
          .limit(1);
        if (!d) continue;
        const [acc] = await deps.db
          .select({ name: adAccounts.name })
          .from(adAccounts)
          .where(eq(adAccounts.id, d.accountId))
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
          dailyBudgetReais: spec.dailyBudgetMinor / MINOR_PER_UNIT,
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
      const move = planScaleMove({ scalePct, maxBudgetChangePct: ctx.cfg.maxBudgetChangePct, budgetLevel });
      const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS);

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

      // duplicate: budget novo = source * (1 + scalePct%), clampado depois pelo guardrail de gasto novo.
      const newDailyBudgetMinor = Math.round(sourceDailyMinor * (1 + move.scalePct / 100));
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
  };
}

// Slice da Timeline (6a-5): feed de auditoria POR CONTA — análises + ações (inclui
// chat) + aprovações + erros, tipado (união aberta) e paginado. Híbrido expansível:
// o evento do run carrega as recomendações aninhadas. Read-only sobre tabelas existentes.

import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  adAccounts,
  agentRuns,
  agentToolCalls,
  agents,
  approvals,
  campaignDrafts,
  recommendations,
  type Database,
} from "@trafego/db";
import type { CampaignDraftSpec } from "@trafego/shared";
import { UNDO_BLOCKED_TOOL_KEY, UNDO_TOOL_KEY } from "@trafego/shared";
import type { OrgId } from "@trafego/shared";
import type { TimelineEvent, TimelineOutput, TimelineRecommendation } from "./schema.js";

/** Filtros + paginação da timeline. */
export interface TimelineOptions {
  readonly types?: readonly string[];
  readonly since?: string; // ISO
  readonly limit?: number;
  readonly offset?: number;
}

export interface TimelineDeps {
  readonly db: Database;
}

const PAGE_DEFAULT = 30;
const PAGE_MAX = 100;
/** Teto por fonte antes do merge (paginação profunda real via UNION = fast-follow). */
const SOURCE_CAP = 300;
/** unidade menor → maior (2 casas; JPY/CLP = fast-follow). */
const MINOR_PER_UNIT = 100;

export function createTimelineService(deps: TimelineDeps) {
  return {
    async timeline(orgId: OrgId, accountId: string, opts: TimelineOptions = {}): Promise<TimelineOutput> {
      const [agent] = await deps.db
        .select({ agentId: agents.id })
        .from(agents)
        .innerJoin(adAccounts, eq(agents.adAccountId, adAccounts.id))
        .where(and(eq(agents.adAccountId, accountId), eq(agents.orgId, orgId), eq(adAccounts.orgId, orgId)))
        .limit(1);
      if (!agent) return { items: [], hasMore: false };
      const agentId = agent.agentId;

      const events: TimelineEvent[] = [];

      // 1) runs finalizados → analysis_completed (sucesso) | error (falha).
      const runRows = await deps.db
        .select({
          id: agentRuns.id,
          status: agentRuns.status,
          summary: agentRuns.summary,
          finishedAt: agentRuns.finishedAt,
          createdAt: agentRuns.createdAt,
          grade: sql<string | null>`${agentRuns.metricsSnapshot} #>> '{scorecard,grade}'`,
          headline: sql<string | null>`${agentRuns.metricsSnapshot} #>> '{scorecard,headline}'`,
        })
        .from(agentRuns)
        .where(and(eq(agentRuns.agentId, agentId), inArray(agentRuns.status, ["succeeded", "failed"])))
        .orderBy(desc(agentRuns.finishedAt))
        .limit(SOURCE_CAP);

      const succeededRunIds = runRows.filter((r) => r.status === "succeeded").map((r) => r.id);
      const recsByRun = new Map<string, TimelineRecommendation[]>();
      if (succeededRunIds.length > 0) {
        const recRows = await deps.db
          .select({
            id: recommendations.id,
            runId: recommendations.runId,
            title: recommendations.title,
            riskLevel: recommendations.riskLevel,
            status: recommendations.status,
          })
          .from(recommendations)
          .where(inArray(recommendations.runId, succeededRunIds));
        for (const r of recRows) {
          const list = recsByRun.get(r.runId) ?? [];
          list.push({ id: r.id, title: r.title, riskLevel: r.riskLevel, status: r.status });
          recsByRun.set(r.runId, list);
        }
      }

      for (const r of runRows) {
        const at = (r.finishedAt ?? r.createdAt).toISOString();
        if (r.status === "failed") {
          events.push({ id: `run:${r.id}`, at, type: "error", runId: r.id, message: r.summary ?? "Análise não concluída." });
        } else {
          const recs = recsByRun.get(r.id) ?? [];
          events.push({
            id: `run:${r.id}`,
            at,
            type: "analysis_completed",
            runId: r.id,
            grade: r.grade,
            headline: r.headline,
            recommendationCount: recs.length,
            recommendations: recs,
          });
        }
      }

      // 2) ações (tool_calls) do agente — inclui chat (coalesce) + LEFT JOIN.
      const owner = sql`coalesce(${agentToolCalls.agentId}, ${agentRuns.agentId})`;
      const tcRows = await deps.db
        .select({
          id: agentToolCalls.id,
          toolKey: agentToolCalls.toolKey,
          args: agentToolCalls.args,
          runId: agentToolCalls.runId,
          at: agentToolCalls.createdAt,
        })
        .from(agentToolCalls)
        .leftJoin(agentRuns, eq(agentToolCalls.runId, agentRuns.id))
        .where(and(eq(owner, agentId), ne(agentToolCalls.toolKey, UNDO_BLOCKED_TOOL_KEY)))
        .orderBy(desc(agentToolCalls.createdAt))
        .limit(SOURCE_CAP);

      for (const r of tcRows) {
        const args = r.args as { target?: { name?: string; id?: string; level?: string }; dryRun?: boolean };
        events.push({
          id: `tc:${r.id}`,
          at: r.at.toISOString(),
          type: r.toolKey === UNDO_TOOL_KEY ? "action_rolled_back" : "action_applied",
          toolCallId: r.id,
          toolKey: r.toolKey,
          entityName: args.target?.name ?? args.target?.id ?? null,
          entityLevel: args.target?.level ?? null,
          fromChat: r.runId === null,
          simulated: args.dryRun === true,
        });
      }

      // 3) aprovações → 1 evento no estado atual (pedida/aprovada/rejeitada/expirada).
      const apprRows = await deps.db
        .select({
          id: approvals.id,
          status: approvals.status,
          actionType: approvals.actionType,
          action: approvals.action,
          createdAt: approvals.createdAt,
          resolvedAt: approvals.resolvedAt,
        })
        .from(approvals)
        .where(eq(approvals.agentId, agentId))
        .orderBy(desc(approvals.createdAt))
        .limit(SOURCE_CAP);

      for (const r of apprRows) {
        const type = APPROVAL_EVENT_BY_STATUS[r.status];
        if (!type) continue;
        // rascunhos de campanha (Fatia 7) têm eventos próprios (campaign_draft_*); aqui
        // só entram aprovações de AÇÃO (actionType set).
        if (r.actionType === null) continue;
        const at = (r.resolvedAt ?? r.createdAt).toISOString();
        const action = r.action as { target?: { name?: string; id?: string; level?: string } } | null;
        events.push({
          id: `ap:${r.id}`,
          at,
          type,
          approvalId: r.id,
          actionType: r.actionType,
          entityName: action?.target?.name ?? action?.target?.id ?? null,
          entityLevel: action?.target?.level ?? null,
        });
      }

      // 4) rascunhos de campanha (Fatia 7) → proposto (createdAt) + criado (updatedAt quando created).
      const draftRows = await deps.db
        .select({
          id: campaignDrafts.id,
          kind: campaignDrafts.kind,
          status: campaignDrafts.status,
          spec: campaignDrafts.spec,
          createdAt: campaignDrafts.createdAt,
          updatedAt: campaignDrafts.updatedAt,
        })
        .from(campaignDrafts)
        .where(eq(campaignDrafts.agentId, agentId))
        .orderBy(desc(campaignDrafts.createdAt))
        .limit(SOURCE_CAP);

      for (const d of draftRows) {
        const spec = d.spec as CampaignDraftSpec;
        // 2 casas (BRL/USD/EUR); moeda sem centavos (JPY/CLP) = fast-follow. `currency` vai
        // junto p/ o front formatar com o símbolo certo (nunca hardcodar).
        const budgetMajor = spec.dailyBudgetMinor / MINOR_PER_UNIT;
        events.push({
          id: `dp:${d.id}`,
          at: d.createdAt.toISOString(),
          type: "campaign_draft_proposed",
          draftId: d.id,
          kind: d.kind,
          dailyBudgetMajor: budgetMajor,
          currency: spec.currency,
        });
        if (d.status === "created") {
          events.push({
            id: `dc:${d.id}`,
            at: d.updatedAt.toISOString(),
            type: "campaign_created",
            draftId: d.id,
            kind: d.kind,
            dailyBudgetMajor: budgetMajor,
            currency: spec.currency,
          });
        }
      }

      // merge → filtro (tipo/período) → ordena desc → pagina.
      const typeSet = opts.types && opts.types.length > 0 ? new Set(opts.types) : null;
      let merged = events;
      if (typeSet) merged = merged.filter((e) => typeSet.has(e.type));
      if (opts.since) merged = merged.filter((e) => e.at >= opts.since!);
      merged.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

      const limit = Math.min(Math.max(opts.limit ?? PAGE_DEFAULT, 1), PAGE_MAX);
      const offset = Math.max(opts.offset ?? 0, 0);
      const page = merged.slice(offset, offset + limit);
      return { items: page, hasMore: merged.length > offset + limit };
    },
  };
}

type ApprovalEventType =
  | "approval_requested"
  | "approval_approved"
  | "approval_rejected"
  | "approval_expired";

/** Status da aprovação → tipo de evento (blocked = barrada no apply → conta como rejeitada). */
const APPROVAL_EVENT_BY_STATUS: Record<string, ApprovalEventType | undefined> = {
  pending: "approval_requested",
  approved: "approval_approved",
  rejected: "approval_rejected",
  blocked: "approval_rejected",
  expired: "approval_expired",
};

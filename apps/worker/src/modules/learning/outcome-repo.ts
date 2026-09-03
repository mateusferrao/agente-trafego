// Medição de outcome de AÇÕES NOSSAS (Sinal A, S4) — casca org-scoped. Liga uma
// recomendação (proposedAction) à ação REALMENTE aplicada (agent_tool_calls com
// before_state, não dry-run) no mesmo run, agrega as janelas antes/depois de
// insights_snapshots e grava o desfecho + as linhas de EVIDÊNCIA (ledger) ATOMICAMENTE
// (uma transação por recomendação — crash não mede-sem-aprender). O core decide
// (computeOutcome/classifyOutcomeEvidence); aqui só há IO. O prior de CONTA é destilado
// do ledger num passo à parte (não mais uma lição por-entidade por medição — v3).

import { and, between, eq, gte, isNotNull, lte, sql } from "drizzle-orm";
import {
  agentRuns,
  agentToolCalls,
  agents,
  entityConfigSnapshots,
  insightsSnapshots,
  learningEvidence,
  recommendationFeedback,
  recommendations,
  type Database,
} from "@trafego/db";
import type { Action, ActionType, EntityConfigSnapshot, EntityLevel, LessonOrigin } from "@trafego/shared";
import type { EntityConfigDelta, LessonDimension, LessonDirection, MeasuredOutcome, OutcomeWindow } from "@trafego/core";

const CAMPAIGN_LEVEL: EntityLevel = "campaign";

/** Recomendação com ação de plataforma, elegível à medição (janela madura, ainda não medida). */
export interface MeasurableRec {
  readonly recId: string;
  readonly runId: string;
  readonly adAccountId: string;
  readonly actionType: ActionType;
  readonly params: Readonly<Record<string, unknown>>;
  readonly entityId: string;
  readonly entityLevel: EntityLevel;
}

/** Uma linha do ledger `learning_evidence` a gravar (idempotente por `dedupeRef`). */
export interface LearningEvidenceInsert {
  readonly orgId: string;
  readonly agentId: string;
  readonly dimension: LessonDimension;
  readonly direction: LessonDirection;
  readonly entityId: string;
  readonly supports: boolean;
  readonly outcome: MeasuredOutcome;
  readonly source: LessonOrigin;
  readonly dedupeRef: string;
  readonly measuredAt: Date;
}

export interface CommitOutcomeInput {
  readonly orgId: string;
  readonly agentId: string;
  readonly recId: string;
  readonly outcome: MeasuredOutcome;
  readonly metrics: Record<string, unknown>;
  /** linhas de evidência (o outcome sustenta/contradiz priors de conta) — o ledger. */
  readonly evidence: readonly LearningEvidenceInsert[];
}

/** Mudança de config detectada (prev→curr) cuja janela pós-mudança já fechou. */
export interface MaturedConfigChange {
  readonly entityId: string;
  readonly entityLevel: EntityLevel;
  readonly changeDate: string;
  readonly prev: EntityConfigDelta;
  readonly curr: EntityConfigDelta;
}

export interface OutcomeRepo {
  loadMeasurableRecs(orgId: string, agentId: string, notBefore: Date, notAfter: Date): Promise<MeasurableRec[]>;
  /** Mudanças de config (prev→curr) do gestor cuja data está na janela madura [from,to]. */
  loadMaturedConfigChanges(orgId: string, adAccountId: string, from: string, to: string): Promise<MaturedConfigChange[]>;
  /** Houve ação NOSSA aplicada nessa entidade no intervalo? (exclui nossa mudança da "manual").
   *  Escopo por `agentId` (FK globalmente único e org-owned) — `agent_tool_calls` não tem coluna
   *  org_id, então o filtro org é implícito no agente (§12: leak cross-tenant impossível aqui). */
  hasAppliedActionInRange(agentId: string, entityId: string, from: Date, to: Date): Promise<boolean>;
  /** instante da 1ª aplicação REAL da ação naquela entidade (não dry-run, com before_state).
   *  Escopo por `runId` (FK globalmente único e org-owned) — ver nota de `hasAppliedActionInRange`. */
  findAppliedInstant(runId: string, entityId: string): Promise<Date | null>;
  /** janela agregada (spend + conversões de negócio) de uma entidade OU da conta (entityId null). */
  loadWindow(orgId: string, adAccountId: string, entityId: string | null, from: string, to: string): Promise<OutcomeWindow>;
  commitOutcome(input: CommitOutcomeInput): Promise<void>;
  /** grava linhas de evidência do ledger (mudança manual do gestor — sem recommendation_feedback). */
  insertEvidence(rows: readonly LearningEvidenceInsert[]): Promise<void>;
}

export function createOutcomeRepo(db: Database): OutcomeRepo {
  return {
    async loadMeasurableRecs(orgId, agentId, notBefore, notAfter) {
      const rows = await db
        .select({ recId: recommendations.id, runId: recommendations.runId, action: recommendations.proposedAction, adAccountId: agents.adAccountId })
        .from(recommendations)
        .innerJoin(agentRuns, eq(recommendations.runId, agentRuns.id))
        .innerJoin(agents, eq(agentRuns.agentId, agents.id))
        .where(
          and(
            eq(recommendations.orgId, orgId),
            eq(agentRuns.agentId, agentId),
            isNotNull(recommendations.proposedAction),
            between(recommendations.createdAt, notBefore, notAfter),
            // ainda não medida (sem linha de feedback com measured_at).
            sql`not exists (select 1 from ${recommendationFeedback} f where f.recommendation_id = ${recommendations.id} and f.measured_at is not null)`,
          ),
        );
      const out: MeasurableRec[] = [];
      for (const r of rows) {
        const action = r.action as Action | null;
        if (!action?.target?.id) continue;
        out.push({
          recId: r.recId,
          runId: r.runId,
          adAccountId: r.adAccountId,
          actionType: action.type,
          params: action.params ?? {},
          entityId: action.target.id,
          entityLevel: action.target.level,
        });
      }
      return out;
    },

    async loadMaturedConfigChanges(orgId, adAccountId, from, to) {
      // carrega snapshots até `to` (com folga p/ ter o "prev"), pareia por entidade e emite
      // a mudança cuja data (curr) cai em [from,to] (janela madura). Cadência = análise.
      const rows = await db
        .select({ entityId: entityConfigSnapshots.entityId, level: entityConfigSnapshots.entityLevel, date: entityConfigSnapshots.date, config: entityConfigSnapshots.configJson })
        .from(entityConfigSnapshots)
        .where(and(eq(entityConfigSnapshots.orgId, orgId), eq(entityConfigSnapshots.adAccountId, adAccountId), lte(entityConfigSnapshots.date, to)))
        .orderBy(entityConfigSnapshots.entityId, entityConfigSnapshots.date);
      const byEntity = new Map<string, { level: EntityLevel; date: string; config: EntityConfigSnapshot }[]>();
      for (const r of rows) {
        const list = byEntity.get(r.entityId) ?? [];
        list.push({ level: r.level, date: r.date, config: r.config });
        byEntity.set(r.entityId, list);
      }
      const out: MaturedConfigChange[] = [];
      for (const [entityId, snaps] of byEntity) {
        for (let i = 1; i < snaps.length; i++) {
          const curr = snaps[i]!;
          if (curr.date < from || curr.date > to) continue;
          out.push({ entityId, entityLevel: curr.level, changeDate: curr.date, prev: snaps[i - 1]!.config, curr: curr.config });
        }
      }
      return out;
    },

    async hasAppliedActionInRange(agentId, entityId, from, to) {
      const [row] = await db
        .select({ id: agentToolCalls.id })
        .from(agentToolCalls)
        .where(
          and(
            eq(agentToolCalls.agentId, agentId),
            isNotNull(agentToolCalls.beforeState),
            sql`${agentToolCalls.args} -> 'target' ->> 'id' = ${entityId}`,
            // exclui dry-run: uma simulação nossa NÃO é "ação aplicada" (senão suprimiria
            // o aprendizado da mudança MANUAL do gestor na mesma entidade).
            sql`coalesce((${agentToolCalls.args} ->> 'dryRun')::boolean, false) = false`,
            between(agentToolCalls.createdAt, from, to),
          ),
        )
        .limit(1);
      return row !== undefined;
    },

    async findAppliedInstant(runId, entityId) {
      const [row] = await db
        .select({ at: agentToolCalls.createdAt })
        .from(agentToolCalls)
        .where(
          and(
            eq(agentToolCalls.runId, runId),
            isNotNull(agentToolCalls.beforeState),
            sql`${agentToolCalls.args} -> 'target' ->> 'id' = ${entityId}`,
            sql`coalesce((${agentToolCalls.args} ->> 'dryRun')::boolean, false) = false`,
          ),
        )
        .orderBy(agentToolCalls.createdAt)
        .limit(1);
      return row?.at ?? null;
    },

    async loadWindow(orgId, adAccountId, entityId, from, to) {
      const rows = await db
        .select({ metrics: insightsSnapshots.metricsJson })
        .from(insightsSnapshots)
        .where(
          and(
            eq(insightsSnapshots.orgId, orgId),
            eq(insightsSnapshots.adAccountId, adAccountId),
            entityId
              ? eq(insightsSnapshots.entityId, entityId)
              : eq(insightsSnapshots.entityLevel, CAMPAIGN_LEVEL), // conta = soma das campanhas
            gte(insightsSnapshots.date, from),
            lte(insightsSnapshots.date, to),
          ),
        );
      let spend = 0;
      let results = 0;
      for (const r of rows) {
        const m = (r.metrics as { metrics?: { spend?: number; conversions?: number } } | null)?.metrics ?? {};
        if (typeof m.spend === "number") spend += m.spend;
        if (typeof m.conversions === "number") results += m.conversions;
      }
      return { spend, results, ...(results > 0 ? { cpa: spend / results } : {}) };
    },

    async commitOutcome({ recId, outcome, metrics, evidence }) {
      // recommendation_feedback (métrica de validação do beta) + ledger de evidência na MESMA
      // transação: uma medição que grava feedback mas perde a evidência ficaria muda p/ sempre
      // (measured_at barra re-medir). Evidência é idempotente por (agent, dedupeRef).
      await db.transaction(async (tx) => {
        await tx.insert(recommendationFeedback).values({
          recommendationId: recId,
          outcome,
          outcomeMetrics: metrics,
          measuredAt: sql`now()`,
        });
        if (evidence.length > 0) {
          await tx
            .insert(learningEvidence)
            .values(evidence.map(evidenceRow))
            .onConflictDoNothing({ target: [learningEvidence.agentId, learningEvidence.dedupeRef] });
        }
      });
    },

    async insertEvidence(rows) {
      if (rows.length === 0) return;
      await db
        .insert(learningEvidence)
        .values(rows.map(evidenceRow))
        .onConflictDoNothing({ target: [learningEvidence.agentId, learningEvidence.dedupeRef] });
    },
  };
}

/** Value-object de INSERT em learning_evidence a partir da entrada tipada. */
function evidenceRow(e: LearningEvidenceInsert) {
  return {
    orgId: e.orgId,
    agentId: e.agentId,
    dimension: e.dimension,
    direction: e.direction,
    entityId: e.entityId,
    supports: e.supports,
    outcome: e.outcome,
    source: e.source,
    dedupeRef: e.dedupeRef,
    measuredAt: e.measuredAt,
  };
}

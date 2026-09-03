// Repositório do aprendizado contínuo (casca org-scoped sobre agent_memory estendida +
// leitura do histórico por-run em agent_runs.metrics_snapshot). O core (@trafego/core
// learning) decide/calcula; aqui só há IO. A curadoria transacional (merge/decay/
// contradição) e a medição de outcome entram nas subfatias seguintes reusando este repo.

import { and, desc, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { adAccounts, agentMemory, agentRuns, agents, entityConfigSnapshots, insightsSnapshots, learningEvidence, type Database } from "@trafego/db";
import type { AdEntity, EntityConfigSnapshot, EntityLevel, HealthSignal, PerformanceTier, RunCampaignCard, TrackingHealth, WasteReport } from "@trafego/shared";
import {
  decayCutoffs,
  LEARNING_MEMORY_TYPES,
  lessonKindFromMemoryType,
  type AccountConversionDay,
  type AccountEvidenceRow,
  type CampaignFatigueSeries,
  type DecayConfig,
  type LessonCandidate,
  type RunLearningSnapshot,
  type StoredLesson,
} from "@trafego/core";
import { buildLessonRow } from "./lesson-row.js";

/** Agente elegível ao aprendizado: ativo, conta ativa e NÃO dormante (não aprende de conta parada). */
export interface LearnableAgent {
  readonly orgId: string;
  readonly agentId: string;
  readonly adAccountId: string;
}

// fonte única em @trafego/core (derivado de MEMORY_TYPE_BY_KIND) — sem repetir o literal (§13).
const LEARNING_TYPES = LEARNING_MEMORY_TYPES;
const CAMPAIGN_LEVEL: EntityLevel = "campaign";

export interface LearningRepo {
  listLearnableAgents(): Promise<LearnableAgent[]>;
  loadRunHistory(orgId: string, agentId: string, limit: number): Promise<RunLearningSnapshot[]>;
  loadActiveLessons(orgId: string, agentId: string): Promise<StoredLesson[]>;
  findLessonByKey(
    orgId: string,
    agentId: string,
    semanticKey: string,
  ): Promise<{ id: string; confidence: number | null; lastReinforcedAt: Date | null; reinforceCount: number; confirmedByHuman: boolean; thresholdResolvedAt: Date | null } | null>;
  insertLesson(input: InsertLessonInput): Promise<void>;
  /** Reforça: sobe confiança, incrementa contagem, marca o tempo da evidência e
   *  REATIVA a lição (stale→active) — um padrão reobservado volta a valer. Org+agente no WHERE
   *  (defesa em profundidade §12 — mesmo padrão da casca compartilhada). */
  reinforceLesson(orgId: string, agentId: string, id: string, confidence: number, evidenceAt: Date): Promise<void>;
  /** Ledger de evidência (v3): linhas medidas do agente, base da destilação cross-seccional. */
  loadEvidence(orgId: string, agentId: string): Promise<AccountEvidenceRow[]>;
  /** Série de CTR por-campanha (>= `sinceDate`, cronológica) p/ o detector de timing de fadiga. */
  loadCampaignCtrSeries(orgId: string, adAccountId: string, sinceDate: string): Promise<CampaignFatigueSeries[]>;
  /** Série diária da CONTA (gasto + conversões, cronológica) p/ o detector de lag de conversão. */
  loadAccountConversionSeries(orgId: string, adAccountId: string, sinceDate: string): Promise<AccountConversionDay[]>;
  /** Atualiza um prior de CONTA já materializado: fixa a confiança destilada + a contagem de
   *  entidades de suporte (`reinforceCount` = S, não incrementa) e reativa. Anexa a proposta de
   *  limiar quando fornecida (opt-in, pendente). Idempotente — o serviço só chama quando S
   *  cresceu (evidência de entidade NOVA). */
  refreshAccountPrior(input: RefreshAccountPriorInput): Promise<void>;
  /** Decaimento (curadoria anti-pilha): sem reforço → `active→stale→archived`. Um degrau por
   *  sweep (varre arquiváveis ANTES de rebaixar ativas). Global (sweep de manutenção). Só toca
   *  linhas de aprendizado (fact/past_action com chave). O CONFIRMADO também decai, mas num
   *  relógio LONGO (`confirmed*Days`): o dono endossou, mas a conta muda — não fica pra sempre. */
  applyDecaySweep(
    now: Date,
    cfg: DecayConfig & { readonly confirmedStaleDays: number; readonly confirmedArchiveDays: number },
  ): Promise<{ staled: number; archived: number }>;
  /** Snapshot da config (orçamento/status) das entidades no dia — upsert por (conta,entidade,dia).
   *  Escrito no `record` da análise; base p/ detectar mudança manual do gestor (S4). */
  saveEntityConfigSnapshots(input: SaveConfigInput): Promise<void>;
}

export interface SaveConfigInput {
  readonly orgId: string;
  readonly adAccountId: string;
  readonly date: string;
  readonly entities: readonly AdEntity[];
}

export interface InsertLessonInput {
  readonly orgId: string;
  readonly agentId: string;
  readonly candidate: LessonCandidate;
  readonly content: string;
  /** tempo da evidência mais recente incorporada (o run mais novo da janela) — dedup do tick. */
  readonly evidenceAt: Date;
  readonly sourceRunId?: string;
  /** proposta de limiar a nascer PENDENTE junto do prior (opt-in HITL, v3) — null na maioria. */
  readonly proposedThresholdPatch?: Record<string, unknown>;
}

export interface RefreshAccountPriorInput {
  readonly orgId: string;
  readonly agentId: string;
  readonly id: string;
  readonly confidence: number;
  readonly supportCount: number;
  readonly evidenceAt: Date;
  /** anexa/atualiza a proposta de limiar pendente (só quando fornecida). */
  readonly proposedThresholdPatch?: Record<string, unknown>;
}

export function createLearningRepo(db: Database): LearningRepo {
  return {
    async listLearnableAgents() {
      const rows = await db
        .select({ orgId: agents.orgId, agentId: agents.id, adAccountId: agents.adAccountId })
        .from(agents)
        .innerJoin(adAccounts, eq(agents.adAccountId, adAccounts.id))
        .where(
          and(
            eq(agents.status, "active"),
            eq(adAccounts.status, "active"),
            eq(adAccounts.activityState, "active"),
            // kill-switch do aprendizado (v3, default ON): só desliga quando explicitamente false.
            // Comparação jsonb (sem cast ::boolean) — um valor não-booleano ("on", 1) NÃO derruba a
            // query org-wide; só o literal false desativa (ausência/qualquer outro = ligado).
            sql`(${agents.modelConfig} -> 'learning' -> 'enabled') is distinct from 'false'::jsonb`,
          ),
        );
      return rows;
    },

    async loadRunHistory(orgId, agentId, limit) {
      const rows = await db
        .select({ id: agentRuns.id, at: agentRuns.createdAt, snapshot: agentRuns.metricsSnapshot })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.orgId, orgId),
            eq(agentRuns.agentId, agentId),
            inArray(agentRuns.status, ["succeeded", "partial"]),
            isNotNull(agentRuns.metricsSnapshot),
          ),
        )
        .orderBy(desc(agentRuns.createdAt))
        .limit(limit);
      // mais antigo → mais novo (o detector espera ordem cronológica).
      return rows.reverse().map((r) => snapshotToRunLearning(r.id, r.at, r.snapshot));
    },

    async loadActiveLessons(orgId, agentId) {
      const rows = await db
        .select()
        .from(agentMemory)
        .where(
          and(
            eq(agentMemory.orgId, orgId),
            eq(agentMemory.agentId, agentId),
            inArray(agentMemory.type, [...LEARNING_TYPES]),
            eq(agentMemory.lifecycle, "active"),
            isNotNull(agentMemory.semanticKey),
          ),
        );
      return rows.map(rowToStoredLesson);
    },

    async findLessonByKey(orgId, agentId, semanticKey) {
      const [row] = await db
        .select({ id: agentMemory.id, confidence: agentMemory.confidence, lastReinforcedAt: agentMemory.lastReinforcedAt, reinforceCount: agentMemory.reinforceCount, confirmedByHuman: agentMemory.confirmedByHuman, thresholdResolvedAt: agentMemory.thresholdResolvedAt })
        .from(agentMemory)
        .where(
          and(
            eq(agentMemory.orgId, orgId),
            eq(agentMemory.agentId, agentId),
            eq(agentMemory.semanticKey, semanticKey),
            sql`${agentMemory.lifecycle} <> 'archived'`,
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async loadEvidence(orgId, agentId) {
      const rows = await db
        .select({ dimension: learningEvidence.dimension, direction: learningEvidence.direction, entityId: learningEvidence.entityId, supports: learningEvidence.supports })
        .from(learningEvidence)
        .where(and(eq(learningEvidence.orgId, orgId), eq(learningEvidence.agentId, agentId)));
      return rows;
    },

    async loadCampaignCtrSeries(orgId, adAccountId, sinceDate) {
      const rows = await db
        .select({ entityId: insightsSnapshots.entityId, date: insightsSnapshots.date, metrics: insightsSnapshots.metricsJson })
        .from(insightsSnapshots)
        .where(and(eq(insightsSnapshots.orgId, orgId), eq(insightsSnapshots.adAccountId, adAccountId), eq(insightsSnapshots.entityLevel, CAMPAIGN_LEVEL), gte(insightsSnapshots.date, sinceDate)))
        .orderBy(insightsSnapshots.entityId, insightsSnapshots.date);
      const byCampaign = new Map<string, number[]>();
      for (const r of rows) {
        const ctr = (r.metrics as { metrics?: { ctr?: number } } | null)?.metrics?.ctr;
        if (typeof ctr !== "number") continue;
        const list = byCampaign.get(r.entityId) ?? [];
        list.push(ctr);
        byCampaign.set(r.entityId, list);
      }
      return [...byCampaign.entries()].map(([campaignId, ctrByDay]) => ({ campaignId, ctrByDay }));
    },

    async loadAccountConversionSeries(orgId, adAccountId, sinceDate) {
      const rows = await db
        .select({ date: insightsSnapshots.date, metrics: insightsSnapshots.metricsJson })
        .from(insightsSnapshots)
        .where(and(eq(insightsSnapshots.orgId, orgId), eq(insightsSnapshots.adAccountId, adAccountId), eq(insightsSnapshots.entityLevel, CAMPAIGN_LEVEL), gte(insightsSnapshots.date, sinceDate)))
        .orderBy(insightsSnapshots.date);
      // conta = soma das campanhas por dia (a série da conta não é persistida à parte).
      const byDay = new Map<string, { spend: number; conversions: number }>();
      for (const r of rows) {
        const m = (r.metrics as { metrics?: { spend?: number; conversions?: number } } | null)?.metrics ?? {};
        const agg = byDay.get(r.date) ?? { spend: 0, conversions: 0 };
        if (typeof m.spend === "number") agg.spend += m.spend;
        if (typeof m.conversions === "number") agg.conversions += m.conversions;
        byDay.set(r.date, agg);
      }
      return [...byDay.keys()].sort().map((d) => byDay.get(d)!);
    },

    async refreshAccountPrior({ orgId, agentId, id, confidence, supportCount, evidenceAt, proposedThresholdPatch }) {
      await db
        .update(agentMemory)
        .set({
          confidence,
          // reinforceCount = nº de entidades DISTINTAS de suporte (destilação recomputa do
          // ledger inteiro; não incrementa — senão o tick diário inflaria a contagem).
          reinforceCount: supportCount,
          lastReinforcedAt: evidenceAt,
          lifecycle: "active",
          ...(proposedThresholdPatch ? { proposedThresholdPatch } : {}),
          updatedAt: sql`now()`,
        })
        .where(and(eq(agentMemory.id, id), eq(agentMemory.orgId, orgId), eq(agentMemory.agentId, agentId)));
    },

    async insertLesson({ orgId, agentId, candidate, content, evidenceAt, sourceRunId, proposedThresholdPatch }) {
      // `evidenceAt` marca a evidência incorporada já na criação → o próximo tick sobre a
      // MESMA janela não reforça (dedup); só evidência mais nova conta.
      await db.insert(agentMemory).values(
        buildLessonRow(candidate, { orgId, agentId, content, evidenceAt, ...(sourceRunId ? { sourceRunId } : {}), ...(proposedThresholdPatch ? { proposedThresholdPatch } : {}) }),
      );
    },

    async reinforceLesson(orgId, agentId, id, confidence, evidenceAt) {
      await db
        .update(agentMemory)
        .set({
          confidence,
          reinforceCount: sql`${agentMemory.reinforceCount} + 1`,
          lastReinforcedAt: evidenceAt,
          // padrão reobservado volta a valer (desfaz um stale do decay — S2).
          lifecycle: "active",
          updatedAt: sql`now()`,
        })
        .where(and(eq(agentMemory.id, id), eq(agentMemory.orgId, orgId), eq(agentMemory.agentId, agentId)));
    },

    async applyDecaySweep(now, cfg) {
      // só linhas de aprendizado com chave (não toca o `rejected`/`objective` legado).
      const learningRows = and(inArray(agentMemory.type, [...LEARNING_TYPES]), isNotNull(agentMemory.semanticKey), isNotNull(agentMemory.lastReinforcedAt));
      // um sweep de 2 degraus (arquiva stale velhas ANTES de rebaixar ativas) p/ um conjunto:
      // NÃO-confirmadas no relógio curto; CONFIRMADAS no relógio longo (aposentadoria por evidência
      // — o dono endossou, mas se a conta parar de reforçar por muito tempo, cede).
      const sweep = async (confirmed: boolean, staleDays: number, archiveDays: number) => {
        const { staleBefore, archiveBefore } = decayCutoffs(now, { staleDays, archiveDays });
        const rows = and(learningRows, eq(agentMemory.confirmedByHuman, confirmed));
        const archived = await db
          .update(agentMemory)
          .set({ lifecycle: "archived", updatedAt: sql`now()` })
          .where(and(rows, eq(agentMemory.lifecycle, "stale"), lt(agentMemory.lastReinforcedAt, archiveBefore)))
          .returning({ id: agentMemory.id });
        const staled = await db
          .update(agentMemory)
          .set({ lifecycle: "stale", updatedAt: sql`now()` })
          .where(and(rows, eq(agentMemory.lifecycle, "active"), lt(agentMemory.lastReinforcedAt, staleBefore)))
          .returning({ id: agentMemory.id });
        return { staled: staled.length, archived: archived.length };
      };
      const nonConfirmed = await sweep(false, cfg.staleDays, cfg.archiveDays);
      const confirmed = await sweep(true, cfg.confirmedStaleDays, cfg.confirmedArchiveDays);
      return { staled: nonConfirmed.staled + confirmed.staled, archived: nonConfirmed.archived + confirmed.archived };
    },

    async saveEntityConfigSnapshots({ orgId, adAccountId, date, entities }) {
      if (entities.length === 0) return;
      const rows = entities.map((e) => ({
        orgId,
        adAccountId,
        entityLevel: e.level,
        entityId: e.id,
        date,
        configJson: entityConfigOf(e),
      }));
      await db
        .insert(entityConfigSnapshots)
        .values(rows)
        .onConflictDoUpdate({
          target: [entityConfigSnapshots.adAccountId, entityConfigSnapshots.entityId, entityConfigSnapshots.date],
          set: { configJson: sql`excluded.config_json`, updatedAt: sql`now()` },
        });
    },
  };
}

/** Projeta a config aprendível de uma AdEntity (orçamento/status; unidade menor da moeda). */
function entityConfigOf(e: AdEntity): EntityConfigSnapshot {
  return {
    status: e.status,
    ...(typeof e.dailyBudget === "number" ? { dailyBudgetMinor: e.dailyBudget } : {}),
    ...(typeof e.lifetimeBudget === "number" ? { lifetimeBudgetMinor: e.lifetimeBudget } : {}),
  };
}

// ─── mapeamento snapshot → RunLearningSnapshot ─────────────────────────────

/** Mapeia um `agent_runs.metrics_snapshot` p/ o formato de aprendizado. Exportado p/ teste. */
export function snapshotToRunLearning(
  runId: string,
  at: Date,
  snapshot: Record<string, unknown> | null,
): RunLearningSnapshot {
  const cards = Array.isArray(snapshot?.campaigns) ? (snapshot.campaigns as RunCampaignCard[]) : [];
  const byId = new Map<string, { externalId: string; name: string; tier?: PerformanceTier; healthSignals?: readonly HealthSignal[] }>();
  for (const c of cards) {
    byId.set(c.externalId, {
      externalId: c.externalId,
      name: c.name ?? c.externalId,
      ...(c.tier ? { tier: c.tier as PerformanceTier } : {}),
      ...(c.healthSignals && c.healthSignals.length > 0 ? { healthSignals: c.healthSignals } : {}),
    });
  }
  // `waste.zombies` cobre o conjunto COMPLETO (não só as campanhas com análise profunda) —
  // é a fonte do desperdício CRÔNICO SILENCIOSO (campanha zumbi que nunca entra no top-N e
  // só é "resumida", logo ausente dos cards). Marca essas como zumbi p/ o detector observacional.
  const waste = snapshot?.waste as WasteReport | undefined;
  for (const z of waste?.zombies ?? []) {
    const existing = byId.get(z.id);
    if (existing) {
      if (!existing.tier) byId.set(z.id, { ...existing, tier: "zombie" });
    } else {
      byId.set(z.id, { externalId: z.id, name: z.name, tier: "zombie" });
    }
  }
  // trackingHealth só está presente no snapshot QUANDO suspeito (ver buildMetricsSnapshot).
  const trackingSuspect = (snapshot?.trackingHealth as TrackingHealth | undefined)?.suspect === true;
  return { runId, at: at.toISOString(), campaigns: [...byId.values()], trackingSuspect };
}

function rowToStoredLesson(row: typeof agentMemory.$inferSelect): StoredLesson {
  return {
    id: row.id,
    kind: lessonKindFromMemoryType(row.type),
    key: {
      scope: row.scope,
      dimension: row.dimension ?? "other",
      direction: row.direction ?? "neutral",
      ...(row.pattern ? { pattern: row.pattern as NonNullable<LessonCandidate["key"]["pattern"]> } : {}),
      ...(row.subjectId ? { subjectId: row.subjectId } : {}),
    },
    content: row.content,
    confidence: row.confidence ?? 0,
    confirmedByHuman: row.confirmedByHuman,
    origin: row.origin,
    lifecycle: row.lifecycle,
    reinforceCount: row.reinforceCount,
  };
}

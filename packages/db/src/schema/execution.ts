import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  Action,
  CampaignDraftSpec,
  CreativeVisionResult,
  DraftSourceRef,
  PartialReason,
} from "@trafego/shared";
import {
  actionType,
  approvalStatus,
  creativeAssetOrigin,
  creativeAssetStatus,
  creativeFormat,
  draftKind,
  draftOrigin,
  draftStatus,
  entityLevel,
  feedbackVote,
  outcomeStatus,
  pk,
  recommendationKind,
  recommendationStatus,
  riskLevel,
  runStatus,
  runTrigger,
  timestamps,
} from "./_shared.js";
import { agents } from "./agents.js";
import { orgs } from "./tenancy.js";
import { adAccounts, contacts } from "./integrations.js";

/** Execução do agente (análise). Congela config + custo p/ reprodutibilidade. */
export const agentRuns = pgTable(
  "agent_runs",
  {
    id: pk(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    trigger: runTrigger("trigger").notNull(),
    status: runStatus("status").notNull().default("pending"),
    // congela a config no momento do run
    configSnapshot: jsonb("config_snapshot").$type<Record<string, unknown>>().notNull().default({}),
    tokenUsage: jsonb("token_usage").$type<Record<string, unknown>>(),
    costSnapshot: numeric("cost_snapshot", { precision: 12, scale: 4 }),
    // resumo em linguagem natural da análise (LLM) — NEUTRO (síntese do analista);
    // fonte estável p/ pulso/comparação e fallback do site.
    summary: text("summary"),
    // narrativa VOICEADA (redator, aplica a postura) — a "fala" do agente exibida no
    // site (topo do resultado, no lugar do summary neutro) e enviada no WhatsApp.
    // Renderizada em todo run; null em run sem análise (fallback ao summary).
    narrative: text("narrative"),
    // análise parcial (degradação graciosa do governor — §7) → nota na UI.
    partial: boolean("partial").notNull().default(false),
    // POR QUE degradou (métricas/entidades/criativo/campanha/ação) — deixa o parcial de
    // ser caixa-preta e a nota da UI proporcional. Vazio = não degradou.
    partialReasons: jsonb("partial_reasons").$type<PartialReason[]>().notNull().default([]),
    // KPIs da conta + funil + scorecard congelados no run — a faixa do site lê daqui.
    metricsSnapshot: jsonb("metrics_snapshot").$type<Record<string, unknown>>(),
    traceId: text("trace_id"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("agent_runs_agent_idx").on(t.agentId),
    index("agent_runs_org_idx").on(t.orgId),
    // No máx. 1 run em andamento por agente (fecha o TOCTOU cron×manual — decisão 15):
    // índice único PARCIAL nos status in-flight. A violação vira conflito amigável na casca.
    uniqueIndex("agent_runs_one_in_flight_uq")
      .on(t.agentId)
      .where(sql`status in ('pending', 'running', 'waiting_approval')`),
  ],
);

/** Passo do grafo dentro de um run (nó LangGraph). */
export const agentRunSteps = pgTable(
  "agent_run_steps",
  {
    id: pk(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    status: runStatus("status").notNull().default("pending"),
    input: jsonb("input").$type<Record<string, unknown>>(),
    output: jsonb("output").$type<Record<string, unknown>>(),
    error: text("error"),
    ...timestamps,
  },
  (t) => [index("agent_run_steps_run_idx").on(t.runId)],
);

/**
 * Chamada de tool (escrita na Meta). `idempotency_key` = nunca aplica a mesma
 * mutação 2x. `before_state` = rollback.
 */
export const agentToolCalls = pgTable(
  "agent_tool_calls",
  {
    id: pk(),
    // dono da ação. Escrita por análise carrega o `run_id`; escrita LIVRE por chat (5c)
    // não nasce de um run → `run_id` nullable, e o `agent_id` é a âncora (cap diário,
    // undo, trilha). Rows legadas têm `agent_id` backfillado a partir do run.
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => agentRuns.id, { onDelete: "cascade" }),
    toolKey: text("tool_key").notNull(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    risk: riskLevel("risk").notNull().default("low"),
    args: jsonb("args").$type<Record<string, unknown>>().notNull().default({}),
    result: jsonb("result").$type<Record<string, unknown>>(),
    // snapshot pré-mutação p/ rollback
    beforeState: jsonb("before_state").$type<Record<string, unknown>>(),
    ...timestamps,
  },
  (t) => [index("agent_tool_calls_run_idx").on(t.runId), index("agent_tool_calls_agent_idx").on(t.agentId)],
);

/**
 * Pedido de OK humano (HITL), **granular: 1 linha por ação** (5b). O upsert por
 * `(agent_id, entity_level, entity_id, action_type)` entre as `pending` mantém a
 * proposta atual (índice único parcial arbitra). O "lote do run" sai por `run_id`.
 * Expira em 24h. `contact_id`/`run_id` nullable (aprovação via site = sessão, sem
 * contato; run pode ser podado).
 */
export const approvals = pgTable(
  "approvals",
  {
    id: pk(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => agentRuns.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    status: approvalStatus("status").notNull().default("pending"),
    // chave granular (a ação proposta vive inteira em `action`; estas colunas chaveiam
    // o upsert + índices, sem espalhar params). NULL nas aprovações de RASCUNHO (Fatia 7):
    // a proposta vive em `campaign_drafts` (via `draft_id`), não em `action`.
    entityLevel: entityLevel("entity_level"),
    entityId: text("entity_id"),
    actionType: actionType("action_type"),
    action: jsonb("action").$type<Action>(),
    // Aprovação de rascunho de campanha (Fatia 7) — exclui `action` (check exatamente-um).
    draftId: uuid("draft_id").references(() => campaignDrafts.id, { onDelete: "cascade" }),
    // motivo quando resolvida sem aplicar (rejeitada pelo usuário ou `blocked` no re-check).
    resolvedReason: text("resolved_reason"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("approvals_org_idx").on(t.orgId),
    index("approvals_run_idx").on(t.runId),
    index("approvals_agent_status_idx").on(t.agentId, t.status),
    index("approvals_draft_idx").on(t.draftId),
    // no máx. 1 pendente por (agente, entidade, tipo de ação) → upsert atômico. Rascunhos
    // (entity/actionType NULL) ficam FORA daqui — a unicidade deles mora em campaign_drafts.
    uniqueIndex("approvals_pending_uq")
      .on(t.agentId, t.entityLevel, t.entityId, t.actionType)
      .where(sql`status = 'pending'`),
    // exatamente um: aprovação de AÇÃO (action set, draft null) OU de RASCUNHO (draft set, action null).
    check(
      "approvals_action_xor_draft",
      sql`(${t.action} is not null and ${t.draftId} is null) or (${t.action} is null and ${t.draftId} is not null)`,
    ),
  ],
);

/** Achado/sugestão do run (com feedback + outcome). */
export const recommendations = pgTable(
  "recommendations",
  {
    id: pk(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    rationale: text("rationale"),
    // Formato (S2): eixo de renderização/gating. Default platform_action p/ linhas
    // legadas com ação; o backfill da migração seta `insight` onde não há ação.
    kind: recommendationKind("kind").notNull().default("platform_action"),
    proposedAction: jsonb("proposed_action").$type<Action>(),
    // Capacidade do catálogo (S4) que esta recomendação propõe — só em platform_action.
    toolKey: text("tool_key"),
    // Rascunho de campanha semeado por esta recomendação (Fatia 7, proativo) — o card
    // rico abre a partir daqui e reusa o outcome tracking da recomendação.
    draftId: uuid("draft_id").references(() => campaignDrafts.id, { onDelete: "set null" }),
    riskLevel: riskLevel("risk_level").notNull().default("low"),
    status: recommendationStatus("status").notNull().default("open"),
    ...timestamps,
  },
  (t) => [
    index("recommendations_run_idx").on(t.runId),
    index("recommendations_draft_idx").on(t.draftId),
  ],
);

/**
 * Última análise por unidade — base do map-reduce incremental: unidades sem mudança
 * material herdam daqui em vez de re-chamar o LLM. 1 linha por (agente, entidade),
 * upsertada a cada análise. `entityLevel`/`entityName` congelam o nível/rótulo p/ o
 * recorte por campanha no site (legado nível-anúncio = default `ad`).
 */
export const entityAnalyses = pgTable(
  "entity_analyses",
  {
    id: pk(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    entityId: text("entity_id").notNull(),
    // nível da unidade analisada (campaign no modelo por-campanha; ad no legado).
    entityLevel: entityLevel("entity_level").notNull().default("ad"),
    // nome legível da entidade no momento da análise (p/ o cartão no site).
    entityName: text("entity_name"),
    runId: uuid("run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    // UnitAnalysis (findings/recommendations/flags/summary) da última análise.
    unitJson: jsonb("unit_json").$type<Record<string, unknown>>().notNull(),
    // métricas usadas p/ detectar "mudança material" no próximo run.
    metricsJson: jsonb("metrics_json").$type<Record<string, unknown>>().notNull().default({}),
    flags: jsonb("flags").$type<string[]>().notNull().default([]),
    // tier de desempenho (6c): winner|performer|underperformer|zombie — histórico coerente.
    tier: text("tier"),
    analyzedAt: timestamp("analyzed_at", { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [uniqueIndex("entity_analyses_agent_entity_uq").on(t.agentId, t.entityId)],
);

/**
 * Cache de análise de criativo (visão) por CONTEÚDO — "analisar todos os criativos"
 * sem repetir custo a cada run. Chave = (contentHash, analyzerVersion); sem dado de
 * tenant (a análise é função pura da imagem + prompt + versão). Bumpar a versão
 * (env `CREATIVE_VISION_ANALYZER_VERSION`) invalida tudo.
 */
export const creativeVisionAnalyses = pgTable(
  "creative_vision_analyses",
  {
    id: pk(),
    contentHash: text("content_hash").notNull(),
    analyzerVersion: integer("analyzer_version").notNull(),
    result: jsonb("result").$type<CreativeVisionResult>().notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex("creative_vision_hash_version_uq").on(t.contentHash, t.analyzerVersion)],
);

/** Feedback + outcome tracking (instrumento de validação). */
export const recommendationFeedback = pgTable(
  "recommendation_feedback",
  {
    id: pk(),
    recommendationId: uuid("recommendation_id")
      .notNull()
      .references(() => recommendations.id, { onDelete: "cascade" }),
    vote: feedbackVote("vote"),
    // resultado observado após aplicar (positivo/negativo/neutro)
    outcome: outcomeStatus("outcome").notNull().default("pending"),
    outcomeMetrics: jsonb("outcome_metrics").$type<Record<string, unknown>>(),
    note: text("note"),
    measuredAt: timestamp("measured_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("recommendation_feedback_rec_idx").on(t.recommendationId)],
);

/**
 * Rascunho de campanha (Fatia 7) — ENTIDADE CENTRAL da criação. `from_scratch` ou
 * `duplicate`. Fonte única da verdade em qualquer gatilho (chat/site/proativo):
 * `approvals.draft_id` e `recommendations.draft_id` apontam pra cá. `spec` = contrato
 * NEUTRO versionado (Meta só no adapter). `created_ids` = ids parciais da saga p/
 * retomada idempotente. Nunca deletar (histórico) — status `reverted` desfaz.
 */
export const campaignDrafts = pgTable(
  "campaign_drafts",
  {
    id: pk(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    adAccountId: uuid("ad_account_id")
      .notNull()
      .references(() => adAccounts.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    kind: draftKind("kind").notNull(),
    status: draftStatus("status").notNull().default("proposed"),
    origin: draftOrigin("origin").notNull(),
    spec: jsonb("spec").$type<CampaignDraftSpec>().notNull(),
    // entidade-origem quando `duplicate` (o que foi copiado).
    sourceRef: jsonb("source_ref").$type<DraftSourceRef>(),
    // ids parciais criados na Meta (saga) p/ dedupe/retomada idempotente.
    createdIds: jsonb("created_ids").$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (t) => [
    index("campaign_drafts_account_idx").on(t.adAccountId),
    index("campaign_drafts_agent_idx").on(t.agentId),
    // throttle do PROATIVO: no máx. 1 rascunho proposto por conta (não pega chat/site).
    uniqueIndex("campaign_drafts_proactive_pending_uq")
      .on(t.adAccountId)
      .where(sql`status = 'proposed' and origin = 'proactive'`),
  ],
);

/**
 * Biblioteca de criativos por conta (Fatia 7). `reuse` = auto-populado dos anúncios
 * existentes (mídia já provada); `upload` = fornecido pelo usuário (web/WhatsApp). O
 * agente NUNCA inventa mídia — só reusa/recebe. `storage_ref` = blob no StoragePort;
 * `meta_image_hash`/`meta_video_id` = ids resolvidos na plataforma.
 */
export const creativeAssets = pgTable(
  "creative_assets",
  {
    id: pk(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    adAccountId: uuid("ad_account_id")
      .notNull()
      .references(() => adAccounts.id, { onDelete: "cascade" }),
    origin: creativeAssetOrigin("origin").notNull(),
    format: creativeFormat("format").notNull(),
    status: creativeAssetStatus("status").notNull().default("ready"),
    storageRef: text("storage_ref"),
    metaImageHash: text("meta_image_hash"),
    metaVideoId: text("meta_video_id"),
    // anúncio de origem quando `reuse` (liga o asset ao desempenho em ad_creatives).
    sourceAdId: text("source_ad_id"),
    // Arquivamento (soft-delete híbrido): excluir um asset EM USO (rascunho/campanha o
    // referencia) só ARQUIVA — some da biblioteca e do picker, mas a linha+blob ficam
    // (preview/histórico não quebram, Meta é independente). Asset livre é apagado de vez.
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("creative_assets_account_idx").on(t.adAccountId)],
);

import { pgEnum, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Helpers compartilhados entre grupos de schema.
 * Convenção: PK uuid (defaultRandom), timestamps `created_at`/`updated_at`.
 */

/** Colunas de timestamp padrão em (quase) toda tabela. */
export const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

/** PK uuid padrão. */
export const pk = () => uuid("id").primaryKey().defaultRandom();

// ─── Enums de domínio (reusados em vários grupos) ────────────────────────
export const membershipRole = pgEnum("membership_role", ["owner", "member"]);
// Status de acesso ao produto (gate). Nomes duráveis pós-beta: `active` = pode
// usar; `pending` = aguardando liberação; `revoked` = acesso removido.
export const accessStatus = pgEnum("access_status", ["pending", "active", "revoked"]);
export const tokenStatus = pgEnum("token_status", ["valid", "invalid", "unchecked"]);
// Propósito de um token de uso único (6b): verificação de email + reset de senha.
// Genérico (novos fluxos = novo valor), keyed só pelo hash — nunca o token em claro.
export const tokenPurpose = pgEnum("token_purpose", ["email_verification", "password_reset"]);
// Plataforma de anúncios de uma conexão externa (genérico — não vaza provider no
// conceito; novo provider = novo valor + adapter, sem tocar no core). §13.
export const platformType = pgEnum("platform_type", ["meta"]);
// Ciclo de vida da conta sob gestão. `active` = operando; `unavailable` = sumiu
// da plataforma (soft, preserva agente/histórico); `removed` = tirada pelo dono
// (soft). Nunca deletamos (cascata apagaria agente + histórico — §8/§13).
export const accountLifecycle = pgEnum("account_lifecycle", ["active", "unavailable", "removed"]);
// Estado de ATIVIDADE da conta (pivô) — ORTOGONAL ao lifecycle: uma conta `active`
// pode estar `dormant` (parou de anunciar) → backoff do cron; reativação recupera.
export const activityState = pgEnum("activity_state", ["active", "dormant"]);
export const channelStatus = pgEnum("channel_status", [
  "disconnected",
  "connecting",
  "connected",
]);
// Ciclo de vida do grupo WhatsApp configurado pela org (soft): `active` = o agente
// atua nele; `disabled` = desligado sem perder o registro. Espelha o padrão soft do resto.
export const channelGroupStatus = pgEnum("channel_group_status", ["active", "disabled"]);
export const contactRole = pgEnum("contact_role", ["owner", "member"]);

export const entityLevel = pgEnum("entity_level", ["account", "campaign", "adset", "ad"]);
export const entityStatus = pgEnum("entity_status", [
  "active",
  "paused",
  "deleted",
  "archived",
]);

export const actionType = pgEnum("action_type", [
  "pause_entity",
  "resume_entity",
  "adjust_budget",
  "set_status",
]);
export const actionSource = pgEnum("action_source", ["playbook", "llm"]);
export const riskLevel = pgEnum("risk_level", ["low", "medium", "high"]);
export const autonomyLevel = pgEnum("autonomy_level", [
  "notify",
  "suggest",
  "act_safe",
  "act_full",
]);

export const agentStatus = pgEnum("agent_status", ["active", "paused", "draft"]);
export const toolBindingMode = pgEnum("tool_binding_mode", ["enabled", "disabled", "shadow"]);
// Política de aprovação por capacidade (S4) — o catálogo declara COMO cada tool é
// gated: `auto` (por autonomia+origem), `approvals_table` (inbox site+WhatsApp,
// granular), `chat_confirm` (sempre eco+confirma). Execução unificada, gating diferenciado.
export const toolApprovalPolicy = pgEnum("tool_approval_policy", [
  "auto",
  "approvals_table",
  "chat_confirm",
]);
export const memoryType = pgEnum("memory_type", ["objective", "past_action", "rejected", "fact"]);
export const memoryLifecycle = pgEnum("memory_lifecycle", ["active", "stale", "archived"]);

// Dimensão de breakdown (S7, pivô saúde): idade+gênero combinados (Meta devolve juntos
// quando ambos os breakdowns são pedidos) e posicionamento (plataforma+posição). Só
// conta+campanha (S7 — adset/ad é fast-follow, ver ROADMAP).
export const breakdownDimension = pgEnum("breakdown_dimension", ["demographic", "placement"]);

export const runTrigger = pgEnum("run_trigger", ["cron", "on_demand", "conversation", "signal", "onboarding"]);
export const runStatus = pgEnum("run_status", [
  "pending",
  "running",
  "waiting_approval",
  "succeeded",
  "failed",
  "partial",
]);
export const approvalStatus = pgEnum("approval_status", [
  "pending",
  "approved",
  "rejected",
  "expired",
  // barrada no re-check fresco do apply (estado mudou / regra bloqueou) — 5b.
  "blocked",
]);
export const recommendationStatus = pgEnum("recommendation_status", [
  "open",
  "applied",
  "dismissed",
  "expired",
]);
// Formato da recomendação (S2) — espelha RECOMMENDATION_KINDS (@trafego/shared,
// fonte única do tipo+zod). Desacopla a recomendação da ação: `platform_action` =
// capacidade executável do catálogo; `human_direction` = direção que o humano
// executa (criativo/público, escalar/criar); `insight` = leitura, sem ação.
export const recommendationKind = pgEnum("recommendation_kind", [
  "platform_action",
  "human_direction",
  "insight",
]);
export const feedbackVote = pgEnum("feedback_vote", ["up", "down"]);
export const outcomeStatus = pgEnum("outcome_status", ["pending", "positive", "negative", "neutral"]);

export const messageDirection = pgEnum("message_direction", ["inbound", "outbound"]);

// ─── Criação de campanhas (Fatia 7) ──────────────────────────────────────
// `from_scratch` = campanha do zero; `duplicate` = cópia/escala de um vencedor.
export const draftKind = pgEnum("draft_kind", ["from_scratch", "duplicate"]);
// Discrimina a FORMA da aprovação (P0.1): `action` = ação de otimização (`action` set);
// `draft` = aprovação de CRIAR o rascunho (gasto novo, `draft_id` set); `activation` =
// aprovação de ATIVAR o que já foi criado (nasce sempre PAUSADO — 2º passo HITL, mesmo
// `draft_id`). Antes só existia `action`×`draft`, discriminado pela nulidade de `draft_id`;
// `activation` reusa o mesmo `draft_id`, então precisa de um discriminador explícito.
export const approvalKind = pgEnum("approval_kind", ["action", "draft", "activation"]);
// Ciclo de vida do rascunho: proposto → aprovado → criando → criado (ou falhou/revertido).
export const draftStatus = pgEnum("draft_status", [
  "proposed",
  "approved",
  "creating",
  "created",
  "failed",
  "reverted",
]);
// Origem do rascunho: pedido no chat/site (`on_demand`) ou proposto pelo agente (`proactive`).
export const draftOrigin = pgEnum("draft_origin", ["on_demand", "proactive"]);
// Origem do asset da biblioteca: reuso da conta ou upload do usuário.
export const creativeAssetOrigin = pgEnum("creative_asset_origin", ["reuse", "upload"]);
// Estado do asset (upload de vídeo processa async na plataforma).
export const creativeAssetStatus = pgEnum("creative_asset_status", ["pending", "ready", "error"]);
export const creativeFormat = pgEnum("creative_format", ["image", "video"]);

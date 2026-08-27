// Tool de DADOS ATUALIZADOS (chat, 5c+): consulta a Meta ao vivo (janela ≤ 7 dias)
// reusando o insightsSync.sync (mesmo pipeline da análise — mapa Meta→KPI, governor,
// rate-limit). Em erro/rate-limit o sync degrada (partial/tokenInvalid) SEM lançar; a
// gente lê o que já está salvo (insights_snapshots) e sinaliza que não atualizou. Só
// quando o período não existe nem no salvo é que retorna erro claro pro usuário.
//
// Nível conta (agregado) por padrão; se o usuário citar uma campanha, resolve o id
// (última análise) e agrega no nível campanha. Departure consciente do "chat só lê DB
// curado" (§7) — o usuário PEDE dado atualizado; fica atrás desta tool opt-in.

import { and, desc, eq, gte, lte } from "drizzle-orm";
import { addDays, todayInTz } from "@trafego/core";
import { adAccounts, agents, entityAnalyses, insightsSnapshots, platformConnections, type Database } from "@trafego/db";
import type { AdsPlatformPort, CredentialVaultPort } from "@trafego/shared/ports";
import type { AgentGoals, EntityLevel, StoredInsightMetrics } from "@trafego/shared/types";
import type { InsightsSyncService } from "../insights/sync-service.js";
import { markConnectionTokenInvalid } from "../../lib/mark-token-invalid.js";

/** Teto da janela (dias) — entre hoje e no máx 7 dias atrás. */
export const FRESH_METRICS_MAX_DAYS = 7;
/** Default: só hoje (situação do dia). */
export const FRESH_METRICS_DEFAULT_DAYS = 1;

const ACCOUNT_LEVEL: EntityLevel = "account";
const CAMPAIGN_LEVEL: EntityLevel = "campaign";

/** KPIs agregados da janela (null quando não dá pra derivar / sem base). */
export interface FreshKpis {
  readonly spend: number;
  readonly impressions: number;
  readonly clicks: number;
  readonly ctr: number | null;
  readonly cpc: number | null;
  readonly cpm: number | null;
  /** conversões de negócio na janela (null se a conta não reporta NENHUMA conversão). */
  readonly conversions: number | null;
  readonly cpa: number | null;
  /** ROAS = receita rastreada TOTAL / gasto (não só o goal de negócio) — mostra o retorno de
   *  compras mesmo quando o goal principal é conversa/lead (sem valor). Null se não há receita. */
  readonly roas: number | null;
  /** goal da conversão contada (rótulo p/ o texto — ex.: "messaging_started"); null = sem conversão. */
  readonly conversionGoal: string | null;
  /** receita rastreada TOTAL na janela (soma de todo `value` das conversões). Null = sem receita. */
  readonly revenue: number | null;
  /** TODAS as conversões da janela (goal→contagem/receita) — o agente enumera sem esconder nada. */
  readonly breakdown: ReadonlyArray<{ readonly goal: string; readonly count: number; readonly value: number | null }>;
}

/** Conversão de NEGÓCIO do agente p/ contar CPA/ROAS (vence o objetivo da entidade, §7). */
export interface BusinessGoal {
  readonly goal: string;
  readonly customConversionId?: string;
}

export interface FreshMetricsData {
  readonly level: "account" | "campaign";
  /** rótulo do alvo ("conta" ou o nome da campanha). */
  readonly target: string;
  readonly periodDays: number;
  readonly since: string;
  readonly until: string;
  /** data do snapshot mais recente somado. */
  readonly asOf: string;
  /** true = a Meta respondeu e atualizamos agora; false = mostrando o último sync salvo. */
  readonly updated: boolean;
  readonly kpis: FreshKpis;
}

/** Erro amigável (período inexistente até no salvo, conta/campanha não resolvida). */
export interface FreshMetricsError {
  readonly error: string;
}

export type FreshMetricsResult = FreshMetricsData | FreshMetricsError;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
function ratio(a: number, b: number): number | null {
  return b > 0 ? a / b : null;
}

/**
 * Soma a janela + re-deriva os KPIs (puro, testável). Conversões vêm do ARRAY `conversions`
 * (goal→count/value), NÃO de `metrics` (o snapshot diário guarda só o cru lá). Escolhe a
 * conversão de NEGÓCIO: `businessGoal` (config do agente) vence; sem ele, a de MAIOR volume
 * na janela (default sensato). CPA = gasto/contagem; ROAS = valor/gasto (só se veio valor).
 * Nenhuma conversão reportada → conversions/cpa/roas null (aí sim "a Meta não retornou").
 */
export function aggregateKpis(
  rows: readonly StoredInsightMetrics[],
  businessGoal?: BusinessGoal | null,
): FreshKpis {
  let spend = 0;
  let impressions = 0;
  let clicks = 0;
  // agrega o breakdown por (goal, customConversionId) — mesma semântica do brief.
  const conv = new Map<string, { goal: string; customConversionId?: string; count: number; value: number; hasValue: boolean }>();
  for (const r of rows) {
    const m = r?.metrics;
    if (!m) continue;
    spend += m.spend ?? 0;
    impressions += m.impressions ?? 0;
    clicks += m.clicks ?? 0;
    for (const c of r.conversions ?? []) {
      const k = `${c.goal}:${c.customConversionId ?? ""}`;
      const e =
        conv.get(k) ??
        { goal: c.goal, ...(c.customConversionId ? { customConversionId: c.customConversionId } : {}), count: 0, value: 0, hasValue: false };
      e.count += c.count;
      if (c.value !== undefined) {
        e.value += c.value;
        e.hasValue = true;
      }
      conv.set(k, e);
    }
  }
  const entries = [...conv.values()];
  const match = businessGoal
    ? entries.find(
        (e) =>
          e.goal === businessGoal.goal &&
          (businessGoal.customConversionId ? e.customConversionId === businessGoal.customConversionId : true),
      )
    : [...entries].sort((a, b) => b.count - a.count)[0];
  // receita TOTAL rastreada (todas as conversões com valor) → ROAS do retorno real, mesmo
  // quando o goal de negócio é conversa/lead (sem valor). Não esconde receita de compra.
  const revenueTotal = entries.reduce((s, e) => s + (e.hasValue ? e.value : 0), 0);
  const hasRevenue = entries.some((e) => e.hasValue);
  return {
    spend,
    impressions,
    clicks,
    ctr: ratio(clicks, impressions),
    cpc: ratio(spend, clicks),
    cpm: impressions > 0 ? (spend / impressions) * 1000 : null,
    conversions: match ? match.count : null,
    cpa: match && match.count > 0 ? ratio(spend, match.count) : null,
    roas: hasRevenue && spend > 0 ? revenueTotal / spend : null,
    conversionGoal: match?.goal ?? null,
    revenue: hasRevenue ? revenueTotal : null,
    breakdown: entries.map((e) => ({ goal: e.goal, count: e.count, value: e.hasValue ? e.value : null })),
  };
}

interface LoadedAccount {
  readonly id: string;
  readonly metaAdAccountId: string;
  readonly accessToken: string;
}

/** Conta ativa + token descriptografado (org-scoped, token da conexão dona). Null se não ativa. */
async function loadAccountToken(
  db: Database,
  vault: CredentialVaultPort,
  orgId: string,
  accountId: string,
): Promise<LoadedAccount | null> {
  const [account] = await db
    .select({
      id: adAccounts.id,
      metaAdAccountId: adAccounts.adAccountId,
      status: adAccounts.status,
      accountToken: adAccounts.tokenCripto,
      connToken: platformConnections.tokenCripto,
    })
    .from(adAccounts)
    .leftJoin(
      platformConnections,
      and(eq(adAccounts.connectionId, platformConnections.id), eq(platformConnections.orgId, adAccounts.orgId)),
    )
    .where(and(eq(adAccounts.id, accountId), eq(adAccounts.orgId, orgId)))
    .limit(1);
  if (!account || account.status !== "active") return null;
  const cripto = account.connToken ?? account.accountToken;
  if (!cripto) return null;
  return { id: account.id, metaAdAccountId: account.metaAdAccountId, accessToken: vault.decrypt(cripto) };
}

/** Resolve o id da campanha pelo nome (última análise; trecho, sem caixa). Null se não achar. */
async function resolveCampaignId(
  db: Database,
  agentId: string,
  name: string,
): Promise<{ id: string; name: string } | null> {
  const needle = name.toLowerCase();
  const rows = await db
    .select({ id: entityAnalyses.entityId, name: entityAnalyses.entityName, at: entityAnalyses.analyzedAt })
    .from(entityAnalyses)
    .where(and(eq(entityAnalyses.agentId, agentId), eq(entityAnalyses.entityLevel, CAMPAIGN_LEVEL)))
    .orderBy(desc(entityAnalyses.analyzedAt));
  const hit = rows.find((r) => (r.name ?? "").toLowerCase().includes(needle));
  return hit ? { id: hit.id, name: hit.name ?? name } : null;
}

async function readSnapshotRows(
  db: Database,
  orgId: string,
  adAccountUuid: string,
  level: EntityLevel,
  entityId: string | undefined,
  since: string,
  until: string,
): Promise<Array<{ date: string; metricsJson: StoredInsightMetrics }>> {
  const conds = [
    eq(insightsSnapshots.orgId, orgId),
    eq(insightsSnapshots.adAccountId, adAccountUuid),
    eq(insightsSnapshots.entityLevel, level),
    gte(insightsSnapshots.date, since),
    lte(insightsSnapshots.date, until),
  ];
  if (entityId) conds.push(eq(insightsSnapshots.entityId, entityId));
  const rows = await db
    .select({ date: insightsSnapshots.date, metricsJson: insightsSnapshots.metricsJson })
    .from(insightsSnapshots)
    .where(and(...conds));
  return rows as Array<{ date: string; metricsJson: StoredInsightMetrics }>;
}

export interface FreshMetricsDeps {
  readonly db: Database;
  readonly vault: CredentialVaultPort;
  readonly insightsSync: InsightsSyncService;
  /** ads port — só p/ resolver NOMES de campanha (listEntities) no breakdown por período. */
  readonly ads: AdsPlatformPort;
  readonly logger: { warn: (obj: unknown, msg: string) => void };
  /** relógio injetável (testes / cenário noturno). Default = agora. */
  readonly now?: () => Date;
}

export interface FreshMetricsCtx {
  readonly orgId: string;
  readonly agentId: string;
  readonly adAccountId: string;
  /** fuso da org (datas de "hoje"/janela nele, não UTC). */
  readonly timezone: string;
}

/**
 * Consulta KPIs atualizados (live Meta ≤7d) com fallback ao snapshot salvo.
 * 1) resolve o alvo (conta, ou campanha por nome) ANTES de tocar a Meta — campanha
 *    inexistente localmente erra na hora, sem gastar chamada/rate-limit à toa.
 * 2) atualiza via sync, restrito ao(s) nível(is) do alvo (não sincroniza os 4 níveis
 *    da análise completa — menos chamadas, menos exposição a rate-limit). Degrada
 *    sozinho (partial/tokenInvalid) sem lançar; defensivo contra throw inesperado →
 *    cai no snapshot salvo.
 * 3) lê o snapshot da janela (conta agregada ou campanha).
 * 4) sem linha no período (nem no salvo) → erro claro.
 */
/** Argumentos de recorte temporal: qualquer dia isolado OU período contíguo em [hoje, 7d atrás].
 *  `untilDaysAgo` = fim da janela em dias atrás (0=hoje, 1=ontem…); `sinceDaysAgo` = início (mais
 *  antigo). `periodDays` = atalho p/ "últimos N dias terminando em untilDaysAgo" quando `sinceDaysAgo`
 *  não vem. Dia isolado = só `untilDaysAgo` (ex.: ontem = untilDaysAgo:1). */
export interface FreshMetricsArgs {
  readonly periodDays?: number | null;
  readonly sinceDaysAgo?: number | null;
  readonly untilDaysAgo?: number | null;
  readonly campaign?: string | null;
}

export async function getFreshMetricsData(
  deps: FreshMetricsDeps,
  ctx: FreshMetricsCtx,
  args: FreshMetricsArgs,
): Promise<FreshMetricsResult> {
  // Rede de segurança: QUALQUER exceção não prevista (decrypt corrompido, blip de
  // Postgres fora do try do sync — ex: latestDate) não pode vazar como texto cru pro
  // usuário. O ToolNode do LangGraph (handleToolErrors:true, default) captura throws
  // de tool e devolve `Error: <mensagem interna>` pro LLM — sem este catch, esse texto
  // técnico podia ser parafraseado e chegar ao contato (§13: nunca vazar exceção/stack).
  try {
    return await getFreshMetricsDataInner(deps, ctx, args);
  } catch (err) {
    deps.logger.warn({ err: String(err) }, "fresh-metrics:falha inesperada");
    return { error: "não consegui consultar os dados agora. Tenta de novo em instantes." };
  }
}

/**
 * Janela [since,until] (YYYY-MM-DD, fuso da org) em DIAS ATRÁS: `untilDaysAgo` = fim
 * (0=hoje, 1=ontem); início por `sinceDaysAgo` OU `periodDays` (janela terminando no fim)
 * OU dia isolado no fim. Tudo dentro de [0, 7] dias atrás. `days` = nº de dias civis.
 */
function resolveWindow(args: FreshMetricsArgs, now: Date, tz: string): { since: string; until: string; days: number } {
  const untilAgo = clamp(args.untilDaysAgo ?? 0, 0, FRESH_METRICS_MAX_DAYS);
  const sinceAgo =
    args.sinceDaysAgo != null
      ? clamp(args.sinceDaysAgo, untilAgo, FRESH_METRICS_MAX_DAYS)
      : args.periodDays != null
        ? clamp(untilAgo + clamp(args.periodDays, 1, FRESH_METRICS_MAX_DAYS) - 1, untilAgo, FRESH_METRICS_MAX_DAYS)
        : untilAgo;
  const today = todayInTz(now, tz);
  return { since: addDays(today, -sinceAgo), until: addDays(today, -untilAgo), days: sinceAgo - untilAgo + 1 };
}

async function getFreshMetricsDataInner(
  deps: FreshMetricsDeps,
  ctx: FreshMetricsCtx,
  args: FreshMetricsArgs,
): Promise<FreshMetricsResult> {
  const now = (deps.now ?? (() => new Date()))();
  const { since, until, days } = resolveWindow(args, now, ctx.timezone);
  const account = await loadAccountToken(deps.db, deps.vault, ctx.orgId, ctx.adAccountId);
  if (!account) return { error: "não encontrei uma conta ativa em foco pra consultar agora." };

  let level: EntityLevel = ACCOUNT_LEVEL;
  let entityId: string | undefined;
  let target = "a conta";
  const campaign = args.campaign?.trim();
  if (campaign) {
    const resolved = await resolveCampaignId(deps.db, ctx.agentId, campaign);
    if (!resolved) {
      return { error: `não achei a campanha "${campaign}". Me diz o nome como aparece na conta.` };
    }
    level = CAMPAIGN_LEVEL;
    entityId = resolved.id;
    target = resolved.name;
  }

  // tenta ATUALIZAR (live Meta), só o nível do alvo — o sync completo (4 níveis) é
  // trabalho da análise, não desta leitura pontual.
  let updated = false;
  try {
    const res = await deps.insightsSync.sync({
      orgId: ctx.orgId,
      adAccountUuid: account.id,
      metaAdAccountId: account.metaAdAccountId,
      accessToken: account.accessToken,
      today: todayInTz(now, ctx.timezone),
      levels: [level],
    });
    updated = !res.partial && !res.tokenInvalid;
    if (res.tokenInvalid) await markConnectionTokenInvalid(deps.db, ctx.orgId, account.id).catch(() => {});
  } catch (err) {
    deps.logger.warn({ err: String(err) }, "fresh-metrics:sync falhou (fallback ao snapshot)");
  }

  const rows = await readSnapshotRows(deps.db, ctx.orgId, account.id, level, entityId, since, until);
  if (rows.length === 0) {
    const tail = updated ? "" : " e não consegui atualizar agora";
    return { error: `não tenho dados de ${target} entre ${since} e ${until}${tail}.` };
  }

  // conversão de NEGÓCIO do agente (vence o objetivo da entidade, §7) — p/ CPA/ROAS.
  const businessGoal = await loadBusinessGoal(deps.db, ctx.orgId, ctx.agentId);

  const asOf = rows.reduce((latest, r) => (r.date > latest ? r.date : latest), rows[0]!.date);
  return {
    level: level === CAMPAIGN_LEVEL ? "campaign" : "account",
    target,
    periodDays: days,
    since,
    until,
    asOf,
    updated,
    kpis: aggregateKpis(rows.map((r) => r.metricsJson), businessGoal),
  };
}

/** Conversão de negócio configurada no agente (goals.conversionGoal) — null se zero-config. */
async function loadBusinessGoal(db: Database, orgId: string, agentId: string): Promise<BusinessGoal | null> {
  const [row] = await db
    .select({ goals: agents.goals })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)))
    .limit(1);
  const goals = row?.goals as AgentGoals | undefined;
  if (!goals?.conversionGoal) return null;
  return {
    goal: goals.conversionGoal,
    ...(goals.customConversionId ? { customConversionId: goals.customConversionId } : {}),
  };
}

/** Uma campanha no breakdown por período (KPIs da janela + nome/status resolvidos). */
export interface FreshCampaignRow {
  readonly id: string;
  readonly name: string;
  readonly status: string | null;
  readonly kpis: FreshKpis;
}

export interface FreshCampaignsBreakdown {
  readonly since: string;
  readonly until: string;
  readonly periodDays: number;
  readonly updated: boolean;
  readonly campaigns: readonly FreshCampaignRow[];
}

/**
 * Breakdown FRESH por campanha para QUALQUER período (≤7d): agrega os snapshots
 * campaign-level da janela (gasto/conversões/CPA/ROAS/receita por campanha, via
 * `aggregateKpis` + goal de negócio) e resolve o NOME de cada uma via `listEntities`
 * (Meta) — porque o snapshot só tem o id. É a divisão por campanha que o agregado da
 * conta não dá, agora recortável por dia/período. Erro inesperado → mensagem amigável.
 */
export async function getCampaignsBreakdownData(
  deps: FreshMetricsDeps,
  ctx: FreshMetricsCtx,
  args: FreshMetricsArgs,
): Promise<FreshCampaignsBreakdown | FreshMetricsError> {
  try {
    const now = (deps.now ?? (() => new Date()))();
    const { since, until, days } = resolveWindow(args, now, ctx.timezone);
    const account = await loadAccountToken(deps.db, deps.vault, ctx.orgId, ctx.adAccountId);
    if (!account) return { error: "não encontrei uma conta ativa em foco pra consultar agora." };

    let updated = false;
    try {
      const res = await deps.insightsSync.sync({
        orgId: ctx.orgId,
        adAccountUuid: account.id,
        metaAdAccountId: account.metaAdAccountId,
        accessToken: account.accessToken,
        today: todayInTz(now, ctx.timezone),
        levels: [CAMPAIGN_LEVEL],
      });
      updated = !res.partial && !res.tokenInvalid;
      if (res.tokenInvalid) await markConnectionTokenInvalid(deps.db, ctx.orgId, account.id).catch(() => {});
    } catch (err) {
      deps.logger.warn({ err: String(err) }, "campaigns-breakdown:sync falhou (fallback ao snapshot)");
    }

    // snapshots campaign-level da janela COM o id (readSnapshotRows não devolve entityId).
    const rows = await deps.db
      .select({ entityId: insightsSnapshots.entityId, metricsJson: insightsSnapshots.metricsJson })
      .from(insightsSnapshots)
      .where(
        and(
          eq(insightsSnapshots.orgId, ctx.orgId),
          eq(insightsSnapshots.adAccountId, account.id),
          eq(insightsSnapshots.entityLevel, CAMPAIGN_LEVEL),
          gte(insightsSnapshots.date, since),
          lte(insightsSnapshots.date, until),
        ),
      );
    if (rows.length === 0) return { since, until, periodDays: days, updated, campaigns: [] };

    const businessGoal = await loadBusinessGoal(deps.db, ctx.orgId, ctx.agentId);

    // agrupa por campanha e re-deriva os KPIs da janela por grupo.
    const byId = new Map<string, StoredInsightMetrics[]>();
    for (const r of rows) {
      const list = byId.get(r.entityId) ?? [];
      list.push(r.metricsJson as StoredInsightMetrics);
      byId.set(r.entityId, list);
    }

    // NOME/status por id — via Meta (o snapshot não guarda nome). Best-effort: se falhar,
    // cai no id (nunca quebra a leitura).
    const names = new Map<string, { name: string; status: string }>();
    try {
      const entities = await deps.ads.listEntities(
        { adAccountId: account.metaAdAccountId, accessToken: account.accessToken },
        CAMPAIGN_LEVEL,
      );
      for (const e of entities) names.set(e.id, { name: e.name, status: e.status });
    } catch (err) {
      deps.logger.warn({ err: String(err) }, "campaigns-breakdown:listEntities falhou (usa id como nome)");
    }

    const campaigns: FreshCampaignRow[] = [...byId.entries()]
      .map(([id, snaps]) => ({
        id,
        name: names.get(id)?.name ?? id,
        status: names.get(id)?.status ?? null,
        kpis: aggregateKpis(snaps, businessGoal),
      }))
      .sort((a, b) => b.kpis.spend - a.kpis.spend);

    return { since, until, periodDays: days, updated, campaigns };
  } catch (err) {
    deps.logger.warn({ err: String(err) }, "campaigns-breakdown:falha inesperada");
    return { error: "não consegui consultar as campanhas agora. Tenta de novo em instantes." };
  }
}

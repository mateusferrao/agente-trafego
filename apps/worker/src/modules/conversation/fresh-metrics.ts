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
import { adAccounts, entityAnalyses, insightsSnapshots, platformConnections, type Database } from "@trafego/db";
import type { CredentialVaultPort } from "@trafego/shared/ports";
import type { EntityLevel, StoredInsightMetrics } from "@trafego/shared/types";
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
  /** conversões de negócio na janela (null se a conta não reporta conversão). */
  readonly conversions: number | null;
  readonly cpa: number | null;
  readonly roas: number | null;
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
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - (days - 1)); // days=1 → hoje; days=7 → 6 dias atrás..hoje
  return d.toISOString().slice(0, 10);
}
function ratio(a: number, b: number): number | null {
  return b > 0 ? a / b : null;
}

/** Soma a janela + re-deriva os KPIs (puro, testável). */
export function aggregateKpis(rows: readonly StoredInsightMetrics[]): FreshKpis {
  let spend = 0;
  let impressions = 0;
  let clicks = 0;
  let conversions = 0;
  let convSeen = false;
  let valueTotal = 0;
  let valueSeen = false;
  for (const r of rows) {
    const m = r?.metrics;
    if (!m) continue;
    spend += m.spend ?? 0;
    impressions += m.impressions ?? 0;
    clicks += m.clicks ?? 0;
    if (typeof m.conversions === "number") {
      conversions += m.conversions;
      convSeen = true;
    }
    // valor (p/ ROAS agregado) reconstruído do roas diário × gasto diário.
    if (typeof m.roas === "number" && typeof m.spend === "number") {
      valueTotal += m.roas * m.spend;
      valueSeen = true;
    }
  }
  return {
    spend,
    impressions,
    clicks,
    ctr: ratio(clicks, impressions),
    cpc: ratio(spend, clicks),
    cpm: impressions > 0 ? (spend / impressions) * 1000 : null,
    conversions: convSeen ? conversions : null,
    cpa: convSeen ? ratio(spend, conversions) : null,
    roas: valueSeen ? ratio(valueTotal, spend) : null,
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
  readonly logger: { warn: (obj: unknown, msg: string) => void };
}

export interface FreshMetricsCtx {
  readonly orgId: string;
  readonly agentId: string;
  readonly adAccountId: string;
}

/**
 * Consulta KPIs atualizados (live Meta ≤7d) com fallback ao snapshot salvo.
 * 1) atualiza via sync (absorve rate-limit → partial; token 190 → tokenInvalid).
 * 2) lê o snapshot da janela (conta agregada ou campanha por nome).
 * 3) sem linha no período (nem no salvo) → erro claro.
 */
export async function getFreshMetricsData(
  deps: FreshMetricsDeps,
  ctx: FreshMetricsCtx,
  args: { periodDays?: number | null; campaign?: string | null },
): Promise<FreshMetricsResult> {
  const days = clamp(args.periodDays ?? FRESH_METRICS_DEFAULT_DAYS, 1, FRESH_METRICS_MAX_DAYS);
  const account = await loadAccountToken(deps.db, deps.vault, ctx.orgId, ctx.adAccountId);
  if (!account) return { error: "não encontrei uma conta ativa em foco pra consultar agora." };

  // tenta ATUALIZAR (live Meta). sync degrada sozinho (partial/tokenInvalid) sem lançar;
  // defensivo contra throw inesperado → cai no snapshot salvo.
  let updated = false;
  try {
    const res = await deps.insightsSync.sync({
      orgId: ctx.orgId,
      adAccountUuid: account.id,
      metaAdAccountId: account.metaAdAccountId,
      accessToken: account.accessToken,
      today: todayIso(),
    });
    updated = !res.partial && !res.tokenInvalid;
    if (res.tokenInvalid) await markConnectionTokenInvalid(deps.db, ctx.orgId, account.id).catch(() => {});
  } catch (err) {
    deps.logger.warn({ err: String(err) }, "fresh-metrics:sync falhou (fallback ao snapshot)");
  }

  const until = todayIso();
  const since = isoDaysAgo(days);

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

  const rows = await readSnapshotRows(deps.db, ctx.orgId, account.id, level, entityId, since, until);
  if (rows.length === 0) {
    const tail = updated ? "" : " e não consegui atualizar agora";
    return { error: `não tenho dados de ${target} entre ${since} e ${until}${tail}.` };
  }

  const asOf = rows.reduce((latest, r) => (r.date > latest ? r.date : latest), rows[0]!.date);
  return {
    level: level === CAMPAIGN_LEVEL ? "campaign" : "account",
    target,
    periodDays: days,
    since,
    until,
    asOf,
    updated,
    kpis: aggregateKpis(rows.map((r) => r.metricsJson)),
  };
}

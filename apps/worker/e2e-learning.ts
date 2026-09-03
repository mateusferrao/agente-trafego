/**
 * E2E DETERMINÍSTICO do aprendizado contínuo v3 (R1–R8) — SEM LLM real.
 *
 * Roda o loop de aprendizado ponta-a-ponta contra um POSTGRES REAL, com o redator LLM
 * STUBADO (saída fixa) e um relógio FIXO (`NOW`). Cobre o SQL REAL — org-scoping, ledger
 * de evidência, destilação cross-seccional (≥K entidades), proposta de limiar (hard-wall),
 * padrões temporais, aviso de oportunidade, kill-switch, dormância — que os testes de
 * unidade (fakes) não cobrem.
 *
 * Cenários (v3 — o observacional POR-ENTIDADE foi cortado; o aprendizado é de CONTA):
 *   1. Prior de tracking (conta só-análise): tracking suspeito recorrente → fact/account.
 *   2. Dedup + reforço do prior de tracking.
 *   3. Ledger + prior de conta (ação nossa): K entidades cortadas com sucesso → account prior.
 *   4. < K entidades → NÃO nasce prior de conta.
 *   5. Proposta de limiar + HARD-WALL: aceitar muda SÓ model_config.quality; guardrail/autonomia intactos.
 *   6. Rejeitar/Reverter proposta.
 *   7. Mudança MANUAL do gestor → ledger (conta só-análise aprende).
 *   8. Padrões temporais: timing de fadiga + lag de conversão.
 *   9. Guard assimétrico de CONTA (puro): hipótese não-confirmada rebaixa escala; nunca libera.
 *  10. Aviso de oportunidade (puro) + dispensa (SQL).
 *  11. Decaimento: active→stale→archived; confirmada nunca decai.
 *  12. Isolamento por org (sem vazamento cross-tenant).
 *  13. Kill-switch: agente com learning.enabled=false fora do listLearnableAgents; dormante idem.
 *
 * Rodar: `apps/worker/e2e-learning.sh` (sobe Postgres, migra, executa, derruba).
 * Manual: exporte DATABASE_URL p/ um Postgres migrado e rode `cd apps/worker && npx tsx e2e-learning.ts`
 */
import { and, eq, sql } from "drizzle-orm";
import {
  adAccounts,
  advisoryDismissals,
  agentMemory,
  agentRuns,
  agentToolCalls,
  agents,
  createDb,
  entityConfigSnapshots,
  guardrailConfigs,
  insightsSnapshots,
  learningEvidence,
  orgs,
  platformConnections,
  recommendationFeedback,
  recommendations,
} from "@trafego/db";
import type { Action, EncryptedPayload, InsightMetrics, OrgId, StoredInsightMetrics } from "@trafego/shared";
import type { AnalysisOutput } from "@trafego/shared/schemas";
import type { SchedulerPort } from "@trafego/shared/ports";
import {
  detectGuardrailOpportunity,
  guardUnconfirmedHypothesis,
  selectLessonsForBrief,
  type LessonGuard,
  type StoredLesson,
} from "@trafego/core";
import { acceptThreshold, dismissAdvisory, rejectProposal, revertThreshold } from "@trafego/agent-config";
import { pino } from "pino";
import { createLearningRepo } from "./src/modules/learning/repo.js";
import { createOutcomeRepo } from "./src/modules/learning/outcome-repo.js";
import { createLearningService, type LearningServiceConfig } from "./src/modules/learning/service.js";

// ─── infra de teste ────────────────────────────────────────────────────────

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL não definida — rode via e2e-learning.sh (sobe o Postgres).");
  process.exit(1);
}
const db = createDb(DATABASE_URL);
const logger = pino({ level: "silent" });

const NOW = new Date("2026-09-02T12:00:00.000Z");
/** Scheduler stub (o accept de limiar reagenda cron; aqui é no-op determinístico). */
const stubScheduler = { enqueue: async () => {}, schedule: async () => {}, remove: async () => {}, removeSchedule: async () => {} } as unknown as SchedulerPort;
const QUALITY_DEFAULTS: Record<string, unknown> = { zombieMinSpend: 50, marginalCpaWorsenPct: 20 };

const CONFIG: LearningServiceConfig = {
  historyRuns: 20,
  minRuns: 3,
  minOccurrenceRatio: 0.5,
  maxNewLessonsPerTick: 100,
  decayStaleDays: 14,
  decayArchiveDays: 30,
  confirmedStaleDays: 90,
  confirmedArchiveDays: 180,
  phaseBufferDays: 1,
  outcomeWindowDays: 7,
  accountMinEntities: 3,
  temporalLookbackDays: 60,
};

const repo = createLearningRepo(db);
const outcomeRepo = createOutcomeRepo(db);
const service = createLearningService({ repo, outcomeRepo, logger, config: CONFIG, now: () => NOW });

// ─── asserção ────────────────────────────────────────────────────────────────

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}`, detail !== undefined ? JSON.stringify(detail).slice(0, 300) : "");
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
const daysFromNow = (n: number): Date => new Date(NOW.getTime() + n * DAY_MS);
const dateStr = (n: number): string => daysFromNow(n).toISOString().slice(0, 10);
const FAKE_TOKEN: EncryptedPayload = { ciphertext: "x", iv: "y", tag: "z", keyVersion: 1 };

// ─── seeding ─────────────────────────────────────────────────────────────────

let seq = 0;
const uniq = (p: string) => `${p}-${Date.now()}-${seq++}`;

interface SeededAgent {
  readonly orgId: string;
  readonly agentId: string;
  readonly adAccountId: string;
}

async function seedAgent(opts: { dormant?: boolean; label: string; learningDisabled?: boolean }): Promise<SeededAgent> {
  const [org] = await db.insert(orgs).values({ name: opts.label, slug: uniq("slug") }).returning({ id: orgs.id });
  const orgId = org!.id;
  const [conn] = await db.insert(platformConnections).values({ orgId, platform: "meta", tokenCripto: FAKE_TOKEN, tokenStatus: "valid" }).returning({ id: platformConnections.id });
  const [acc] = await db
    .insert(adAccounts)
    .values({ orgId, connectionId: conn!.id, adAccountId: uniq("act"), name: opts.label, currency: "BRL", status: "active", activityState: opts.dormant ? "dormant" : "active", tokenCripto: FAKE_TOKEN, tokenStatus: "valid" })
    .returning({ id: adAccounts.id });
  const adAccountId = acc!.id;
  const modelConfig = opts.learningDisabled ? { learning: { enabled: false } } : {};
  const [agent] = await db
    .insert(agents)
    .values({ orgId, adAccountId, archetype: "otimizador", status: "active", autonomyPolicy: {} as never, modelConfig: modelConfig as never })
    .returning({ id: agents.id });
  return { orgId, agentId: agent!.id, adAccountId };
}

async function seedRun(a: SeededAgent, dayOffset: number, snapshot: Record<string, unknown>): Promise<string> {
  const at = daysFromNow(dayOffset);
  const [run] = await db.insert(agentRuns).values({ orgId: a.orgId, agentId: a.agentId, trigger: "cron", status: "succeeded", metricsSnapshot: snapshot, createdAt: at, updatedAt: at }).returning({ id: agentRuns.id });
  return run!.id;
}

/** metrics_snapshot com medição de conversão SUSPEITA (o único fact observacional v3). */
const trackingSuspectSnapshot = (): Record<string, unknown> => ({ trackingHealth: { suspect: true, funnelStarted: 100, trackedConversions: 1, ratio: 100 } });

function metrics(spend: number, conversions: number, ctr = 2): StoredInsightMetrics {
  const m: InsightMetrics = { spend, impressions: 10000, clicks: 200, ctr, cpc: spend / 200, cpm: spend / 10, conversions };
  return { metrics: m };
}

async function seedInsights(a: SeededAgent, entityId: string, fromDay: number, toDay: number, perDay: StoredInsightMetrics): Promise<void> {
  for (let d = fromDay; d <= toDay; d++) {
    await db.insert(insightsSnapshots).values({ orgId: a.orgId, adAccountId: a.adAccountId, entityLevel: "campaign", entityId, date: dateStr(d), metricsJson: perDay });
  }
}

/** Ação NOSSA de CORTE (reduzir orçamento) que deu CERTO numa entidade — evidência budget:lower. */
async function seedOurCutWorked(a: SeededAgent, campaignId: string): Promise<void> {
  const runId = await seedRun(a, -10, { campaigns: [] });
  const action: Action = { id: uniq("a"), type: "adjust_budget", target: { level: "campaign", id: campaignId, name: campaignId }, params: { mode: "decrease" }, source: "llm", riskLevel: "medium", reason: "cpa alto" };
  await db.insert(recommendations).values({ orgId: a.orgId, runId, title: "Reduzir verba", kind: "platform_action", proposedAction: action, createdAt: daysFromNow(-10), updatedAt: daysFromNow(-10) });
  await db.insert(agentToolCalls).values({ agentId: a.agentId, runId, toolKey: "adjust_budget", idempotencyKey: uniq("idem"), args: { target: { id: campaignId }, dryRun: false }, beforeState: { dailyBudget: 10000 }, createdAt: daysFromNow(-10), updatedAt: daysFromNow(-10) });
  // entidade: CPA melhora pós-corte (pré 100 → pós 40) → outcome positive (budget_down usa janela da entidade).
  await seedInsights(a, campaignId, -17, -11, metrics(1000, 10)); // pré cpa 100
  await seedInsights(a, campaignId, -9, -3, metrics(400, 10)); // pós cpa 40
}

/** Mudança MANUAL do gestor (corte de orçamento) que deu certo — evidência human_manual/budget:lower. */
async function seedManualCutWorked(a: SeededAgent, campaignId: string): Promise<void> {
  await db.insert(entityConfigSnapshots).values({ orgId: a.orgId, adAccountId: a.adAccountId, entityLevel: "campaign", entityId: campaignId, date: dateStr(-11), configJson: { status: "active", dailyBudgetMinor: 10000 } });
  await db.insert(entityConfigSnapshots).values({ orgId: a.orgId, adAccountId: a.adAccountId, entityLevel: "campaign", entityId: campaignId, date: dateStr(-10), configJson: { status: "active", dailyBudgetMinor: 5000 } });
  await seedInsights(a, campaignId, -17, -11, metrics(600, 6)); // pré cpa 100
  await seedInsights(a, campaignId, -9, -3, metrics(240, 6)); // pós cpa 40
}

async function loadLesson(agentId: string, semanticKey: string): Promise<Record<string, unknown> | null> {
  const [row] = await db.select().from(agentMemory).where(and(eq(agentMemory.agentId, agentId), eq(agentMemory.semanticKey, semanticKey), sql`${agentMemory.lifecycle} <> 'archived'`)).limit(1);
  return (row as Record<string, unknown>) ?? null;
}
async function lifecycleOf(agentId: string, semanticKey: string): Promise<string | null> {
  const [row] = await db.select({ lifecycle: agentMemory.lifecycle }).from(agentMemory).where(and(eq(agentMemory.agentId, agentId), eq(agentMemory.semanticKey, semanticKey))).limit(1);
  return row?.lifecycle ?? null;
}

async function seedLesson(a: SeededAgent, o: { key: string; lifecycle: "active" | "stale" | "archived"; lastReinforcedDay: number; confirmed: boolean }): Promise<void> {
  const [scope, dimension, direction, pattern] = o.key.split(":");
  await db.insert(agentMemory).values({
    orgId: a.orgId, agentId: a.agentId, type: "fact", content: "lição semeada", confidence: 0.5, lifecycle: o.lifecycle,
    scope: scope as never, dimension: dimension as never, direction: direction as never, ...(pattern ? { pattern } : {}), origin: "observational",
    semanticKey: o.key, confirmedByHuman: o.confirmed, reinforceCount: 1, lastReinforcedAt: daysFromNow(o.lastReinforcedDay),
  });
}

function storedLesson(key: string, o: { confidence: number; confirmedByHuman: boolean; origin?: StoredLesson["origin"] }): StoredLesson {
  const [scope, dimension, direction, pattern] = key.split(":");
  return {
    id: key, kind: "fact", key: { scope: scope as never, dimension: dimension as never, direction: direction as never, ...(pattern ? { pattern: pattern as never } : {}) },
    content: "l", confidence: o.confidence, confirmedByHuman: o.confirmedByHuman, origin: o.origin ?? "observational", lifecycle: "active", reinforceCount: 1,
  };
}

// ─── cenários ─────────────────────────────────────────────────────────────────

/** 1+2: prior de tracking (conta só-análise) + dedup/reforço. */
async function scenarioTracking(): Promise<void> {
  console.log("\n▶ Cenário 1+2 — prior de tracking (conta só-análise) + dedup/reforço");
  const a = await seedAgent({ label: "tracking-conta" });
  for (const off of [-40, -30, -20, -10]) await seedRun(a, off, trackingSuspectSnapshot());
  const r1 = await service.runTick();
  const lesson = await loadLesson(a.agentId, "account:tracking:neutral:recurring_tracking_suspect");
  ok("1.1 destilou prior de tracking de CONTA", r1.created >= 1 && lesson !== null, r1);
  ok("1.2 fact/account/observational", lesson?.type === "fact" && lesson?.scope === "account" && lesson?.origin === "observational", { type: lesson?.type, scope: lesson?.scope });
  ok("1.3 confiança ≤ teto observacional (0.6)", ((lesson?.confidence as number) ?? 1) <= 0.6, lesson?.confidence);
  ok("1.4 NENHUM prior por-ENTIDADE (observacional entity foi cortado)", (await countEntityFacts(a.agentId)) === 0);

  const before = await loadLesson(a.agentId, "account:tracking:neutral:recurring_tracking_suspect");
  const r2 = await service.runTick();
  const after = await loadLesson(a.agentId, "account:tracking:neutral:recurring_tracking_suspect");
  ok("2.1 re-tick sem run novo NÃO reforça (dedup)", r2.reinforced === 0 && after?.reinforceCount === before?.reinforceCount, { r2, b: before?.reinforceCount, a: after?.reinforceCount });
  await seedRun(a, -2, trackingSuspectSnapshot());
  const r3 = await service.runTick();
  const reinforced = await loadLesson(a.agentId, "account:tracking:neutral:recurring_tracking_suspect");
  ok("2.2 run novo reforça (≤ teto 0.6)", r3.reinforced >= 1 && ((reinforced?.confidence as number) ?? 1) <= 0.6, r3);
}

async function countEntityFacts(agentId: string): Promise<number> {
  const rows = await db.select({ id: agentMemory.id }).from(agentMemory).where(and(eq(agentMemory.agentId, agentId), eq(agentMemory.scope, "entity")));
  return rows.length;
}

/** 3+4: ledger + prior de CONTA (ação nossa) — nasce só com ≥K entidades distintas. */
async function scenarioAccountPrior(): Promise<void> {
  console.log("\n▶ Cenário 3+4 — ledger + destilação de prior de conta (≥K entidades)");
  const a = await seedAgent({ label: "acc-prior" });
  const camps = [uniq("c"), uniq("c"), uniq("c")];
  for (const c of camps) await seedOurCutWorked(a, c);
  const r = await service.runTick();
  ok("3.1 mediu os 3 outcomes", r.measured >= 3, r);
  const ev = await db.select({ id: learningEvidence.id }).from(learningEvidence).where(eq(learningEvidence.agentId, a.agentId));
  ok("3.2 ledger de evidência gravado (≥3 linhas, our_action)", ev.length >= 3, ev.length);
  const prior = await loadLesson(a.agentId, "account:budget:lower:account_cut_pays");
  ok("3.3 prior de CONTA destilado (account_cut_pays)", prior?.scope === "account" && prior?.dimension === "budget" && prior?.direction === "lower", prior);
  ok("3.4 confiança ≥ limiar do prompt (0.7) com 3 entidades", ((prior?.confidence as number) ?? 0) >= 0.7, prior?.confidence);
  ok("3.5 NENHUM prior por-entidade (calibração entity cortada)", (await countEntityFacts(a.agentId)) === 0);

  // < K entidades → NÃO nasce.
  const b = await seedAgent({ label: "acc-prior-belowK" });
  for (const c of [uniq("c"), uniq("c")]) await seedOurCutWorked(b, c); // só 2
  await service.runTick();
  ok("4.1 < K (2) entidades → NÃO nasce prior de conta", (await loadLesson(b.agentId, "account:budget:lower:account_cut_pays")) === null);
}

/** 5+6: proposta de limiar + HARD-WALL (aceitar/rejeitar/reverter). */
async function scenarioThresholdHardWall(): Promise<void> {
  console.log("\n▶ Cenário 5+6 — proposta de limiar + HARD-WALL guardrail/autonomia");
  const a = await seedAgent({ label: "threshold" });
  // guardrail + autonomia semeados p/ provar que NÃO são tocados.
  await db.insert(guardrailConfigs).values({ orgId: a.orgId, agentId: a.agentId, maxBudgetChangePct: 20, maxEntitiesPerDay: 3 });
  await db.update(agents).set({ autonomyPolicy: { bySource: { playbook: "suggest", llm: "notify" } } as never }).where(eq(agents.id, a.agentId));
  const grBefore = await guardrailSnapshot(a.agentId);
  const auBefore = await autonomySnapshot(a.agentId);
  // 5 entidades cortadas → confiança ≥ 0.8 → proposta pendente.
  for (let i = 0; i < 5; i++) await seedOurCutWorked(a, uniq("c"));
  await service.runTick();
  const prior = await loadLesson(a.agentId, "account:budget:lower:account_cut_pays");
  const patch = prior?.proposedThresholdPatch as { threshold?: string } | null;
  ok("5.1 prior forte (≥5 entidades) nasce com proposta de limiar", patch?.threshold === "zombieMinSpend", patch);

  // ACEITAR → muda SÓ model_config.quality; guardrail + autonomia intactos (hard-wall).
  const ref = { orgId: a.orgId as OrgId, agentId: a.agentId, lessonId: prior!.id as string };
  const accept = await acceptThreshold({ db, scheduler: stubScheduler, qualityDefaults: QUALITY_DEFAULTS }, ref, { label: "user" });
  ok("5.2 acceptThreshold ok", accept.ok, accept);
  const quality = await qualityOf(a.agentId);
  ok("5.3 model_config.quality.zombieMinSpend REDUZIDO (25% do default 50 = 37.5)", quality?.zombieMinSpend === 37.5, quality);
  ok("5.4 HARD-WALL: guardrail_configs INTACTO", deepEq(await guardrailSnapshot(a.agentId), grBefore), { before: grBefore, after: await guardrailSnapshot(a.agentId) });
  ok("5.5 HARD-WALL: autonomy_policy INTACTO", deepEq(await autonomySnapshot(a.agentId), auBefore), { before: auBefore, after: await autonomySnapshot(a.agentId) });
  const accepted = await loadLesson(a.agentId, "account:budget:lower:account_cut_pays");
  ok("5.6 proposta consumida + lição confirmada + applied guardado", accepted?.proposedThresholdPatch === null && accepted?.confirmedByHuman === true && !!accepted?.appliedThresholdPatch, accepted?.confirmedByHuman);

  // REVERTER → restaura o valor anterior (50); hard-wall de novo.
  const revert = await revertThreshold({ db, scheduler: stubScheduler, qualityDefaults: QUALITY_DEFAULTS }, ref, { label: "user" });
  ok("6.1 revertThreshold ok", revert.ok, revert);
  ok("6.2 zombieMinSpend restaurado ao valor anterior (50)", (await qualityOf(a.agentId))?.zombieMinSpend === 50, await qualityOf(a.agentId));

  // REJEITAR (num outro agente com proposta): descarta o patch sem tocar config.
  const b = await seedAgent({ label: "threshold-reject" });
  for (let i = 0; i < 5; i++) await seedOurCutWorked(b, uniq("c"));
  await service.runTick();
  const bp = await loadLesson(b.agentId, "account:budget:lower:account_cut_pays");
  const rej = await rejectProposal(db, { orgId: b.orgId as OrgId, agentId: b.agentId, lessonId: bp!.id as string });
  ok("6.3 rejectProposal ok", rej.ok, rej);
  const rejected = await loadLesson(b.agentId, "account:budget:lower:account_cut_pays");
  ok("6.4 rejeitada: patch limpo + resolvido (trava re-oferta)", rejected?.proposedThresholdPatch === null && rejected?.thresholdResolvedAt !== null, rejected?.thresholdResolvedAt);
}

/** 7: mudança manual do gestor → ledger → prior de conta (conta só-análise aprende). */
async function scenarioManual(): Promise<void> {
  console.log("\n▶ Cenário 7 — mudança MANUAL do gestor → ledger (conta só-análise)");
  const a = await seedAgent({ label: "manual" });
  for (const c of [uniq("c"), uniq("c"), uniq("c")]) await seedManualCutWorked(a, c);
  await service.runTick();
  const ev = await db.select({ source: learningEvidence.source }).from(learningEvidence).where(eq(learningEvidence.agentId, a.agentId));
  ok("7.1 evidência gravada com source=human_manual", ev.length >= 3 && ev.every((e) => e.source === "human_manual"), ev.map((e) => e.source));
  ok("7.2 prior de conta destilado da mudança manual", (await loadLesson(a.agentId, "account:budget:lower:account_cut_pays")) !== null);
}

/** 8: padrões temporais — timing de fadiga + lag de conversão (contas SEPARADAS p/ séries limpas). */
async function scenarioTemporal(): Promise<void> {
  console.log("\n▶ Cenário 8 — padrões temporais (fadiga + lag de conversão)");
  // Fadiga: 3 campanhas com CTR alto na largada que despenca ~dia 6 (variância baixa).
  const af = await seedAgent({ label: "temporal-fatigue" });
  for (const c of [uniq("f"), uniq("f"), uniq("f")]) {
    for (let d = 0; d < 12; d++) await seedInsights(af, c, -20 + d, -20 + d, metrics(500, 5, d < 6 ? 5 : 1));
  }
  await service.runTick();
  ok("8.1 prior de timing de fadiga (account/creative)", (await loadLesson(af.agentId, "account:creative:neutral:account_fatigue_timing")) !== null);

  // Lag: conta com UMA campanha cuja conversão espelha o gasto 3 dias depois (série de conta limpa).
  const al = await seedAgent({ label: "temporal-lag" });
  const lagCamp = uniq("lag");
  const spendByDay = Array.from({ length: 20 }, (_, i) => 100 + ((i * 7) % 13) * 10);
  for (let i = 0; i < 20; i++) {
    const conv = i >= 3 ? spendByDay[i - 3]! / 20 : 0;
    await db.insert(insightsSnapshots).values({ orgId: al.orgId, adAccountId: al.adAccountId, entityLevel: "campaign", entityId: lagCamp, date: dateStr(-20 + i), metricsJson: metrics(spendByDay[i]!, conv) });
  }
  await service.runTick();
  ok("8.2 prior de lag de conversão (account/conversion)", (await loadLesson(al.agentId, "account:conversion:neutral:account_conversion_lag")) !== null);
}

/** 9: guard assimétrico de CONTA (puro). */
function scenarioGuard(): void {
  console.log("\n▶ Cenário 9 — guard assimétrico de conta (puro)");
  const rec = (actionType: string) => ({ id: "r1", title: "Escalar", rationale: "b", actionType, severity: "info" as const, targetEntity: { level: "campaign" as const, externalId: "cX", name: "X" } });
  const out = (t: string): AnalysisOutput => ({ scorecard: { grade: "B", headline: "h", biggestLeak: "conversao" }, summary: "s", findings: [], recommendations: [rec(t)] }) as unknown as AnalysisOutput;
  const accGuard: LessonGuard[] = [{ id: "g", key: { scope: "account", dimension: "pacing", direction: "lower" } }];
  ok("9.1 escala sob prior de CONTA lower não-confirmado → investigar", guardUnconfirmedHypothesis(out("increase_budget"), accGuard).recommendations[0]?.actionType === "investigate");
  ok("9.2 prior de conta RAISE não age (nunca libera)", guardUnconfirmedHypothesis(out("increase_budget"), [{ id: "g", key: { scope: "account", dimension: "pacing", direction: "raise" } }]).recommendations[0]?.actionType === "increase_budget");
  ok("9.3 corte (pausa) não é tocado pelo guard", guardUnconfirmedHypothesis(out("pause"), accGuard).recommendations[0]?.actionType === "pause");
  // split: prior de conta forte/confirmado vai pro PROMPT (não pro guard).
  const sel = selectLessonsForBrief([storedLesson("account:budget:lower:account_cut_pays", { confidence: 0.9, confirmedByHuman: true, origin: "our_action" }), storedLesson("account:pacing:lower:account_scale_backfires", { confidence: 0.3, confirmedByHuman: false })], 5);
  ok("9.4 prior forte → prompt; fraco → guard", sel.prompt.length === 1 && sel.guards.length === 1, { p: sel.prompt.length, g: sel.guards.length });
}

/** 10: aviso de oportunidade (puro) + dispensa (SQL). */
async function scenarioOpportunity(): Promise<void> {
  console.log("\n▶ Cenário 10 — aviso de oportunidade + dispensa");
  const op = detectGuardrailOpportunity({ clampedRaises: [{ wantedPct: 50, cappedPct: 20, currentBudgetMinor: 10000 }], hasScalePaysPrior: true, minMaterialMinor: 1000 });
  ok("10.1 oportunidade emitida (clamp + prior + material)", op?.foregoneMinor === 3000, op);
  ok("10.2 NÃO emite sem prior de escala (hard-wall do sinal)", detectGuardrailOpportunity({ clampedRaises: [{ wantedPct: 50, cappedPct: 20, currentBudgetMinor: 10000 }], hasScalePaysPrior: false, minMaterialMinor: 1000 }) === null);
  const a = await seedAgent({ label: "dismiss" });
  const until = daysFromNow(14);
  await dismissAdvisory(db, { orgId: a.orgId as OrgId, agentId: a.agentId, key: "guardrail_opportunity:maxBudgetChangePct", dismissedUntil: until });
  const [row] = await db.select({ key: advisoryDismissals.key }).from(advisoryDismissals).where(eq(advisoryDismissals.agentId, a.agentId));
  ok("10.3 dispensa gravada em advisory_dismissals", row?.key === "guardrail_opportunity:maxBudgetChangePct", row);
}

/** 11: decaimento — não-confirmada no relógio CURTO; CONFIRMADA no relógio LONGO (aposentadoria). */
async function scenarioDecay(): Promise<void> {
  console.log("\n▶ Cenário 11 — decaimento (confirmada decai no relógio LONGO)");
  const a = await seedAgent({ label: "decay" });
  await seedLesson(a, { key: "account:budget:lower:account_cut_pays", lifecycle: "stale", lastReinforcedDay: -40, confirmed: false });
  await seedLesson(a, { key: "account:pacing:lower:account_scale_backfires", lifecycle: "active", lastReinforcedDay: -20, confirmed: false });
  await seedLesson(a, { key: "account:creative:neutral:account_fatigue_timing", lifecycle: "active", lastReinforcedDay: -40, confirmed: true }); // -40 < 90 → fica
  await seedLesson(a, { key: "account:conversion:neutral:account_conversion_lag", lifecycle: "active", lastReinforcedDay: -100, confirmed: true }); // -100 > 90 → cede
  const decay = await repo.applyDecaySweep(NOW, {
    staleDays: CONFIG.decayStaleDays,
    archiveDays: CONFIG.decayArchiveDays,
    confirmedStaleDays: CONFIG.confirmedStaleDays,
    confirmedArchiveDays: CONFIG.confirmedArchiveDays,
  });
  ok("11.1 sweep arquivou ≥1 e rebaixou ≥1", decay.archived >= 1 && decay.staled >= 1, decay);
  ok("11.2 stale-antiga → archived", (await lifecycleOf(a.agentId, "account:budget:lower:account_cut_pays")) === "archived");
  ok("11.3 active-sem-reforço → stale", (await lifecycleOf(a.agentId, "account:pacing:lower:account_scale_backfires")) === "stale");
  ok("11.4 confirmada RECENTE (< relógio longo) → PERMANECE active", (await lifecycleOf(a.agentId, "account:creative:neutral:account_fatigue_timing")) === "active");
  ok("11.5 confirmada VELHA (> relógio longo) → stale (aposentadoria por evidência)", (await lifecycleOf(a.agentId, "account:conversion:neutral:account_conversion_lag")) === "stale");
}

/** 12: isolamento por org. */
async function scenarioOrgIsolation(): Promise<void> {
  console.log("\n▶ Cenário 12 — isolamento por org");
  const a1 = await seedAgent({ label: "org-A" });
  const a2 = await seedAgent({ label: "org-B" });
  for (const a of [a1, a2]) for (const c of [uniq("c"), uniq("c"), uniq("c")]) await seedOurCutWorked(a, c);
  await service.runTick();
  const l1 = await loadLesson(a1.agentId, "account:budget:lower:account_cut_pays");
  const l2 = await loadLesson(a2.agentId, "account:budget:lower:account_cut_pays");
  ok("12.1 cada org tem seu próprio prior", !!l1 && !!l2 && l1.id !== l2.id);
  ok("12.2 prior da org A é da org A", l1?.orgId === a1.orgId);
  const orgALessons = await repo.loadActiveLessons(a1.orgId as OrgId as unknown as string, a1.agentId);
  ok("12.3 leitura org-scoped(A) não enxerga a linha de B", orgALessons.every((l) => l.id !== l2?.id));
}

/** 13: kill-switch + dormância (fora do listLearnableAgents). */
async function scenarioKillSwitch(): Promise<void> {
  console.log("\n▶ Cenário 13 — kill-switch + dormância");
  const off = await seedAgent({ label: "learning-off", learningDisabled: true });
  const dorm = await seedAgent({ label: "dormant", dormant: true });
  const on = await seedAgent({ label: "learning-on" });
  const learnable = await repo.listLearnableAgents();
  ok("13.1 agente com learning.enabled=false FORA do loop", learnable.every((x) => x.agentId !== off.agentId));
  ok("13.2 conta dormante FORA do loop", learnable.every((x) => x.agentId !== dorm.agentId));
  ok("13.3 agente normal DENTRO do loop", learnable.some((x) => x.agentId === on.agentId));
}

/** 14 (Fase 2): N por padrão — dois aprendizados de CRIATIVO com padrões DIFERENTES coexistem
 *  (a chave inclui o padrão → não colidem numa vaga só; o índice único aceita ambos). */
async function scenarioNPerPattern(): Promise<void> {
  console.log("\n▶ Cenário 14 — N por padrão (chave inclui o padrão)");
  const a = await seedAgent({ label: "n-per-pattern" });
  await seedLesson(a, { key: "account:creative:neutral:account_fatigue_timing", lifecycle: "active", lastReinforcedDay: -1, confirmed: false });
  await seedLesson(a, { key: "account:creative:neutral:weak_hook", lifecycle: "active", lastReinforcedDay: -1, confirmed: false });
  const lessons = await repo.loadActiveLessons(a.orgId as OrgId as unknown as string, a.agentId);
  const creative = lessons.filter((l) => l.key.dimension === "creative");
  ok("14.1 dois padrões de criativo COEXISTEM (mesma dim/dir, N por dimensão)", creative.length === 2, creative.map((l) => l.key.pattern));
  ok("14.2 os padrões são distintos na chave", new Set(creative.map((l) => l.key.pattern)).size === 2);
}

// ─── util ─────────────────────────────────────────────────────────────────

async function qualityOf(agentId: string): Promise<Record<string, unknown> | undefined> {
  const [row] = await db.select({ mc: agents.modelConfig }).from(agents).where(eq(agents.id, agentId)).limit(1);
  return (row?.mc as { quality?: Record<string, unknown> } | null)?.quality;
}
async function guardrailSnapshot(agentId: string): Promise<unknown> {
  const [row] = await db.select({ pct: guardrailConfigs.maxBudgetChangePct, ent: guardrailConfigs.maxEntitiesPerDay, dry: guardrailConfigs.dryRun, kill: guardrailConfigs.killSwitch }).from(guardrailConfigs).where(eq(guardrailConfigs.agentId, agentId)).limit(1);
  return row ?? null;
}
async function autonomySnapshot(agentId: string): Promise<unknown> {
  const [row] = await db.select({ ap: agents.autonomyPolicy }).from(agents).where(eq(agents.id, agentId)).limit(1);
  return row?.ap ?? null;
}
const deepEq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

// ─── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("E2E determinístico do aprendizado contínuo v3 (LLM stubado, Postgres real)\n");
  await scenarioTracking();
  await scenarioAccountPrior();
  await scenarioThresholdHardWall();
  await scenarioManual();
  await scenarioTemporal();
  scenarioGuard();
  await scenarioOpportunity();
  await scenarioDecay();
  await scenarioOrgIsolation();
  await scenarioKillSwitch();
  await scenarioNPerPattern();

  console.log(`\n─────────────────────────────\nRESULTADO: ${pass} ok · ${fail} falhas`);
  if (fail > 0) process.exit(1);
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error("e2e-learning falhou:", err);
    process.exit(1);
  });

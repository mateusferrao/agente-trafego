/**
 * E2E DETERMINÍSTICO do aprendizado contínuo (S1–S7) — SEM LLM real.
 *
 * Roda o loop de aprendizado ponta-a-ponta contra um POSTGRES REAL (dockerizado), com o
 * redator LLM STUBADO (saída fixa) e um relógio FIXO (`NOW`). Cobre o que os testes de
 * unidade (fakes) não cobrem: o SQL REAL — org-scoping, índice único parcial (dedup),
 * transação de outcome, sweep de decaimento, pareamento de config-snapshot, agregação de
 * janela, idempotência do `measured_at` — e o fio completo do `runTick`.
 *
 * Cenários (estressa todos os caminhos, cada um assertado no BANCO):
 *   1. Observacional: conta SÓ-análise (nenhuma ação aplicada) aprende padrão de zumbi recorrente.
 *   2. Dedup + reforço: re-tick na MESMA janela não reforça; run novo reforça (confiança sobe, ≤ teto).
 *   3. Outcome de AÇÃO NOSSA (pausa): mede a conta → recommendation_feedback + calibração; idempotente.
 *   4. Mudança MANUAL do gestor: config-snapshot (sem ação nossa) → lição fact/human_manual.
 *   5. Decaimento: sem reforço → active→stale→archived; lição CONFIRMADA nunca decai.
 *   6. Guard assimétrico: hipótese não-confirmada rebaixa escala→investigar; nunca libera.
 *   7. Top-K + split: confirmadas→prompt, resto→guards; teto respeitado.
 *   8. Isolamento por org: 2 orgs com a MESMA campanha → 2 lições separadas, sem vazamento cross-tenant.
 *   9. Exclusão de dormante: conta dormante não gera lição (fora do listLearnableAgents).
 *
 * Rodar: `apps/worker/e2e-learning.sh` (sobe docker, migra, executa este script, derruba).
 * Ou manual: exporte DATABASE_URL para um Postgres migrado e rode
 *   `cd apps/worker && npx tsx e2e-learning.ts`
 */
import { and, eq, sql } from "drizzle-orm";
import {
  adAccounts,
  agentMemory,
  agentRuns,
  agentToolCalls,
  agents,
  createDb,
  entityConfigSnapshots,
  insightsSnapshots,
  orgs,
  platformConnections,
  recommendationFeedback,
  recommendations,
} from "@trafego/db";
import type { Action, EncryptedPayload, InsightMetrics, StoredInsightMetrics } from "@trafego/shared";
import type { LLMProviderPort } from "@trafego/shared/ports";
import {
  confidenceTier,
  guardUnconfirmedHypothesis,
  selectLessonsForBrief,
  type LessonGuard,
  type StoredLesson,
} from "@trafego/core";
import { pino } from "pino";
import { createLearningRepo } from "./src/modules/learning/repo.js";
import { createOutcomeRepo } from "./src/modules/learning/outcome-repo.js";
import { createLearningService, type LearningServiceConfig } from "./src/modules/learning/service.js";

// ─── infra de teste ────────────────────────────────────────────────────────

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL não definida — rode via e2e-learning.sh (sobe o Postgres dockerizado).");
  process.exit(1);
}
const db = createDb(DATABASE_URL);
const logger = pino({ level: "silent" });

/** Relógio FIXO — todo o cenário é datado em relação a ele (determinismo total). */
const NOW = new Date("2026-09-02T12:00:00.000Z");
const REDACTOR_STUB_TEXT = "Padrão observado nesta conta (stub determinístico do redator).";

/** LLM stubado: o redator devolve texto fixo, custo zero. Nunca vai à rede. */
const stubLlm = {
  async complete() {
    return { output: REDACTOR_STUB_TEXT, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, cost: 0 };
  },
} as unknown as LLMProviderPort;

/** Janelas pequenas p/ o cenário fechar dentro de datas próximas ao NOW. */
const CONFIG: LearningServiceConfig = {
  historyRuns: 20,
  minRuns: 3,
  minOccurrenceRatio: 0.5,
  redactorModel: "stub-model",
  redactorMaxPerTick: 100,
  decayStaleDays: 14,
  decayArchiveDays: 30,
  phaseBufferDays: 1,
  outcomeWindowDays: 7,
};

const repo = createLearningRepo(db);
const outcomeRepo = createOutcomeRepo(db);
const service = createLearningService({ repo, outcomeRepo, llm: stubLlm, logger, config: CONFIG, now: () => NOW });

// ─── helpers de asserção ─────────────────────────────────────────────────────

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    pass += 1;
    console.log(`  ✅ ${name}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${name}`, detail !== undefined ? JSON.stringify(detail).slice(0, 300) : "");
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Data (Date) a N dias do NOW (negativo = passado). */
function daysFromNow(n: number): Date {
  return new Date(NOW.getTime() + n * DAY_MS);
}
/** YYYY-MM-DD a N dias do NOW. */
function dateStr(n: number): string {
  return daysFromNow(n).toISOString().slice(0, 10);
}

const FAKE_TOKEN: EncryptedPayload = { ciphertext: "x", iv: "y", tag: "z", keyVersion: 1 };

// ─── seeding ─────────────────────────────────────────────────────────────────

let seq = 0;
const uniq = (p: string) => `${p}-${Date.now()}-${seq++}`;

interface SeededAgent {
  readonly orgId: string;
  readonly agentId: string;
  readonly adAccountId: string;
  readonly externalAccountId: string;
}

/** Cria org + conexão + conta + agente ATIVO (ou dormante). Retorna ids. */
async function seedAgent(opts: { dormant?: boolean; label: string }): Promise<SeededAgent> {
  const [org] = await db.insert(orgs).values({ name: opts.label, slug: uniq("slug") }).returning({ id: orgs.id });
  const orgId = org!.id;
  const [conn] = await db
    .insert(platformConnections)
    .values({ orgId, platform: "meta", tokenCripto: FAKE_TOKEN, tokenStatus: "valid" })
    .returning({ id: platformConnections.id });
  const externalAccountId = uniq("act");
  const [acc] = await db
    .insert(adAccounts)
    .values({
      orgId,
      connectionId: conn!.id,
      adAccountId: externalAccountId,
      name: opts.label,
      currency: "BRL",
      status: "active",
      activityState: opts.dormant ? "dormant" : "active",
      tokenCripto: FAKE_TOKEN,
      tokenStatus: "valid",
    })
    .returning({ id: adAccounts.id });
  const adAccountId = acc!.id;
  const [agent] = await db
    .insert(agents)
    .values({ orgId, adAccountId, archetype: "otimizador", status: "active", autonomyPolicy: {} as never })
    .returning({ id: agents.id });
  return { orgId, agentId: agent!.id, adAccountId, externalAccountId };
}

/** Run bem-sucedido com um metrics_snapshot (zumbis/campanhas) datado a `dayOffset`. */
async function seedRun(a: SeededAgent, dayOffset: number, snapshot: Record<string, unknown>): Promise<string> {
  const at = daysFromNow(dayOffset);
  const [run] = await db
    .insert(agentRuns)
    .values({
      orgId: a.orgId,
      agentId: a.agentId,
      trigger: "cron",
      status: "succeeded",
      metricsSnapshot: snapshot,
      createdAt: at,
      updatedAt: at,
    })
    .returning({ id: agentRuns.id });
  return run!.id;
}

/** metrics_snapshot marcando 1 campanha como ZUMBI (via waste.zombies). */
function zombieSnapshot(campaignId: string, name: string): Record<string, unknown> {
  return {
    waste: { totalSpend: 1000, wastedSpend: 500, wastedPct: 50, zombies: [{ id: campaignId, name, spend: 500 }] },
  };
}

function metrics(spend: number, conversions: number): StoredInsightMetrics {
  const m: InsightMetrics = {
    spend,
    impressions: 10000,
    clicks: 200,
    ctr: 2,
    cpc: spend / 200,
    cpm: spend / 10,
    conversions,
  };
  return { metrics: m };
}

/** Insere snapshots diários de insight (nível campanha) num intervalo [fromDay, toDay]. */
async function seedInsights(
  a: SeededAgent,
  entityId: string,
  fromDay: number,
  toDay: number,
  perDay: StoredInsightMetrics,
): Promise<void> {
  for (let d = fromDay; d <= toDay; d++) {
    await db.insert(insightsSnapshots).values({
      orgId: a.orgId,
      adAccountId: a.adAccountId,
      entityLevel: "campaign",
      entityId,
      date: dateStr(d),
      metricsJson: perDay,
    });
  }
}

// ─── cenários ─────────────────────────────────────────────────────────────────

/** 1+2: observacional (conta só-análise) + dedup/reforço. */
async function scenarioObservational(): Promise<void> {
  console.log("\n▶ Cenário 1+2 — observacional (só-análise) + dedup/reforço");
  const a = await seedAgent({ label: "obs-conta" });
  const c1 = uniq("camp");
  // 4 runs, todos marcando c1 como zumbi (4/4 ≥ 0.5).
  for (const off of [-40, -30, -20, -10]) await seedRun(a, off, zombieSnapshot(c1, "Campanha Parada"));

  const r1 = await service.runTick();
  ok("1.1 destilou ≥1 lição observacional", r1.created >= 1, r1);
  const lesson = await loadLesson(a.agentId, `entity:budget:lower:${c1}`);
  ok("1.2 lição fact criada (type=fact)", lesson?.type === "fact", lesson);
  ok("1.3 origem observacional", lesson?.origin === "observational", lesson?.origin);
  ok("1.4 confiança ≤ teto observacional (0.6)", (lesson?.confidence ?? 1) <= 0.6, lesson?.confidence);
  ok("1.5 conteúdo = saída do redator stub", lesson?.content === REDACTOR_STUB_TEXT, lesson?.content);
  ok("1.6 tier rotulado = explorando (não confirmada, baixa)", confidenceTier(lesson?.confidence ?? 0, false) === "explorando", confidenceTier(lesson?.confidence ?? 0, false));

  // 2: re-tick SEM run novo → NÃO reforça (dedup por evidenceAt).
  const before = lesson;
  const r2 = await service.runTick();
  const after = await loadLesson(a.agentId, `entity:budget:lower:${c1}`);
  ok("2.1 re-tick sem run novo NÃO reforça (dedup)", r2.reinforced === 0 && after?.reinforceCount === before?.reinforceCount, { r2, before: before?.reinforceCount, after: after?.reinforceCount });

  // run NOVO (mais recente) com o mesmo padrão → reforça (confiança sobe, ≤ teto).
  await seedRun(a, -2, zombieSnapshot(c1, "Campanha Parada"));
  const r3 = await service.runTick();
  const reinforced = await loadLesson(a.agentId, `entity:budget:lower:${c1}`);
  ok("2.2 run novo reforça", r3.reinforced >= 1 && (reinforced?.reinforceCount ?? 0) > (after?.reinforceCount ?? 0), r3);
  ok("2.3 reforço sobe a confiança mas respeita o teto (≤0.6)", (reinforced?.confidence ?? 0) >= (after?.confidence ?? 0) && (reinforced?.confidence ?? 1) <= 0.6, reinforced?.confidence);
}

/** 3: outcome de ação NOSSA (pausa) + idempotência. */
async function scenarioOurAction(): Promise<void> {
  console.log("\n▶ Cenário 3 — outcome de ação nossa (pausa) + idempotência");
  const a = await seedAgent({ label: "acao-conta" });
  const c3 = uniq("camp");
  const runId = await seedRun(a, -10, { campaigns: [] });
  const action: Action = { id: uniq("a"), type: "pause_entity", target: { level: "campaign", id: c3, name: "Campanha Cara" }, source: "llm", riskLevel: "medium", reason: "cpa alto" };
  const [rec] = await db
    .insert(recommendations)
    .values({ orgId: a.orgId, runId, title: "Pausar Campanha Cara", kind: "platform_action", proposedAction: action, createdAt: daysFromNow(-10), updatedAt: daysFromNow(-10) })
    .returning({ id: recommendations.id });
  const recId = rec!.id;
  // ação REALMENTE aplicada por nós (before_state, não dry-run) no instante da pausa (-10).
  await db.insert(agentToolCalls).values({
    agentId: a.agentId,
    runId,
    toolKey: "pause_entity",
    idempotencyKey: uniq("idem"),
    args: { target: { id: c3 }, dryRun: false },
    beforeState: { status: "ACTIVE" },
    createdAt: daysFromNow(-10),
    updatedAt: daysFromNow(-10),
  });
  // conta (soma das campanhas): CPA melhora MUITO pós-pausa (200 → 50, delta -0.75 < -0.4).
  await seedInsights(a, uniq("other"), -17, -11, metrics(1000, 5)); // pré: cpa 200
  await seedInsights(a, uniq("other2"), -9, -3, metrics(1000, 20)); // pós: cpa 50

  const r = await service.runTick();
  ok("3.1 mediu 1 outcome", r.measured >= 1, r);
  const [fb] = await db.select().from(recommendationFeedback).where(eq(recommendationFeedback.recommendationId, recId));
  ok("3.2 recommendation_feedback gravado com measured_at", !!fb && fb.measuredAt !== null, fb);
  ok("3.3 outcome positivo (pausa liberou verba p/ melhor CPA de conta)", fb?.outcome === "positive", fb?.outcome);
  const calib = await loadLesson(a.agentId, `entity:budget:lower:${c3}`);
  ok("3.4 lição de calibração criada (cortar aqui ajudou)", calib?.type === "past_action" && calib?.origin === "our_action", calib);
  // calibração nasce de UMA medição (base null → medida): confiança inicial ~0.425 (abaixo do
  // teto observacional 0.6, mas com atribuição FORTE our_action — só ela pode subir além de 0.6
  // com novas medições, ao contrário da observacional que satura em 0.6). O ponto: origem medida.
  ok("3.5 calibração tem origem medida (our_action, atribuição forte)", calib?.origin === "our_action" && (calib?.confidence ?? 0) > 0.4 && (calib?.confidence ?? 1) < 0.6, calib?.confidence);

  // idempotência: 2º tick NÃO cria 2ª linha de feedback (guard measured_at).
  await service.runTick();
  const fbAll = await db.select({ id: recommendationFeedback.id }).from(recommendationFeedback).where(eq(recommendationFeedback.recommendationId, recId));
  ok("3.6 idempotente — só 1 linha de feedback após 2º tick", fbAll.length === 1, fbAll.length);
}

/** 4: mudança MANUAL do gestor via config-snapshot (sem ação nossa). */
async function scenarioManualChange(): Promise<void> {
  console.log("\n▶ Cenário 4 — mudança manual do gestor (config-snapshot)");
  const a = await seedAgent({ label: "manual-conta" });
  const c4 = uniq("camp");
  // config-snapshots: prev (-11) budget 10000 → curr (-10) budget 5000 (−50% = corte). Sem ação nossa.
  await db.insert(entityConfigSnapshots).values({ orgId: a.orgId, adAccountId: a.adAccountId, entityLevel: "campaign", entityId: c4, date: dateStr(-11), configJson: { status: "active", dailyBudgetMinor: 10000 } });
  await db.insert(entityConfigSnapshots).values({ orgId: a.orgId, adAccountId: a.adAccountId, entityLevel: "campaign", entityId: c4, date: dateStr(-10), configJson: { status: "active", dailyBudgetMinor: 5000 } });
  // entidade: CPA melhora pós-corte (o corte do gestor "deu certo").
  await seedInsights(a, c4, -17, -11, metrics(600, 3)); // pré: cpa 200
  await seedInsights(a, c4, -9, -3, metrics(300, 6)); // pós: cpa 50

  const r = await service.runTick();
  ok("4.1 aprendeu ≥1 mudança manual", r.manualLearned >= 1, r);
  const lesson = await loadLesson(a.agentId, `entity:budget:lower:${c4}`);
  ok("4.2 lição fact atribuída ao gestor (origin=human_manual)", lesson?.type === "fact" && lesson?.origin === "human_manual", lesson);
  ok("4.3 confiança observacional (atribuição fraca, ≤0.6)", (lesson?.confidence ?? 1) <= 0.6, lesson?.confidence);
}

/** 5: decaimento (active→stale→archived) + confirmada nunca decai. */
async function scenarioDecay(): Promise<void> {
  console.log("\n▶ Cenário 5 — decaimento + confirmada nunca decai");
  const a = await seedAgent({ label: "decay-conta" });
  // L1 não-confirmada, reforço há 40d, JÁ stale → deve ARQUIVAR.
  await seedLesson(a, { key: "entity:budget:lower:d-stale", lifecycle: "stale", lastReinforcedDay: -40, confirmed: false });
  // L2 não-confirmada, reforço há 20d, active → deve virar STALE.
  await seedLesson(a, { key: "entity:pacing:lower:d-active", lifecycle: "active", lastReinforcedDay: -20, confirmed: false });
  // L3 CONFIRMADA, reforço há 40d, active → NUNCA decai.
  await seedLesson(a, { key: "entity:creative:lower:d-confirmed", lifecycle: "active", lastReinforcedDay: -40, confirmed: true });

  const decay = await repo.applyDecaySweep(NOW, { staleDays: CONFIG.decayStaleDays, archiveDays: CONFIG.decayArchiveDays });
  ok("5.1 sweep arquivou ≥1 e rebaixou ≥1", decay.archived >= 1 && decay.staled >= 1, decay);
  ok("5.2 L1 stale-antiga → archived", (await lifecycleOf(a.agentId, "entity:budget:lower:d-stale")) === "archived");
  ok("5.3 L2 active-sem-reforço → stale", (await lifecycleOf(a.agentId, "entity:pacing:lower:d-active")) === "stale");
  ok("5.4 L3 confirmada → PERMANECE active", (await lifecycleOf(a.agentId, "entity:creative:lower:d-confirmed")) === "active");
}

/** 6+7: guard assimétrico (puro) + top-K/split. */
async function scenarioGuardAndSelect(): Promise<void> {
  console.log("\n▶ Cenário 6+7 — guard assimétrico + top-K/split");
  const c = "guard-camp";
  const guards: LessonGuard[] = [{ id: "g1", key: { scope: "entity", dimension: "budget", direction: "lower", subjectId: c } }];
  const buildOutput = (actionType: string) =>
    ({
      scorecard: { grade: "B", headline: "h", biggestLeak: "conversao" },
      summary: "s",
      findings: [],
      recommendations: [{ id: "r1", title: "Escalar campanha", rationale: "base", actionType, severity: "info", targetEntity: { level: "campaign", externalId: c, name: "X" } }],
    }) as never;

  // rec que AUMENTA risco (escalar orçamento) na entidade sob hipótese não-confirmada → rebaixa.
  const scaleOut = guardUnconfirmedHypothesis(buildOutput("increase_budget"), guards);
  const scaled = (scaleOut.recommendations as { actionType?: string }[])[0];
  ok("6.1 escala sob hipótese não-confirmada → rebaixada p/ investigar", scaled?.actionType === "investigate", scaled);

  // rec que DIMINUI risco (pausar) NÃO é rebaixada (o guard nunca "libera" nem mexe em corte).
  const pauseOut = guardUnconfirmedHypothesis(buildOutput("pause"), guards);
  const paused = (pauseOut.recommendations as { actionType?: string }[])[0];
  ok("6.2 corte (pausar) NÃO é tocado pelo guard", paused?.actionType === "pause", paused);

  // 7: split — confirmadas (ou ≥ limiar) vão p/ prompt (com teto top-K); não-confirmadas
  // de baixa confiança vão p/ guards (influência silenciosa). 3 confirmadas + topK 2 → capa
  // o prompt em 2; a não-confirmada baixa cai em guards.
  const lessons: StoredLesson[] = [
    storedLesson("entity:budget:lower:s1", { confidence: 0.95, confirmedByHuman: true }),
    storedLesson("entity:pacing:lower:s2", { confidence: 0.9, confirmedByHuman: true }),
    storedLesson("entity:creative:lower:s3", { confidence: 0.92, confirmedByHuman: true }),
    storedLesson("entity:audience:lower:s4", { confidence: 0.5, confirmedByHuman: false }),
  ];
  const sel = selectLessonsForBrief(lessons, 2);
  ok("7.1 só confirmadas/altas entram no prompt (tier confirmado)", sel.prompt.length > 0 && sel.prompt.every((l) => l.tier === "confirmado"), sel.prompt.map((l) => l.tier));
  ok("7.2 não-confirmada baixa vai p/ guards (silenciosa), não prompt", sel.guards.length === 1 && sel.guards[0]?.id === "entity:audience:lower:s4", sel.guards.map((g) => g.id));
  ok("7.3 teto top-K capa o prompt (3 elegíveis, topK=2 → 2)", sel.prompt.length === 2, sel.prompt.length);
}

/** 8: isolamento por org — mesma campanha em 2 orgs → 2 lições separadas, sem vazamento. */
async function scenarioOrgIsolation(): Promise<void> {
  console.log("\n▶ Cenário 8 — isolamento por org (sem vazamento cross-tenant)");
  const sharedCampaign = uniq("shared-camp");
  const a1 = await seedAgent({ label: "org-A" });
  const a2 = await seedAgent({ label: "org-B" });
  for (const off of [-40, -30, -20]) {
    await seedRun(a1, off, zombieSnapshot(sharedCampaign, "Loja A"));
    await seedRun(a2, off, zombieSnapshot(sharedCampaign, "Loja B"));
  }
  await service.runTick();
  const key = `entity:budget:lower:${sharedCampaign}`;
  const l1 = await loadLesson(a1.agentId, key);
  const l2 = await loadLesson(a2.agentId, key);
  ok("8.1 cada org tem sua própria lição", !!l1 && !!l2 && l1.id !== l2.id, { l1: l1?.id, l2: l2?.id });
  ok("8.2 lição da org A é da org A (orgId correto)", l1?.orgId === a1.orgId, { got: l1?.orgId, want: a1.orgId });
  ok("8.3 lição da org B é da org B (orgId correto)", l2?.orgId === a2.orgId, { got: l2?.orgId, want: a2.orgId });
  // a leitura org-scoped da org A NÃO enxerga a linha da org B.
  const orgALessons = await repo.loadActiveLessons(a1.orgId, a1.agentId);
  ok("8.4 loadActiveLessons(orgA) não retorna nada da orgB", orgALessons.every((l) => l.id !== l2?.id), orgALessons.length);
}

/** 9: conta dormante não gera lição (fora do listLearnableAgents). */
async function scenarioDormant(): Promise<void> {
  console.log("\n▶ Cenário 9 — conta dormante não aprende");
  const a = await seedAgent({ label: "dormant-conta", dormant: true });
  const cd = uniq("camp");
  for (const off of [-40, -30, -20, -10]) await seedRun(a, off, zombieSnapshot(cd, "Parada Dormente"));
  await service.runTick();
  const lesson = await loadLesson(a.agentId, `entity:budget:lower:${cd}`);
  ok("9.1 conta dormante NÃO gerou lição", lesson === null, lesson);
  const learnable = await repo.listLearnableAgents();
  ok("9.2 agente dormante fora do listLearnableAgents", learnable.every((x) => x.agentId !== a.agentId), learnable.length);
}

// ─── util de leitura ──────────────────────────────────────────────────────────

interface LessonRow {
  readonly id: string;
  readonly orgId: string;
  readonly type: string;
  readonly content: string;
  readonly confidence: number | null;
  readonly origin: string;
  readonly reinforceCount: number;
  readonly lifecycle: string;
}
async function loadLesson(agentId: string, semanticKey: string): Promise<LessonRow | null> {
  const [row] = await db
    .select({ id: agentMemory.id, orgId: agentMemory.orgId, type: agentMemory.type, content: agentMemory.content, confidence: agentMemory.confidence, origin: agentMemory.origin, reinforceCount: agentMemory.reinforceCount, lifecycle: agentMemory.lifecycle })
    .from(agentMemory)
    .where(and(eq(agentMemory.agentId, agentId), eq(agentMemory.semanticKey, semanticKey), sql`${agentMemory.lifecycle} <> 'archived'`))
    .limit(1);
  return row ?? null;
}
async function lifecycleOf(agentId: string, semanticKey: string): Promise<string | null> {
  const [row] = await db.select({ lifecycle: agentMemory.lifecycle }).from(agentMemory).where(and(eq(agentMemory.agentId, agentId), eq(agentMemory.semanticKey, semanticKey))).limit(1);
  return row?.lifecycle ?? null;
}

/** Semeia uma lição diretamente (p/ testar decaimento). */
async function seedLesson(
  a: SeededAgent,
  o: { key: string; lifecycle: "active" | "stale" | "archived"; lastReinforcedDay: number; confirmed: boolean },
): Promise<void> {
  const [scope, dimension, direction] = o.key.split(":");
  await db.insert(agentMemory).values({
    orgId: a.orgId,
    agentId: a.agentId,
    type: "fact",
    content: "lição semeada p/ decaimento",
    confidence: 0.5,
    lifecycle: o.lifecycle,
    scope: scope as never,
    dimension: dimension as never,
    direction: direction as never,
    origin: "observational",
    semanticKey: o.key,
    confirmedByHuman: o.confirmed,
    reinforceCount: 1,
    lastReinforcedAt: daysFromNow(o.lastReinforcedDay),
  });
}

/** StoredLesson em memória (p/ selectLessonsForBrief, sem tocar o banco). */
function storedLesson(key: string, o: { confidence: number; confirmedByHuman: boolean }): StoredLesson {
  const [scope, dimension, direction, subjectId] = key.split(":");
  return {
    id: key,
    kind: "fact",
    key: { scope: scope as never, dimension: dimension as never, direction: direction as never, ...(subjectId ? { subjectId } : {}) },
    content: "l",
    confidence: o.confidence,
    confirmedByHuman: o.confirmedByHuman,
    origin: "observational",
    lifecycle: "active",
    reinforceCount: 1,
  };
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("E2E determinístico do aprendizado contínuo (LLM stubado, Postgres real)\n");
  await scenarioObservational();
  await scenarioOurAction();
  await scenarioManualChange();
  await scenarioDecay();
  await scenarioGuardAndSelect();
  await scenarioOrgIsolation();
  await scenarioDormant();

  console.log(`\n─────────────────────────────\nRESULTADO: ${pass} ok · ${fail} falhas`);
  if (fail > 0) process.exit(1);
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error("e2e-learning falhou:", err);
    process.exit(1);
  });

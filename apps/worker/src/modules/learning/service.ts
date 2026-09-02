// Serviço de aprendizado (S1): destila lições observacionais do histórico de análise.
// Fluxo por agente: lê o histórico por-run → `detectFactCandidates` (core, puro) →
// para cada candidata: se já existe (mesma chave) REFORÇA a confiança; se é nova, monta o texto
// DETERMINÍSTICO (`fallbackLessonText`, na voz do Roy — sem LLM) e persiste. O v3 não usa mais
// redator LLM aqui (lição estruturada → template cobre tudo, sem risco de inverter/alucinar).

import {
  classifyOutcomeEvidence,
  computeConfidence,
  computeOutcome,
  describeLessonForRedactor,
  detectConversionLagPrior,
  detectFactCandidates,
  detectFatigueTimingPrior,
  distillAccountPriors,
  fallbackLessonText,
  lessonKeyOf,
  manualChangeToAction,
  proposalForCalibration,
  THRESHOLD_PROPOSAL_CONFIDENCE,
  type AccountEvidenceEntry,
  type LessonCandidate,
  type MeasuredOutcome,
  type OutcomeWindow,
} from "@trafego/core";
import type { Logger } from "pino";
import type { LearnableAgent, LearningRepo } from "./repo.js";
import type { LearningEvidenceInsert, MeasurableRec, OutcomeRepo } from "./outcome-repo.js";

export interface LearningServiceConfig {
  readonly historyRuns: number;
  readonly minRuns: number;
  readonly minOccurrenceRatio: number;
  /** teto de CRIAÇÃO de lições por tick (throttle a rajadas). */
  readonly maxNewLessonsPerTick: number;
  /** decaimento (curadoria): dias sem reforço p/ stale → archived. */
  readonly decayStaleDays: number;
  readonly decayArchiveDays: number;
  /** medição de outcome (Sinal A): buffer da learning phase + janela de medição. */
  readonly phaseBufferDays: number;
  readonly outcomeWindowDays: number;
  /** mínimo de entidades DISTINTAS p/ nascer um prior de conta (destilação cross-seccional). */
  readonly accountMinEntities: number;
  /** janela (dias) da série de insights lida pelos detectores temporais (fadiga/lag). */
  readonly temporalLookbackDays: number;
}

/** Um aprendizado NOVO nascido no tick — a casca decide se/como avisar no WhatsApp (F4/v3). */
export interface NewLearningEvent {
  readonly kind: "prior" | "proposal";
  readonly content: string;
}

export interface LearningServiceDeps {
  readonly repo: LearningRepo;
  readonly outcomeRepo: OutcomeRepo;
  readonly logger: Logger;
  readonly config: LearningServiceConfig;
  /** relógio injetável (testes determinísticos). Default = Date.now. */
  readonly now?: () => Date;
  /** avisa a casca que nasceu um aprendizado novo (alerta WhatsApp gated por notify_policy). */
  readonly onNewLearning?: (agent: LearnableAgent, event: NewLearningEvent) => Promise<void>;
}

export interface DistillResult {
  readonly created: number;
  readonly reinforced: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * DAY_MS);
}
function dateStr(d: Date): string {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

export function createLearningService(deps: LearningServiceDeps) {
  const { repo, outcomeRepo, logger, config } = deps;
  const clock = deps.now ?? (() => new Date());

  /** Dispara o alerta de aprendizado novo (best-effort — falha de aviso nunca derruba o tick). */
  async function alertNew(agent: LearnableAgent, event: NewLearningEvent): Promise<void> {
    if (!deps.onNewLearning) return;
    try {
      await deps.onNewLearning(agent, event);
    } catch (err) {
      logger.warn({ err, agentId: agent.agentId }, "learning:alerta de aprendizado falhou");
    }
  }

  /** Destila lições observacionais de UM agente. Retorna quantas criou/reforçou. */
  async function distillAgent(agent: LearnableAgent, createBudget: { remaining: number }): Promise<DistillResult> {
    const runs = await repo.loadRunHistory(agent.orgId, agent.agentId, config.historyRuns);
    const candidates = detectFactCandidates({
      runs,
      config: { minRuns: config.minRuns, minOccurrenceRatio: config.minOccurrenceRatio },
    });
    // run mais novo da janela = a evidência de corte. Se uma lição já foi reforçada até
    // aqui, um novo tick sobre a MESMA janela (sem run novo) NÃO reforça de novo (dedup
    // — senão o cron diário inflaria reinforceCount/confiança a partir da mesma evidência).
    const newestRun = runs.at(-1);
    const evidenceAt = newestRun ? new Date(newestRun.at) : new Date();
    let created = 0;
    let reinforced = 0;
    for (const candidate of candidates) {
      const key = lessonKeyOf(candidate.key);
      const existing = await repo.findLessonByKey(agent.orgId, agent.agentId, key);
      if (existing) {
        // já incorporamos evidência até este run (ou mais nova)? então não há o que reforçar.
        if (existing.lastReinforcedAt && existing.lastReinforcedAt.getTime() >= evidenceAt.getTime()) {
          continue;
        }
        const next = computeConfidence(existing.confidence, {
          type: "observe",
          occurrenceRatio: occurrenceRatioOf(candidate),
          origin: candidate.origin,
        });
        await repo.reinforceLesson(agent.orgId, agent.agentId, existing.id, next, evidenceAt);
        reinforced += 1;
        continue;
      }
      // lição NOVA precisa de texto legível (redator). Sem orçamento de redator neste tick,
      // ADIA a criação (o padrão persiste → vira candidata no próximo tick com orçamento) em
      // vez de gravar texto genérico permanente. O fallback determinístico vale só p/ FALHA
      // do LLM (dentro do redator), não p/ orçamento esgotado.
      if (createBudget.remaining <= 0) continue;
      const content = composeLessonText(candidate, createBudget);
      await repo.insertLesson({
        orgId: agent.orgId,
        agentId: agent.agentId,
        candidate,
        content,
        evidenceAt,
        ...(newestRun ? { sourceRunId: newestRun.runId } : {}),
      });
      created += 1;
    }
    return { created, reinforced };
  }

  /**
   * Texto da lição — DETERMINÍSTICO, na voz do Roy (`fallbackLessonText`), sem LLM. O v3 largou
   * o redator LLM aqui: a lição é estruturada, o template cobre tudo e não há risco de inverter/
   * alucinar (achado F2). Consome 1 do orçamento de CRIAÇÃO por tick (throttle `maxNewLessonsPerTick`).
   */
  function composeLessonText(candidate: LessonCandidate, budget: { remaining: number }): string {
    budget.remaining -= 1;
    return fallbackLessonText(describeLessonForRedactor(candidate));
  }

  /**
   * Mede o outcome das ações NOSSAS de um agente (Sinal A) → grava recommendation_feedback
   * + lição de calibração / contradição. Só recomendações com ação de plataforma aplicada
   * (before_state) cuja janela madurou (buffer da learning phase + janela), e ainda dentro
   * da graça (não re-varre recs antigas). Redação da lição respeita o teto por tick.
   */
  async function measureOutcomes(agent: LearnableAgent): Promise<{ measured: number }> {
    const buffer = config.phaseBufferDays;
    const window = config.outcomeWindowDays;
    const today = clock();
    // rec madura = criada há >= buffer+window (a janela pós-ação já fechou); graça = +1 janela.
    const notAfter = addDays(today, -(buffer + window));
    // graça de +1 janela no limite inferior cobre o atraso entre criar a rec e aplicar a ação
    // (aprovação expira em 24h → atraso « janela); a maturidade real é re-checada por appliedAt.
    const notBefore = addDays(today, -(buffer + window + window));
    const recs = await outcomeRepo.loadMeasurableRecs(agent.orgId, agent.agentId, notBefore, notAfter);
    let measured = 0;
    for (const rec of recs) {
      try {
        if (await measureOne(agent, rec)) measured += 1;
      } catch (err) {
        logger.error({ err, recId: rec.recId }, "learning:medição de outcome falhou");
      }
    }
    return { measured };
  }

  async function measureOne(agent: LearnableAgent, rec: MeasurableRec): Promise<boolean> {
    const appliedAt = await outcomeRepo.findAppliedInstant(rec.runId, rec.entityId);
    if (!appliedAt) return false; // não aplicada por nós → sem Sinal A a medir

    const buffer = config.phaseBufferDays;
    const window = config.outcomeWindowDays;
    const preFrom = dateStr(addDays(appliedAt, -window));
    const preTo = dateStr(addDays(appliedAt, -1));
    const postFrom = dateStr(addDays(appliedAt, buffer));
    const postTo = dateStr(addDays(appliedAt, buffer + window - 1));
    // maturidade real é do INSTANTE DA AÇÃO (não do rec.createdAt): ação aplicada por aprovação
    // pode ocorrer horas/1d depois. Se a janela pós ainda não fechou, NÃO mede (evita congelar um
    // outcome imaturo que o guard measured_at impediria de remedir). Re-mede num tick futuro.
    if (postTo >= dateStr(clock())) return false;
    const isPauseLike = rec.actionType === "pause_entity" || rec.actionType === "set_status";

    const entityPre = await outcomeRepo.loadWindow(agent.orgId, rec.adAccountId, rec.entityId, preFrom, preTo);
    const entityPost = await outcomeRepo.loadWindow(agent.orgId, rec.adAccountId, rec.entityId, postFrom, postTo);
    const accountPre = isPauseLike ? await outcomeRepo.loadWindow(agent.orgId, rec.adAccountId, null, preFrom, preTo) : undefined;
    const accountPost = isPauseLike ? await outcomeRepo.loadWindow(agent.orgId, rec.adAccountId, null, postFrom, postTo) : undefined;

    const outcome = computeOutcome({
      actionType: rec.actionType,
      params: rec.params,
      entityPre,
      entityPost,
      ...(accountPre ? { accountPre } : {}),
      ...(accountPost ? { accountPost } : {}),
    });
    const metrics = windowMetrics(entityPre, entityPost, accountPre, accountPost);

    // evidência (v3): o outcome medido vira linhas de ledger (dimensão/direção que sustenta OU
    // contradiz um prior de conta). A destilação cross-seccional (≥K entidades) roda à parte —
    // uma medição não cria mais lição por-entidade. `entityId` é a base da contagem distinta.
    const evidence = evidenceRowsFor(agent, rec.entityId, "our_action", `rec:${rec.recId}`, outcome, appliedAt, {
      actionType: rec.actionType,
      params: rec.params,
    });

    await outcomeRepo.commitOutcome({
      orgId: agent.orgId,
      agentId: agent.agentId,
      recId: rec.recId,
      outcome,
      metrics,
      evidence,
    });
    return true;
  }

  /** Traduz um outcome medido nas linhas de evidência do ledger (idempotentes por dedupeRef). */
  function evidenceRowsFor(
    agent: LearnableAgent,
    entityId: string,
    source: LearningEvidenceInsert["source"],
    dedupeBase: string,
    outcome: MeasuredOutcome,
    measuredAt: Date,
    action: { actionType: MeasurableRec["actionType"]; params: Readonly<Record<string, unknown>> },
  ): LearningEvidenceInsert[] {
    const entries: AccountEvidenceEntry[] = classifyOutcomeEvidence({ actionType: action.actionType, params: action.params, outcome, subjectId: entityId });
    return entries.map((e) => ({
      orgId: agent.orgId,
      agentId: agent.agentId,
      dimension: e.dimension,
      direction: e.direction,
      entityId,
      supports: e.supports,
      outcome,
      source,
      // dedupeRef inclui (dimensão,direção) → o par de linhas de uma escala (sustenta+contradiz)
      // não colide entre si; nunca conta a mesma medição 2x.
      dedupeRef: `${dedupeBase}:${e.dimension}:${e.direction}`,
      measuredAt,
    }));
  }

  /**
   * Aprende com mudanças que o GESTOR fez na mão na Meta (Sinal B — atribuição por
   * config-snapshot). Detecta a mudança madura, exclui as nossas ações, mede o outcome
   * (mesmo computeOutcome) e grava linhas de EVIDÊNCIA no ledger (não uma lição por-entidade).
   * É assim que a conta "só análise" alimenta o prior de conta: o gestor age, nós medimos.
   */
  async function measureManualChanges(agent: LearnableAgent): Promise<{ evidence: number }> {
    const buffer = config.phaseBufferDays;
    const window = config.outcomeWindowDays;
    const today = clock();
    const notAfter = dateStr(addDays(today, -(buffer + window)));
    // graça = 1 janela cheia (como o Sinal A) → robusto a ticks perdidos (worker fora do ar /
    // deploy). Config-snapshots são esparsos (cadência da análise) → poucas mudanças por janela,
    // e o dedup por dedupeRef evita re-contar a mesma (o custo de re-scan é baixo).
    const notBefore = dateStr(addDays(today, -(buffer + window + window)));
    const changes = await outcomeRepo.loadMaturedConfigChanges(agent.orgId, agent.adAccountId, notBefore, notAfter);
    const rows: LearningEvidenceInsert[] = [];
    for (const change of changes) {
      try {
        const action = manualChangeToAction(change.prev, change.curr);
        if (!action) continue;
        const changeAt = new Date(`${change.changeDate}T00:00:00.000Z`);
        // foi mudança NOSSA? então não é do gestor — pula (não dupla-conta com o Sinal A). Janela
        // de exclusão = cadência do snapshot (±1 dia): casa o instante da nossa tool_call com a data
        // do snapshot que capturou a mudança. NÃO alargamos de propósito (F-core-10): uma janela
        // maior arriscaria atribuir a NÓS uma mudança manual legítima só por termos agido na mesma
        // entidade dias antes; o pior caso hoje (nossa ação ≥2d antes) gera só UMA linha de ledger
        // duplicada por entidade — inócua (não infla a contagem de entidades distintas do prior).
        if (await outcomeRepo.hasAppliedActionInRange(agent.agentId, change.entityId, addDays(changeAt, -1), addDays(changeAt, 1))) continue;

        const preFrom = dateStr(addDays(changeAt, -window));
        const preTo = dateStr(addDays(changeAt, -1));
        const postFrom = dateStr(addDays(changeAt, buffer));
        const postTo = dateStr(addDays(changeAt, buffer + window - 1));
        const isPauseLike = action.actionType === "pause_entity" || action.actionType === "set_status";
        const entityPre = await outcomeRepo.loadWindow(agent.orgId, agent.adAccountId, change.entityId, preFrom, preTo);
        const entityPost = await outcomeRepo.loadWindow(agent.orgId, agent.adAccountId, change.entityId, postFrom, postTo);
        const accountPre = isPauseLike ? await outcomeRepo.loadWindow(agent.orgId, agent.adAccountId, null, preFrom, preTo) : undefined;
        const accountPost = isPauseLike ? await outcomeRepo.loadWindow(agent.orgId, agent.adAccountId, null, postFrom, postTo) : undefined;
        const outcome = computeOutcome({ actionType: action.actionType, params: action.params, entityPre, entityPost, ...(accountPre ? { accountPre } : {}), ...(accountPost ? { accountPost } : {}) });

        rows.push(...evidenceRowsFor(agent, change.entityId, "human_manual", `manual:${change.entityId}:${change.changeDate}`, outcome, changeAt, action));
      } catch (err) {
        logger.error({ err, entityId: change.entityId }, "learning:mudança manual falhou");
      }
    }
    await outcomeRepo.insertEvidence(rows);
    return { evidence: rows.length };
  }

  /**
   * Destila os priors de CONTA do ledger de evidência (cross-seccional, ≥K entidades DISTINTAS).
   * Recomputa do ledger INTEIRO a cada tick (idempotente): materializa uma lição nova (redator)
   * ou atualiza a confiança/contagem de suporte de uma já existente quando entrou evidência de
   * uma entidade NOVA. Não toca guardrail/autonomia — só afia o julgamento (prior de prompt).
   */
  async function distillAccount(agent: LearnableAgent, createBudget: { remaining: number }): Promise<DistillResult> {
    const rows = await repo.loadEvidence(agent.orgId, agent.agentId);
    const candidates = distillAccountPriors(rows, { minEntities: config.accountMinEntities });
    let created = 0;
    let reinforced = 0;
    for (const candidate of candidates) {
      const key = lessonKeyOf(candidate.key);
      const supportCount = candidate.evidence.occurrences; // entidades distintas de suporte (S).
      // proposta de limiar (opt-in, só conservador) nasce quando o prior é forte o bastante.
      const proposal =
        candidate.confidence >= THRESHOLD_PROPOSAL_CONFIDENCE
          ? proposalForCalibration(candidate.kind, candidate.key.dimension, candidate.key.direction)
          : null;
      const existing = await repo.findLessonByKey(agent.orgId, agent.agentId, key);
      if (existing) {
        // dedup: só atualiza quando o suporte CRESCEU (entidade nova) — senão o tick diário
        // reescreveria o mesmo prior à toa.
        if (supportCount <= existing.reinforceCount) continue;
        // re-anexa a proposta só se o dono ainda não a confirmou nem a resolveu (rejeitou/reverteu).
        const attachProposal = proposal && !existing.confirmedByHuman && existing.thresholdResolvedAt === null;
        await repo.refreshAccountPrior({
          orgId: agent.orgId,
          agentId: agent.agentId,
          id: existing.id,
          confidence: candidate.confidence,
          supportCount,
          evidenceAt: clock(),
          ...(attachProposal ? { proposedThresholdPatch: { ...proposal } } : {}),
        });
        reinforced += 1;
        continue;
      }
      if (createBudget.remaining <= 0) continue; // sem orçamento de criação → adia p/ o próximo tick.
      const content = composeLessonText(candidate, createBudget);
      await repo.insertLesson({
        orgId: agent.orgId,
        agentId: agent.agentId,
        candidate,
        content,
        evidenceAt: clock(),
        ...(proposal ? { proposedThresholdPatch: { ...proposal } } : {}),
      });
      await alertNew(agent, { kind: proposal ? "proposal" : "prior", content });
      created += 1;
    }
    return { created, reinforced };
  }

  /**
   * Destila os priors TEMPORAIS (Classe B) da série de insights: timing de fadiga de criativo
   * e lag de conversão. Ambos são prior de PROMPT (ressalva conservadora). Recomputados a cada
   * tick da série (mantém o prior fresco enquanto o padrão persiste); não tocam guardrail/autonomia.
   */
  async function distillTemporal(agent: LearnableAgent, createBudget: { remaining: number }): Promise<DistillResult> {
    const since = dateStr(addDays(clock(), -config.temporalLookbackDays));
    const [ctrSeries, convSeries] = await Promise.all([
      repo.loadCampaignCtrSeries(agent.orgId, agent.adAccountId, since),
      repo.loadAccountConversionSeries(agent.orgId, agent.adAccountId, since),
    ]);
    const candidates = [detectFatigueTimingPrior(ctrSeries), detectConversionLagPrior(convSeries)].filter(
      (c): c is LessonCandidate => c !== null,
    );
    let created = 0;
    let reinforced = 0;
    for (const candidate of candidates) {
      const key = lessonKeyOf(candidate.key);
      const existing = await repo.findLessonByKey(agent.orgId, agent.agentId, key);
      if (existing) {
        // padrão redetectado → mantém vivo (evita decay) e sobe a confiança se ela cresceu.
        await repo.refreshAccountPrior({
          orgId: agent.orgId,
          agentId: agent.agentId,
          id: existing.id,
          confidence: Math.max(existing.confidence ?? 0, candidate.confidence),
          supportCount: existing.reinforceCount,
          evidenceAt: clock(),
        });
        reinforced += 1;
        continue;
      }
      if (createBudget.remaining <= 0) continue;
      const content = composeLessonText(candidate, createBudget);
      await repo.insertLesson({ orgId: agent.orgId, agentId: agent.agentId, candidate, content, evidenceAt: clock() });
      await alertNew(agent, { kind: "prior", content });
      created += 1;
    }
    return { created, reinforced };
  }

  /** Roda a medição + destilação em todos os agentes elegíveis + a curadoria — tick do job. */
  async function runTick(): Promise<{ agents: number; measured: number; manualEvidence: number; created: number; reinforced: number; staled: number; archived: number }> {
    const agentsList = await repo.listLearnableAgents();
    const createBudget = { remaining: config.maxNewLessonsPerTick };
    let created = 0;
    let reinforced = 0;
    let measured = 0;
    let manualEvidence = 0;
    for (const agent of agentsList) {
      try {
        // Medir (ações nossas + mudanças manuais → ledger) → destilar (prior de conta do ledger
        // + prior de tracking do histórico). A ordem garante que a evidência deste tick já conta.
        const m = await measureOutcomes(agent);
        measured += m.measured;
        const mc = await measureManualChanges(agent);
        manualEvidence += mc.evidence;
        const acc = await distillAccount(agent, createBudget);
        const track = await distillAgent(agent, createBudget);
        const temporal = await distillTemporal(agent, createBudget);
        created += acc.created + track.created + temporal.created;
        reinforced += acc.reinforced + track.reinforced + temporal.reinforced;
      } catch (err) {
        logger.error({ err, agentId: agent.agentId }, "learning:agente falhou");
      }
    }
    // curadoria anti-pilha: decaimento global (sem reforço → stale → archived).
    const decay = await repo.applyDecaySweep(clock(), {
      staleDays: config.decayStaleDays,
      archiveDays: config.decayArchiveDays,
    });
    return { agents: agentsList.length, measured, manualEvidence, created, reinforced, ...decay };
  }

  return { distillAgent, distillAccount, distillTemporal, measureOutcomes, measureManualChanges, runTick };
}

/** Monta o `outcomeMetrics` gravado em recommendation_feedback (antes/depois, entidade+conta). */
function windowMetrics(
  entityPre: OutcomeWindow,
  entityPost: OutcomeWindow,
  accountPre?: OutcomeWindow,
  accountPost?: OutcomeWindow,
): Record<string, unknown> {
  return {
    entity: { pre: entityPre, post: entityPost },
    ...(accountPre && accountPost ? { account: { pre: accountPre, post: accountPost } } : {}),
  };
}

/** Fração de runs (do agente) em que o padrão apareceu — força da evidência p/ a confiança. */
function occurrenceRatioOf(candidate: LessonCandidate): number {
  const { occurrences, totalRuns } = candidate.evidence;
  return totalRuns > 0 ? occurrences / totalRuns : 0;
}

export type LearningService = ReturnType<typeof createLearningService>;

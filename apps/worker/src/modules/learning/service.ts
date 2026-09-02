// Serviço de aprendizado (S1): destila lições observacionais do histórico de análise.
// Fluxo por agente: lê o histórico por-run → `detectFactCandidates` (core, puro) →
// para cada candidata: se já existe (mesma chave) REFORÇA a confiança; se é nova,
// o REDATOR LLM traduz a candidata estruturada numa frase PT (com fallback determinístico
// — o loop funciona sem LLM) e persiste. O LLM só redige, nunca inventa a lição.

import type { LLMProviderPort } from "@trafego/shared/ports";
import {
  applyContradiction,
  computeConfidence,
  computeOutcome,
  contradictedLessonKey,
  describeLessonForRedactor,
  detectCalibrationCandidate,
  detectFactCandidates,
  fallbackLessonText,
  lessonKeyOf,
  manualChangeToAction,
  type LessonCandidate,
  type OutcomeWindow,
  type RedactorInput,
} from "@trafego/core";
import type { Logger } from "pino";
import type { LearnableAgent, LearningRepo } from "./repo.js";
import type { MeasurableRec, OutcomeRepo } from "./outcome-repo.js";

export interface LearningServiceConfig {
  readonly historyRuns: number;
  readonly minRuns: number;
  readonly minOccurrenceRatio: number;
  readonly redactorModel: string;
  readonly redactorMaxPerTick: number;
  /** decaimento (curadoria): dias sem reforço p/ stale → archived. */
  readonly decayStaleDays: number;
  readonly decayArchiveDays: number;
  /** medição de outcome (Sinal A): buffer da learning phase + janela de medição. */
  readonly phaseBufferDays: number;
  readonly outcomeWindowDays: number;
}

export interface LearningServiceDeps {
  readonly repo: LearningRepo;
  readonly outcomeRepo: OutcomeRepo;
  readonly llm: LLMProviderPort;
  readonly logger: Logger;
  readonly config: LearningServiceConfig;
  /** relógio injetável (testes determinísticos). Default = Date.now. */
  readonly now?: () => Date;
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

  /** Destila lições observacionais de UM agente. Retorna quantas criou/reforçou. */
  async function distillAgent(agent: LearnableAgent, redactBudget: { remaining: number }): Promise<DistillResult> {
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
        await repo.reinforceLesson(existing.id, next, evidenceAt);
        reinforced += 1;
        continue;
      }
      // lição NOVA precisa de texto legível (redator). Sem orçamento de redator neste tick,
      // ADIA a criação (o padrão persiste → vira candidata no próximo tick com orçamento) em
      // vez de gravar texto genérico permanente. O fallback determinístico vale só p/ FALHA
      // do LLM (dentro do redator), não p/ orçamento esgotado.
      if (redactBudget.remaining <= 0) continue;
      const content = await redactWithBudget(candidate, agent.orgId, newestRun?.runId, redactBudget);
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

  async function redactWithBudget(
    candidate: LessonCandidate,
    orgId: string,
    runId: string | undefined,
    budget: { remaining: number },
  ): Promise<string> {
    budget.remaining -= 1;
    const payload = describeLessonForRedactor(candidate);
    try {
      return await redactLesson(payload, orgId, runId);
    } catch (err) {
      logger.warn({ err }, "learning:redator falhou → fallback determinístico");
      return fallbackLessonText(payload);
    }
  }

  /** O redator LLM traduz a candidata ESTRUTURADA numa frase PT. Não decide nada. */
  async function redactLesson(payload: RedactorInput, orgId: string, runId: string | undefined): Promise<string> {
    const system = [
      "Você escreve UMA frase curta, em português do Brasil, descrevendo um PADRÃO observado numa conta de anúncios.",
      "Regras: trate como observação/hipótese (nunca afirme causa nem sucesso); sem markdown; sem emoji;",
      "linguagem simples (o leitor não é técnico); no máximo uma frase. NÃO invente dados além do payload.",
    ].join(" ");
    const user = `Payload (dados do padrão):\n${JSON.stringify(payload)}\n\nEscreva só a frase.`;
    const res = await deps.llm.complete({
      model: config.redactorModel,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.3,
      // runId (run mais novo) → o metering atribui o custo à conta via o join ad_account←run
      // (§11); sem ele o custo do redator ficaria só org-level.
      meta: { orgId, type: "learning", ...(runId ? { runId } : {}) },
    });
    const text = res.output.trim();
    return text.length > 0 ? text : fallbackLessonText(payload);
  }

  /**
   * Mede o outcome das ações NOSSAS de um agente (Sinal A) → grava recommendation_feedback
   * + lição de calibração / contradição. Só recomendações com ação de plataforma aplicada
   * (before_state) cuja janela madurou (buffer da learning phase + janela), e ainda dentro
   * da graça (não re-varre recs antigas). Redação da lição respeita o teto por tick.
   */
  async function measureOutcomes(agent: LearnableAgent, redactBudget: { remaining: number }): Promise<{ measured: number }> {
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
        if (await measureOne(agent, rec, redactBudget)) measured += 1;
      } catch (err) {
        logger.error({ err, recId: rec.recId }, "learning:medição de outcome falhou");
      }
    }
    return { measured };
  }

  async function measureOne(agent: LearnableAgent, rec: MeasurableRec, redactBudget: { remaining: number }): Promise<boolean> {
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

    const entityPre = await outcomeRepo.loadWindow(rec.adAccountId, rec.entityId, preFrom, preTo);
    const entityPost = await outcomeRepo.loadWindow(rec.adAccountId, rec.entityId, postFrom, postTo);
    const accountPre = isPauseLike ? await outcomeRepo.loadWindow(rec.adAccountId, null, preFrom, preTo) : undefined;
    const accountPost = isPauseLike ? await outcomeRepo.loadWindow(rec.adAccountId, null, postFrom, postTo) : undefined;

    const outcome = computeOutcome({
      actionType: rec.actionType,
      params: rec.params,
      entityPre,
      entityPost,
      ...(accountPre ? { accountPre } : {}),
      ...(accountPost ? { accountPost } : {}),
    });
    const metrics = windowMetrics(entityPre, entityPost, accountPre, accountPost);

    // calibração: cautela acionável (escala que deu errado / corte que deu certo).
    const candidate = detectCalibrationCandidate({ actionType: rec.actionType, params: rec.params, outcome, subjectId: rec.entityId });
    let calibration: { candidate: LessonCandidate; content: string; runId?: string } | undefined;
    if (candidate) {
      const content =
        redactBudget.remaining > 0
          ? await redactWithBudget(candidate, agent.orgId, rec.runId, redactBudget)
          : fallbackLessonText(describeLessonForRedactor(candidate));
      calibration = { candidate, content, runId: rec.runId };
    }

    // contradição: o outcome contradiz a conclusão de uma lição existente → enfraquece.
    const contraKey = contradictedLessonKey({ actionType: rec.actionType, params: rec.params, outcome, subjectId: rec.entityId });
    let contradiction: { semanticKey: string; confidence: number; demoteToStale: boolean } | undefined;
    if (contraKey) {
      const key = lessonKeyOf(contraKey);
      const existing = await repo.findLessonByKey(agent.orgId, agent.agentId, key);
      if (existing) {
        const r = applyContradiction(existing.confidence);
        contradiction = { semanticKey: key, confidence: r.confidence, demoteToStale: r.demoteToStale };
      }
    }

    await outcomeRepo.commitOutcome({
      orgId: agent.orgId,
      agentId: agent.agentId,
      recId: rec.recId,
      outcome,
      metrics,
      ...(calibration ? { calibration } : {}),
      ...(contradiction ? { contradiction } : {}),
    });
    return true;
  }

  /**
   * Aprende com mudanças que o GESTOR fez na mão na Meta (Sinal B — atribuição por
   * config-snapshot). Detecta a mudança madura, exclui as nossas ações, mede o outcome
   * (mesmo computeOutcome) e grava uma lição `fact`/`human_manual` de confiança BAIXA
   * (atribuição fraca: timing aproximado — cadência da análise). Sem recommendation_feedback.
   */
  async function measureManualChanges(agent: LearnableAgent, redactBudget: { remaining: number }): Promise<{ learned: number }> {
    const buffer = config.phaseBufferDays;
    const window = config.outcomeWindowDays;
    const today = clock();
    const notAfter = dateStr(addDays(today, -(buffer + window)));
    // graça = 1 janela cheia (como o Sinal A) → robusto a ticks perdidos (worker fora do ar /
    // deploy). Config-snapshots são esparsos (cadência da análise) → poucas mudanças por janela,
    // e o dedup por evidenceAt evita reaprender a mesma (o custo de re-scan é baixo).
    const notBefore = dateStr(addDays(today, -(buffer + window + window)));
    const changes = await outcomeRepo.loadMaturedConfigChanges(agent.adAccountId, notBefore, notAfter);
    let learned = 0;
    for (const change of changes) {
      try {
        const action = manualChangeToAction(change.prev, change.curr);
        if (!action) continue;
        const changeAt = new Date(`${change.changeDate}T00:00:00.000Z`);
        // foi mudança NOSSA? então não é do gestor — pula (não dupla-conta com o Sinal A).
        if (await outcomeRepo.hasAppliedActionInRange(agent.agentId, change.entityId, addDays(changeAt, -1), addDays(changeAt, 1))) continue;

        const preFrom = dateStr(addDays(changeAt, -window));
        const preTo = dateStr(addDays(changeAt, -1));
        const postFrom = dateStr(addDays(changeAt, buffer));
        const postTo = dateStr(addDays(changeAt, buffer + window - 1));
        const isPauseLike = action.actionType === "pause_entity" || action.actionType === "set_status";
        const entityPre = await outcomeRepo.loadWindow(agent.adAccountId, change.entityId, preFrom, preTo);
        const entityPost = await outcomeRepo.loadWindow(agent.adAccountId, change.entityId, postFrom, postTo);
        const accountPre = isPauseLike ? await outcomeRepo.loadWindow(agent.adAccountId, null, preFrom, preTo) : undefined;
        const accountPost = isPauseLike ? await outcomeRepo.loadWindow(agent.adAccountId, null, postFrom, postTo) : undefined;
        const outcome = computeOutcome({ actionType: action.actionType, params: action.params, entityPre, entityPost, ...(accountPre ? { accountPre } : {}), ...(accountPost ? { accountPost } : {}) });

        const base = detectCalibrationCandidate({ actionType: action.actionType, params: action.params, outcome, subjectId: change.entityId });
        if (!base) continue;
        // mudança do gestor = observação (atribuição fraca por timing aproximado): fact +
        // human_manual + confiança OBSERVACIONAL (nunca a de ação nossa medida).
        const candidate: LessonCandidate = {
          ...base,
          kind: "fact",
          origin: "human_manual",
          confidence: computeConfidence(null, { type: "observe", occurrenceRatio: 1, origin: "observational" }),
        };
        const key = lessonKeyOf(candidate.key);
        const existing = await repo.findLessonByKey(agent.orgId, agent.agentId, key);
        if (existing) {
          if (existing.lastReinforcedAt && existing.lastReinforcedAt.getTime() >= changeAt.getTime()) continue;
          const next = computeConfidence(existing.confidence, { type: "observe", occurrenceRatio: 1, origin: "observational" });
          await repo.reinforceLesson(existing.id, next, changeAt);
        } else {
          const content =
            redactBudget.remaining > 0
              ? await redactWithBudget(candidate, agent.orgId, undefined, redactBudget)
              : fallbackLessonText(describeLessonForRedactor(candidate));
          await repo.insertLesson({ orgId: agent.orgId, agentId: agent.agentId, candidate, content, evidenceAt: changeAt });
        }
        learned += 1;
      } catch (err) {
        logger.error({ err, entityId: change.entityId }, "learning:mudança manual falhou");
      }
    }
    return { learned };
  }

  /** Roda a destilação em todos os agentes elegíveis + a curadoria (decaimento) — tick do job. */
  async function runTick(): Promise<{ agents: number; measured: number; manualLearned: number; created: number; reinforced: number; staled: number; archived: number }> {
    const agentsList = await repo.listLearnableAgents();
    const redactBudget = { remaining: config.redactorMaxPerTick };
    let created = 0;
    let reinforced = 0;
    let measured = 0;
    let manualLearned = 0;
    for (const agent of agentsList) {
      try {
        // Sinal A (ações nossas) → mudanças manuais do gestor → observacional do histórico.
        const m = await measureOutcomes(agent, redactBudget);
        measured += m.measured;
        const mc = await measureManualChanges(agent, redactBudget);
        manualLearned += mc.learned;
        const r = await distillAgent(agent, redactBudget);
        created += r.created;
        reinforced += r.reinforced;
      } catch (err) {
        logger.error({ err, agentId: agent.agentId }, "learning:agente falhou");
      }
    }
    // curadoria anti-pilha: decaimento global (sem reforço → stale → archived).
    const decay = await repo.applyDecaySweep(clock(), {
      staleDays: config.decayStaleDays,
      archiveDays: config.decayArchiveDays,
    });
    return { agents: agentsList.length, measured, manualLearned, created, reinforced, ...decay };
  }

  return { distillAgent, measureOutcomes, measureManualChanges, runTick };
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

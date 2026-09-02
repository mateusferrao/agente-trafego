// Serviço de aprendizado (S1): destila lições observacionais do histórico de análise.
// Fluxo por agente: lê o histórico por-run → `detectFactCandidates` (core, puro) →
// para cada candidata: se já existe (mesma chave) REFORÇA a confiança; se é nova,
// o REDATOR LLM traduz a candidata estruturada numa frase PT (com fallback determinístico
// — o loop funciona sem LLM) e persiste. O LLM só redige, nunca inventa a lição.

import type { LLMProviderPort } from "@trafego/shared/ports";
import {
  computeConfidence,
  describeLessonForRedactor,
  detectFactCandidates,
  fallbackLessonText,
  lessonKeyOf,
  type LessonCandidate,
  type RedactorInput,
} from "@trafego/core";
import type { Logger } from "pino";
import type { LearnableAgent, LearningRepo } from "./repo.js";

export interface LearningServiceConfig {
  readonly historyRuns: number;
  readonly minRuns: number;
  readonly minOccurrenceRatio: number;
  readonly redactorModel: string;
  readonly redactorMaxPerTick: number;
  /** decaimento (curadoria): dias sem reforço p/ stale → archived. */
  readonly decayStaleDays: number;
  readonly decayArchiveDays: number;
}

export interface LearningServiceDeps {
  readonly repo: LearningRepo;
  readonly llm: LLMProviderPort;
  readonly logger: Logger;
  readonly config: LearningServiceConfig;
}

export interface DistillResult {
  readonly created: number;
  readonly reinforced: number;
}

export function createLearningService(deps: LearningServiceDeps) {
  const { repo, logger, config } = deps;

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
      // lição NOVA → precisa de texto legível (redator). Respeita o teto por tick.
      const content =
        redactBudget.remaining > 0
          ? await redactWithBudget(candidate, agent.orgId, redactBudget)
          : fallbackLessonText(describeLessonForRedactor(candidate));
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
    budget: { remaining: number },
  ): Promise<string> {
    budget.remaining -= 1;
    const payload = describeLessonForRedactor(candidate);
    try {
      return await redactLesson(payload, orgId);
    } catch (err) {
      logger.warn({ err }, "learning:redator falhou → fallback determinístico");
      return fallbackLessonText(payload);
    }
  }

  /** O redator LLM traduz a candidata ESTRUTURADA numa frase PT. Não decide nada. */
  async function redactLesson(payload: RedactorInput, orgId: string): Promise<string> {
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
      meta: { orgId, type: "learning" },
    });
    const text = res.output.trim();
    return text.length > 0 ? text : fallbackLessonText(payload);
  }

  /** Roda a destilação em todos os agentes elegíveis + a curadoria (decaimento) — tick do job. */
  async function runTick(): Promise<{ agents: number; created: number; reinforced: number; staled: number; archived: number }> {
    const agentsList = await repo.listLearnableAgents();
    const redactBudget = { remaining: config.redactorMaxPerTick };
    let created = 0;
    let reinforced = 0;
    for (const agent of agentsList) {
      try {
        const r = await distillAgent(agent, redactBudget);
        created += r.created;
        reinforced += r.reinforced;
      } catch (err) {
        logger.error({ err, agentId: agent.agentId }, "learning:destilação do agente falhou");
      }
    }
    // curadoria anti-pilha: decaimento global (sem reforço → stale → archived).
    const decay = await repo.applyDecaySweep(new Date(), {
      staleDays: config.decayStaleDays,
      archiveDays: config.decayArchiveDays,
    });
    return { agents: agentsList.length, created, reinforced, ...decay };
  }

  return { distillAgent, runTick };
}

/** Fração de runs (do agente) em que o padrão apareceu — força da evidência p/ a confiança. */
function occurrenceRatioOf(candidate: LessonCandidate): number {
  const { occurrences, totalRuns } = candidate.evidence;
  return totalRuns > 0 ? occurrences / totalRuns : 0;
}

export type LearningService = ReturnType<typeof createLearningService>;

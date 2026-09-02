// Worker BullMQ da fila `agent-learning` (aprendizado contínuo): consome o tick
// recorrente (diário) e destila lições observacionais do histórico de análise de cada
// agente ativo. Responsabilidades crescem por subfatia (S4: medição de outcome +
// curadoria). Espelha o padrão do `approval-expiry` (tick singleton varre os agentes).

import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import { AGENT_LEARNING_QUEUE, type AgentLearningTickPayload } from "@trafego/shared";
import type { WorkerDeps } from "../composition.js";
import { createLearningRepo } from "../modules/learning/repo.js";
import { createOutcomeRepo } from "../modules/learning/outcome-repo.js";
import { createLearningService } from "../modules/learning/service.js";

export function startAgentLearningWorker(deps: WorkerDeps, connection: Redis): Worker<AgentLearningTickPayload> {
  const service = createLearningService({
    repo: createLearningRepo(deps.db),
    outcomeRepo: createOutcomeRepo(deps.db),
    llm: deps.ports.llm,
    logger: deps.logger,
    config: {
      historyRuns: deps.learning.historyRuns,
      minRuns: deps.learning.minRuns,
      minOccurrenceRatio: deps.learning.minOccurrenceRatio,
      redactorModel: deps.learning.redactorModel,
      redactorMaxPerTick: deps.learning.redactorMaxPerTick,
      decayStaleDays: deps.learning.decayStaleDays,
      decayArchiveDays: deps.learning.decayArchiveDays,
      phaseBufferDays: deps.learning.phaseBufferDays,
      outcomeWindowDays: deps.learning.outcomeWindowDays,
    },
  });
  return new Worker<AgentLearningTickPayload>(
    AGENT_LEARNING_QUEUE,
    async () => {
      const r = await service.runTick();
      if (r.measured > 0 || r.manualLearned > 0 || r.created > 0 || r.reinforced > 0 || r.staled > 0 || r.archived > 0) {
        deps.logger.info(r, "agent-learning:tick");
      }
    },
    { connection },
  );
}

// Worker BullMQ da fila `agent-learning` (aprendizado contínuo): consome o tick
// recorrente (diário) e destila lições observacionais do histórico de análise de cada
// agente ativo. Responsabilidades crescem por subfatia (S4: medição de outcome +
// curadoria). Espelha o padrão do `approval-expiry` (tick singleton varre os agentes).

import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import { eq } from "drizzle-orm";
import { agents } from "@trafego/db";
import { AGENT_LEARNING_QUEUE, type AgentLearningTickPayload, type NotifyPolicy } from "@trafego/shared";
import type { WorkerDeps } from "../composition.js";
import { ownerAccessActive } from "../modules/access/owner-gate.js";
import { createNotifyRepo } from "../modules/notify/repo.js";
import { createSendToConversation } from "../modules/notify/send-to-contact.js";
import { createLearningRepo, type LearnableAgent } from "../modules/learning/repo.js";
import { createOutcomeRepo } from "../modules/learning/outcome-repo.js";
import { createLearningService } from "../modules/learning/service.js";

export function startAgentLearningWorker(deps: WorkerDeps, connection: Redis): Worker<AgentLearningTickPayload> {
  const notifyRepo = createNotifyRepo(deps.db);
  const sendToConversation = createSendToConversation({ messaging: deps.ports.messaging, repo: notifyRepo });

  // Alerta de aprendizado novo no WhatsApp (v3), gated por notify_policy.learning (default ON) +
  // gate de beta (acesso do dono). Alvo org-level (grupo→DM via loadTarget). Best-effort.
  const onNewLearning = async (agent: LearnableAgent, event: { kind: "prior" | "proposal"; content: string }): Promise<void> => {
    const [row] = await deps.db.select({ notifyPolicy: agents.notifyPolicy }).from(agents).where(eq(agents.id, agent.agentId)).limit(1);
    const learning = (row?.notifyPolicy as NotifyPolicy | undefined)?.learning;
    if (learning?.enabled === false) return; // default ON (ausência = ligado)
    if (!(await ownerAccessActive(deps.db, agent.orgId))) return;
    const ref = await notifyRepo.loadTarget(agent.orgId);
    if (!ref) return;
    const prefix = event.kind === "proposal" ? "Tenho uma sugestão de ajuste pra você aprovar: " : "Aprendi algo novo sobre a conta: ";
    await sendToConversation(ref, `${prefix}${event.content}`, { split: false, meta: { learning: true } });
    deps.logger.info({ agentId: agent.agentId, kind: event.kind }, "learning:alerta enviado");
  };

  const service = createLearningService({
    repo: createLearningRepo(deps.db),
    outcomeRepo: createOutcomeRepo(deps.db),
    llm: deps.ports.llm,
    logger: deps.logger,
    onNewLearning,
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
      accountMinEntities: deps.learning.accountMinEntities,
      temporalLookbackDays: deps.learning.temporalLookbackDays,
    },
  });
  return new Worker<AgentLearningTickPayload>(
    AGENT_LEARNING_QUEUE,
    async () => {
      const r = await service.runTick();
      if (r.measured > 0 || r.manualEvidence > 0 || r.created > 0 || r.reinforced > 0 || r.staled > 0 || r.archived > 0) {
        deps.logger.info(r, "agent-learning:tick");
      }
    },
    { connection },
  );
}

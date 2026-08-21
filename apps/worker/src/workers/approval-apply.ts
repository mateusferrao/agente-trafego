// Worker BullMQ da fila `approval-apply` (5b): a API/WhatsApp valida a posse + enfileira;
// aqui o worker carrega a `approval`, valida (posse/status/run) e delega a aplicação ao
// núcleo compartilhado `applyConfirmedAction` (re-check fresco + guardrail atual + executor),
// mapeando o desfecho tipado p/ resolver a approval + empurrar o resultado no WhatsApp.
// Mesmo núcleo reusado pela escrita livre por chat (5c). Idempotente por `${approvalId}:apply`.

import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import { APPROVAL_APPLY_QUEUE, type ApprovalApplyPayload, type ApprovalId } from "@trafego/shared";
import type { WorkerDeps } from "../composition.js";
import { applyConfirmedAction } from "../modules/apply/apply-confirmed-action.js";
import { createNotifyRepo } from "../modules/notify/repo.js";
import { createSendToContact } from "../modules/notify/send-to-contact.js";

export function startApprovalApplyWorker(deps: WorkerDeps, connection: Redis): Worker<ApprovalApplyPayload> {
  const { logger, ports } = deps;
  const sendToContact = createSendToContact({ messaging: ports.messaging, repo: createNotifyRepo(deps.db) });

  return new Worker<ApprovalApplyPayload>(
    APPROVAL_APPLY_QUEUE,
    async (job) => {
      const { orgId, approvalId, notifyContactId } = job.data;
      // desfecho de volta no WhatsApp (só quando a aprovação veio do chat — 5b-2.3).
      const pushOutcome = async (text: string): Promise<void> => {
        if (!notifyContactId) return;
        try {
          await sendToContact(notifyContactId, text, { split: false });
        } catch (err) {
          logger.warn({ err, approvalId }, "approval-apply:push do desfecho falhou");
        }
      };

      const approval = await ports.approval.getById(approvalId as ApprovalId);
      // posse + estado: só aplica pendente da própria org (idempotente se já resolvida).
      if (!approval || approval.orgId !== orgId) {
        logger.warn({ approvalId, orgId }, "approval-apply:não encontrada (org-scoped)");
        return;
      }
      if (approval.status !== "pending") {
        logger.info({ approvalId, status: approval.status }, "approval-apply:já resolvida");
        return;
      }
      if (!approval.runId) {
        logger.warn({ approvalId }, "approval-apply:sem runId — não atribuível");
        await ports.approval.resolve(approval.id, { status: "blocked", resolvedReason: "sem run de origem" });
        await pushOutcome("Não consegui aplicar essa ação — ela perdeu a referência. Rode a análise de novo.");
        return;
      }

      const who = approval.action.target?.name ?? null;
      const suffix = who ? ` (${who})` : "";

      const outcome = await applyConfirmedAction(deps, {
        orgId,
        agentId: approval.agentId,
        action: approval.action,
        runId: approval.runId,
        idempotencyKey: `${approval.id}:apply`,
      });

      switch (outcome.kind) {
        case "failed":
          // falha da Meta (rede/rate-limit/etc): mantém a aprovação PENDENTE (dá p/ reaprovar)
          // e avisa o usuário — a promessa de "te aviso o resultado" não pode sumir (§UX).
          logger.error({ approvalId, err: outcome.error }, "approval-apply:execute falhou");
          await pushOutcome(`Não consegui aplicar agora${suffix} — a Meta não respondeu. Tenta de novo em instantes.`);
          return;
        case "blocked":
          await ports.approval.resolve(approval.id, { status: "blocked", resolvedReason: outcome.reason });
          logger.info({ approvalId, reason: outcome.reason }, "approval-apply:barrada no re-check");
          await pushOutcome(`Não apliquei${suffix}: ${outcome.reason}.`);
          return;
        case "noop":
          await ports.approval.resolve(approval.id, {
            status: "blocked",
            resolvedReason: "a entidade já estava no estado desejado",
          });
          logger.info({ approvalId }, "approval-apply:no-op (já no estado)");
          await pushOutcome(`Não precisei mexer${suffix} — já estava no estado desejado.`);
          return;
        case "applied":
          await ports.approval.resolve(approval.id, { status: "approved" });
          logger.info({ approvalId, dryRun: outcome.dryRun }, "approval-apply:aplicada");
          await pushOutcome(outcome.dryRun ? `🧪 Simulei a ação${suffix} (dry-run).` : `✅ Apliquei${suffix}.`);
          return;
      }
    },
    { connection },
  );
}

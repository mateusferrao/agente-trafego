// Worker BullMQ da fila `approval-apply` (5b): a API/WhatsApp valida a posse + enfileira;
// aqui o worker carrega a `approval`, valida (posse/status/run) e delega a aplicação ao
// núcleo compartilhado `applyConfirmedAction` (re-check fresco + guardrail atual + executor),
// mapeando o desfecho tipado p/ resolver a approval + empurrar o resultado no WhatsApp.
// Mesmo núcleo reusado pela escrita livre por chat (5c). Idempotente por `${approvalId}:apply`.

import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import { APPROVAL_APPLY_QUEUE, type ApprovalApplyPayload, type ApprovalId } from "@trafego/shared";
import { AdsPlatformError } from "@trafego/shared/ports";
import type { WorkerDeps } from "../composition.js";
import { applyConfirmedAction } from "../modules/apply/apply-confirmed-action.js";
import { applyDraft } from "../modules/apply/apply-draft.js";
import { createNotifyRepo } from "../modules/notify/repo.js";
import { createSendToConversation } from "../modules/notify/send-to-contact.js";

/** Envelopa o desfecho de falha: se a plataforma mandou uma mensagem legível (`userMessage`),
 *  prefere-a ("A Meta informou: …"); senão o texto genérico. Nunca vaza `message` técnico. */
function metaFailureLine(error: unknown, fallback: string): string {
  if (error instanceof AdsPlatformError && error.userMessage) {
    return `A Meta informou: ${error.userMessage.trim()}`;
  }
  return fallback;
}

export function startApprovalApplyWorker(deps: WorkerDeps, connection: Redis): Worker<ApprovalApplyPayload> {
  const { logger, ports } = deps;
  const sendToConversation = createSendToConversation({ messaging: ports.messaging, repo: createNotifyRepo(deps.db) });

  return new Worker<ApprovalApplyPayload>(
    APPROVAL_APPLY_QUEUE,
    async (job) => {
      const { orgId, approvalId, notifyRef } = job.data;
      // desfecho de volta no WhatsApp (só quando a aprovação veio do chat — 5b-2.3, DM ou grupo).
      const pushOutcome = async (text: string): Promise<void> => {
        if (!notifyRef) return;
        try {
          await sendToConversation(notifyRef, text, { split: false });
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
      if (approval.kind === "draft") {
        // Aprovação de RASCUNHO (Fatia 7) → saga de criação (apply-draft).
        const outcome = await applyDraft(deps, { orgId, draftId: approval.draftId });
        switch (outcome.kind) {
          case "failed":
            logger.error({ approvalId, err: outcome.error }, "approval-apply:saga de criação falhou");
            await pushOutcome(
              metaFailureLine(outcome.error, "Não consegui criar agora — a Meta não respondeu. Tenta de novo em instantes."),
            );
            return;
          case "blocked":
            await ports.approval.resolve(approval.id, { status: "blocked", resolvedReason: outcome.reason });
            await pushOutcome(`Não criei: ${outcome.reason}.`);
            return;
          case "unsupported":
            await ports.approval.resolve(approval.id, { status: "blocked", resolvedReason: outcome.reason });
            await pushOutcome(`Ainda não consigo fazer isso: ${outcome.reason}.`);
            return;
          case "created":
            await ports.approval.resolve(approval.id, { status: "approved" });
            await pushOutcome(outcome.dryRun ? "🧪 Simulei a criação (dry-run)." : "✅ Criado! Já subiu — a Meta vai revisar antes de veicular.");
            return;
        }
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
          await pushOutcome(
            metaFailureLine(outcome.error, `Não consegui aplicar agora${suffix} — a Meta não respondeu. Tenta de novo em instantes.`),
          );
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

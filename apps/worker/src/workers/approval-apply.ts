// Worker BullMQ da fila `approval-apply` (5b): a API/WhatsApp valida a posse + enfileira;
// aqui o worker carrega a `approval`, valida (posse/status/run) e delega a aplicação ao
// núcleo compartilhado `applyConfirmedAction` (re-check fresco + guardrail atual + executor),
// mapeando o desfecho tipado p/ resolver a approval + empurrar o resultado no WhatsApp.
// Mesmo núcleo reusado pela escrita livre por chat (5c). Idempotente por `${approvalId}:apply`.

import { Worker } from "bullmq";
import { eq } from "drizzle-orm";
import type { Redis } from "ioredis";
import { campaignDrafts } from "@trafego/db";
import { APPROVAL_APPLY_QUEUE, type ApprovalApplyPayload, type ApprovalId, type CampaignDraftSpec } from "@trafego/shared";
import { AdsPlatformError } from "@trafego/shared/ports";
import { describeActionOutcome, describeActivationOutcome, describeDraftOutcome, readModernizations } from "@trafego/core";
import type { WorkerDeps } from "../composition.js";
import { applyActivation } from "../modules/apply/apply-activation.js";
import { applyConfirmedAction } from "../modules/apply/apply-confirmed-action.js";
import { applyDraft } from "../modules/apply/apply-draft.js";
import { describeCreatedDraft } from "../modules/apply/draft-summary.js";
import { createNotifyRepo } from "../modules/notify/repo.js";
import { createSendToConversation } from "../modules/notify/send-to-contact.js";
import { metaUserMessage, permanentMetaReason } from "../lib/meta-failure.js";

/** A falha é rate-limit E ainda há tentativa no job → re-lança pro BullMQ retentar com backoff
 *  (a escrita/saga é idempotente por chave → sem duplo-apply; a saga retoma dos `createdIds`). */
function shouldRetryRateLimit(error: unknown, job: { attemptsMade: number; opts: { attempts?: number } }): boolean {
  const attempts = job.opts.attempts ?? 1;
  const isLastAttempt = job.attemptsMade + 1 >= attempts;
  return error instanceof AdsPlatformError && error.kind === "rate_limited" && !isLastAttempt;
}

export function startApprovalApplyWorker(deps: WorkerDeps, connection: Redis): Worker<ApprovalApplyPayload> {
  const { logger, ports } = deps;
  const notifyRepo = createNotifyRepo(deps.db);
  const sendToConversation = createSendToConversation({ messaging: ports.messaging, repo: notifyRepo });

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
      // Aviso de MUDANÇA REAL (S7, geral): SEMPRE avisa no WhatsApp quando algo foi de fato
      // aplicado na Meta (criação/ativação/ação) — inclusive aprovado pelo SITE (sem notifyRef)
      // → resolve o alvo org (grupo ativo, senão DM). Transparência: nenhuma mudança real fica
      // silenciosa. Dry-run/falha/no-op NÃO usam isto (não houve mudança real → só o chat que
      // pediu, via pushOutcome). Best-effort (Evolution fora não quebra o apply).
      const pushRealApplied = async (text: string): Promise<void> => {
        const ref = notifyRef ?? (await notifyRepo.loadTarget(orgId));
        if (!ref) return;
        try {
          await sendToConversation(ref, text, { split: false });
        } catch (err) {
          logger.warn({ err, approvalId }, "approval-apply:push do resumo de aplicação falhou");
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
          case "failed": {
            // G10: rate-limit na CRIAÇÃO retenta (a saga retoma dos createdIds; sem duplo-apply).
            if (shouldRetryRateLimit(outcome.error, job)) {
              logger.warn({ approvalId, attempt: job.attemptsMade + 1 }, "approval-apply:criação rate-limit — retry com backoff");
              throw outcome.error;
            }
            // G2: rejeição DETERMINÍSTICA da Meta (validação/permissão/token) → resolve `blocked` com a
            // razão honesta (para o loop de re-tentar o mesmo spec que sempre falha), em vez de deixar
            // pendente com "tenta de novo". Transiente (rede/5xx/rate-limit esgotado) → mantém pendente.
            // G3: nomeia a campanha órfã (pausada e vazia) quando a saga do-zero parou no meio.
            const partial = outcome.partialCampaign ? { partialCampaign: outcome.partialCampaign } : {};
            const permReason = permanentMetaReason(outcome.error);
            if (permReason) {
              logger.warn({ approvalId, reason: permReason }, "approval-apply:criação recusada (determinístico)");
              await ports.approval.resolve(approval.id, { status: "blocked", resolvedReason: permReason, applyOutcome: "blocked" });
              await pushOutcome(describeDraftOutcome({ kind: "blocked", reason: permReason, ...partial }));
              return;
            }
            const metaMessage = metaUserMessage(outcome.error);
            logger.error({ approvalId, err: outcome.error }, "approval-apply:saga de criação falhou");
            await ports.approval.markApplyOutcome(approval.id, "failed", metaMessage);
            await pushOutcome(describeDraftOutcome({ kind: "failed", ...(metaMessage ? { metaMessage } : {}), ...partial }));
            return;
          }
          case "blocked":
          case "unsupported":
            await ports.approval.resolve(approval.id, { status: "blocked", resolvedReason: outcome.reason, applyOutcome: "blocked" });
            await pushOutcome(describeDraftOutcome({ kind: "blocked", reason: outcome.reason }));
            return;
          case "limited":
            // teto de guardrail CORRIGÍVEL → NÃO resolve (o card fica pendente + reabilita p/
            // reaprovar após ajustar o limite); registra o motivo (como o `failed`).
            await ports.approval.markApplyOutcome(approval.id, "failed", outcome.reason);
            await pushOutcome(describeDraftOutcome({ kind: "failed", metaMessage: outcome.reason }));
            return;
          case "created": {
            await ports.approval.resolve(approval.id, { status: "approved", applyOutcome: outcome.dryRun ? "simulated" : "applied" });
            const [draftRow] = await deps.db
              .select({ kind: campaignDrafts.kind, spec: campaignDrafts.spec })
              .from(campaignDrafts)
              .where(eq(campaignDrafts.id, approval.draftId))
              .limit(1);
            const summary = draftRow ? describeCreatedDraft(draftRow.kind, draftRow.spec as CampaignDraftSpec) : "sua campanha";
            // fonte única da copy (voz do Roy) — mesma frase no WhatsApp e no card do site (getOutcome).
            const text = describeDraftOutcome({ kind: "created", dryRun: outcome.dryRun, summary, activated: outcome.activated, targetingFallback: outcome.createdIds["targetingFallback"] === true, modernizations: readModernizations(outcome.createdIds) });
            if (outcome.dryRun) await pushOutcome(text);
            else await pushRealApplied(text);
            return;
          }
        }
        return;
      }
      if (approval.kind === "activation") {
        // Aprovação de ATIVAÇÃO (P0.1 — 2º passo HITL): o rascunho já foi criado PAUSADO;
        // confirmar aqui ativa a raiz da árvore criada na Meta (não cria nada novo).
        const outcome = await applyActivation(deps, { orgId, draftId: approval.draftId });
        switch (outcome.kind) {
          case "failed": {
            if (shouldRetryRateLimit(outcome.error, job)) {
              logger.warn({ approvalId, attempt: job.attemptsMade + 1 }, "approval-apply:ativação rate-limit — retry com backoff");
              throw outcome.error;
            }
            const permReason = permanentMetaReason(outcome.error);
            if (permReason) {
              logger.warn({ approvalId, reason: permReason }, "approval-apply:ativação recusada (determinístico)");
              await ports.approval.resolve(approval.id, { status: "blocked", resolvedReason: permReason, applyOutcome: "blocked" });
              await pushOutcome(describeActivationOutcome({ kind: "blocked", reason: permReason }));
              return;
            }
            const metaMessage = metaUserMessage(outcome.error);
            logger.error({ approvalId, err: outcome.error }, "approval-apply:ativação falhou");
            await ports.approval.markApplyOutcome(approval.id, "failed", metaMessage);
            await pushOutcome(describeActivationOutcome({ kind: "failed", ...(metaMessage ? { metaMessage } : {}) }));
            return;
          }
          case "blocked":
            await ports.approval.resolve(approval.id, { status: "blocked", resolvedReason: outcome.reason, applyOutcome: "blocked" });
            await pushOutcome(describeActivationOutcome({ kind: "blocked", reason: outcome.reason }));
            return;
          case "activated":
            await ports.approval.resolve(approval.id, { status: "approved", applyOutcome: outcome.dryRun ? "simulated" : "applied" });
            if (outcome.dryRun) await pushOutcome(describeActivationOutcome({ kind: "activated", dryRun: true }));
            // G8: quando a duplicata de conjunto não veicula (campanha-mãe pausada), o desfecho é honesto.
            else await pushRealApplied(describeActivationOutcome({ kind: "activated", dryRun: false, ...(outcome.notDelivering ? { notDelivering: true } : {}) }));
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

      const outcome = await applyConfirmedAction(deps, {
        orgId,
        agentId: approval.agentId,
        action: approval.action,
        runId: approval.runId,
        idempotencyKey: `${approval.id}:apply`,
      });

      switch (outcome.kind) {
        case "failed": {
          // Rate-limit da Meta (#613, D3) é TRANSIENTE: enquanto houver tentativa, RE-LANÇA → o
          // BullMQ retenta com backoff (a escrita é idempotente por `${approval}:apply`, sem duplo-apply).
          if (shouldRetryRateLimit(outcome.error, job)) {
            logger.warn({ approvalId, attempt: job.attemptsMade + 1 }, "approval-apply:rate-limit — retry com backoff");
            throw outcome.error; // deixa o BullMQ retentar (backoff configurado no job)
          }
          // G2: rejeição DETERMINÍSTICA (validação/permissão/token) → resolve `blocked` honesto (para o
          // loop de re-tentar o mesmo re-check que sempre falha), em vez de manter pendente + "tenta de novo".
          const permReason = permanentMetaReason(outcome.error);
          if (permReason) {
            logger.warn({ approvalId, reason: permReason }, "approval-apply:ação recusada (determinístico)");
            await ports.approval.resolve(approval.id, { status: "blocked", resolvedReason: permReason, applyOutcome: "blocked" });
            await pushOutcome(describeActionOutcome(approval.action, { kind: "blocked", reason: permReason }));
            return;
          }
          // falha TRANSIENTE (rede/5xx/rate-limit esgotado): mantém a aprovação PENDENTE (dá p/ reaprovar),
          // mas registra o desfecho (`markApplyOutcome`, sem resolver) p/ o card mostrar + reabilitar o
          // botão. A promessa de "te aviso o resultado" não pode sumir (§UX).
          const metaMessage = metaUserMessage(outcome.error);
          logger.error({ approvalId, err: outcome.error }, "approval-apply:execute falhou");
          await ports.approval.markApplyOutcome(approval.id, "failed", metaMessage);
          await pushOutcome(describeActionOutcome(approval.action, { kind: "failed", ...(metaMessage !== undefined ? { metaMessage } : {}) }));
          return;
        }
        case "blocked":
          await ports.approval.resolve(approval.id, { status: "blocked", resolvedReason: outcome.reason, applyOutcome: "blocked" });
          logger.info({ approvalId, reason: outcome.reason }, "approval-apply:barrada no re-check");
          await pushOutcome(describeActionOutcome(approval.action, { kind: "blocked", reason: outcome.reason }));
          return;
        case "noop":
          await ports.approval.resolve(approval.id, {
            status: "blocked",
            resolvedReason: "a entidade já estava no estado desejado",
            applyOutcome: "noop",
          });
          logger.info({ approvalId }, "approval-apply:no-op (já no estado)");
          await pushOutcome(describeActionOutcome(approval.action, { kind: "noop" }));
          return;
        case "applied":
          await ports.approval.resolve(approval.id, { status: "approved", applyOutcome: outcome.dryRun ? "simulated" : "applied" });
          logger.info({ approvalId, dryRun: outcome.dryRun }, "approval-apply:aplicada");
          if (outcome.dryRun) await pushOutcome(describeActionOutcome(approval.action, { kind: "simulated" }));
          else await pushRealApplied(describeActionOutcome(approval.action, { kind: "applied" }));
          return;
      }
    },
    { connection },
  );
}

// Worker BullMQ da fila `approval-apply` (5b): a API/WhatsApp valida a posse + enfileira;
// aqui o worker carrega a `approval`, valida (posse/status/run) e delega a aplicação ao
// núcleo compartilhado `applyConfirmedAction` (re-check fresco + guardrail atual + executor),
// mapeando o desfecho tipado p/ resolver a approval + empurrar o resultado no WhatsApp.
// Mesmo núcleo reusado pela escrita livre por chat (5c). Idempotente por `${approvalId}:apply`.

import { Worker } from "bullmq";
import { eq } from "drizzle-orm";
import type { Redis } from "ioredis";
import { campaignDrafts } from "@trafego/db";
import { APPROVAL_APPLY_QUEUE, type Action, type ApprovalApplyPayload, type ApprovalId, type CampaignDraftSpec } from "@trafego/shared";
import { AdsPlatformError } from "@trafego/shared/ports";
import type { WorkerDeps } from "../composition.js";
import { applyActivation } from "../modules/apply/apply-activation.js";
import { applyConfirmedAction } from "../modules/apply/apply-confirmed-action.js";
import { applyDraft } from "../modules/apply/apply-draft.js";
import { describeCreatedDraft } from "../modules/apply/draft-summary.js";
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

/** Resumo BREVE (1ª pessoa) do que foi aplicado — p/ o aviso de mudança real (S7). */
function appliedActionLine(action: Action): string {
  const name = action.target?.name ?? "a entidade";
  switch (action.type) {
    case "pause_entity":
      return `Pausei ${name}`;
    case "resume_entity":
      return `Reativei ${name}`;
    case "set_status":
      return `Mudei o status de ${name}`;
    case "adjust_budget":
      return `Ajustei o orçamento de ${name}`;
    default:
      return `Apliquei a ação em ${name}`;
  }
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
          case "created": {
            await ports.approval.resolve(approval.id, { status: "approved" });
            if (outcome.dryRun) {
              await pushOutcome("Simulei a criação (dry-run).");
              return;
            }
            const [draftRow] = await deps.db
              .select({ kind: campaignDrafts.kind, spec: campaignDrafts.spec })
              .from(campaignDrafts)
              .where(eq(campaignDrafts.id, approval.draftId))
              .limit(1);
            const summary = draftRow ? describeCreatedDraft(draftRow.kind, draftRow.spec as CampaignDraftSpec) : "sua campanha";
            // v1: creationActivation decide o desfecho — nasceu ATIVA (no ar) × PAUSADA (revisar +
            // ativar). Os DOIS avisam aqui (aviso-sempre, inclusive site).
            const lines = [
              outcome.activated
                ? `Criei ${summary} e já ATIVEI — está no ar (a Meta ainda revisa o criativo). Se precisar, dá pra pausar na plataforma.`
                : `Criei ${summary} — nasceu PAUSADA. Revise e ative na plataforma quando quiser${notifyRef ? " (ou me diz aqui que eu ativo)" : ""}.`,
            ];
            // honestidade (§eco+confirma): eu tinha prometido herdar o público que já converte,
            // mas a fonte não estava mais disponível na hora de criar — nunca fica silencioso.
            if (outcome.createdIds["targetingFallback"] === true) {
              lines.push("Obs: não consegui herdar o público que eu tinha prometido (a fonte não estava mais disponível) — usei um público amplo (Advantage+). Revise o público antes de ativar.");
            }
            await pushRealApplied(lines.join("\n\n"));
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
          case "failed":
            logger.error({ approvalId, err: outcome.error }, "approval-apply:ativação falhou");
            await pushOutcome(
              metaFailureLine(outcome.error, "Não consegui ativar agora — a Meta não respondeu. Tenta de novo em instantes."),
            );
            return;
          case "blocked":
            await ports.approval.resolve(approval.id, { status: "blocked", resolvedReason: outcome.reason });
            await pushOutcome(`Não ativei: ${outcome.reason}.`);
            return;
          case "activated":
            await ports.approval.resolve(approval.id, { status: "approved" });
            if (outcome.dryRun) await pushOutcome("Simulei a ativação (dry-run).");
            else await pushRealApplied("Ativei sua campanha — já está veiculando.");
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
          if (outcome.dryRun) await pushOutcome(`Simulei a ação${suffix} (dry-run).`);
          else await pushRealApplied(`${appliedActionLine(approval.action)}.`);
          return;
      }
    },
    { connection },
  );
}

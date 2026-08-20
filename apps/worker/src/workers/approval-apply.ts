// Worker BullMQ da fila `approval-apply` (5b): a API valida a posse + enfileira; aqui
// o worker (dono do governor/escrita) carrega a `approval`, RE-CHECA o estado fresco +
// o guardrail ATUAL e aplica via o executor. Barrado no re-check → status `blocked` +
// motivo (nunca escreve). Idempotente por `${approvalId}:apply`.

import { Worker } from "bullmq";
import { and, eq } from "drizzle-orm";
import type { Redis } from "ioredis";
import { agents, guardrailConfigs } from "@trafego/db";
import { applyGuardrails } from "@trafego/core";
import {
  APPROVAL_APPLY_QUEUE,
  toGuardrailConfig,
  type ApprovalApplyPayload,
  type ApprovalId,
} from "@trafego/shared";
import type { MutationResult } from "@trafego/shared/ports";
import type { WorkerDeps } from "../composition.js";
import { createAnalysisRepo, loadDailyToolContext } from "../modules/analysis/repo.js";
import { makeMetaToolExecutor } from "../executors/meta-tools.js";
import { createNotifyRepo } from "../modules/notify/repo.js";
import { createSendToContact } from "../modules/notify/send-to-contact.js";

/** O executor não escreveu (alvo já no estado desejado) → before == after. */
function isNoWrite(result: MutationResult): boolean {
  return JSON.stringify(result.before) === JSON.stringify(result.after);
}

export function startApprovalApplyWorker(deps: WorkerDeps, connection: Redis): Worker<ApprovalApplyPayload> {
  const { db, logger, ports } = deps;
  const repo = createAnalysisRepo(db);
  const executor = makeMetaToolExecutor(deps);
  const sendToContact = createSendToContact({ messaging: ports.messaging, repo: createNotifyRepo(db) });

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

      // conta (via agente) + token.
      const [ag] = await db
        .select({ adAccountId: agents.adAccountId })
        .from(agents)
        .where(eq(agents.id, approval.agentId))
        .limit(1);
      const account = ag ? await repo.loadAccount(orgId, ag.adAccountId) : null;
      if (!account) {
        logger.warn({ approvalId, agentId: approval.agentId }, "approval-apply:conta não encontrada");
        await ports.approval.resolve(approval.id, { status: "blocked", resolvedReason: "conta indisponível" });
        await pushOutcome("Não consegui aplicar: a conta está indisponível no momento.");
        return;
      }

      // guardrail ATUAL (config pode ter mudado desde a proposta) + contexto cross-run.
      const [guardrailRow] = await db
        .select()
        .from(guardrailConfigs)
        .where(and(eq(guardrailConfigs.agentId, approval.agentId), eq(guardrailConfigs.orgId, orgId)))
        .limit(1);
      const cfg = toGuardrailConfig(guardrailRow);
      const daily = await loadDailyToolContext(db, approval.agentId);
      const check = applyGuardrails([approval.action], cfg, {
        touchedToday: daily.touchedToday,
        budgetChangedToday: daily.budgetChangedToday,
      });
      if (check.allowed.length === 0) {
        const reason = check.dropped[0]?.reason ?? "barrada pelo guardrail";
        await ports.approval.resolve(approval.id, { status: "blocked", resolvedReason: reason });
        logger.info({ approvalId, reason }, "approval-apply:barrada no re-check");
        await pushOutcome(`Não apliquei${suffix}: ${reason}.`);
        return;
      }

      // aplica a versão CLAMPADA (o que o guardrail liberou) — re-lê fresco no executor.
      const action = check.allowed[0]!;
      const accessToken = ports.vault.decrypt(account.tokenCripto);
      const ref = { adAccountId: account.metaAdAccountId, accessToken };
      let done: Awaited<ReturnType<typeof executor.execute>>;
      try {
        done = await executor.execute({
          runId: approval.runId,
          orgId,
          account: ref,
          action,
          idempotencyKey: `${approval.id}:apply`,
          dryRun: cfg.dryRun,
        });
      } catch (err) {
        // falha da Meta (rede/rate-limit/etc): mantém a aprovação PENDENTE (dá p/ reaprovar)
        // e avisa o usuário — a promessa de "te aviso o resultado" não pode sumir (§UX).
        logger.error({ approvalId, err }, "approval-apply:execute falhou");
        await pushOutcome(`Não consegui aplicar agora${suffix} — a Meta não respondeu. Tenta de novo em instantes.`);
        return;
      }

      // escrita real que não mexeu em nada = alvo já no estado desejado → barrada honesta.
      if (!done.dryRun && isNoWrite(done.result)) {
        await ports.approval.resolve(approval.id, {
          status: "blocked",
          resolvedReason: "a entidade já estava no estado desejado",
        });
        logger.info({ approvalId }, "approval-apply:no-op (já no estado)");
        await pushOutcome(`Não precisei mexer${suffix} — já estava no estado desejado.`);
        return;
      }

      await ports.approval.resolve(approval.id, { status: "approved" });
      logger.info({ approvalId, dryRun: done.dryRun }, "approval-apply:aplicada");
      await pushOutcome(done.dryRun ? `🧪 Simulei a ação${suffix} (dry-run).` : `✅ Apliquei${suffix}.`);
    },
    { connection },
  );
}

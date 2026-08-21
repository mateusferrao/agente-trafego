// Reversão compartilhada de UMA ação por id de `agent_tool_call` (5c-1): carrega o
// tool_call org-scoped (join no run→agente, deriva a CONTA do próprio registro — não
// confia em payload), resolve token e delega ao `executor.revert` (drift + TTL da 5b).
// Extraído do worker `action-undo` p/ ser reusado pela tool `revert` do chat (5c-4).

import { and, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { agentRuns, agents, agentToolCalls } from "@trafego/db";
import type { WorkerDeps } from "../../composition.js";
import { createAnalysisRepo } from "../analysis/repo.js";
import { makeMetaToolExecutor, type RevertResult } from "../../executors/meta-tools.js";

export interface RevertByIdInput {
  readonly orgId: string;
  readonly toolCallId: string;
  /** ignora o drift ("reverter mesmo assim"). */
  readonly force?: boolean;
}

/** Reverte uma ação por id. Não-achado/conta indisponível → `reverted:false` + motivo. */
export async function revertActionById(deps: WorkerDeps, input: RevertByIdInput): Promise<RevertResult> {
  const { db, logger, ports } = deps;
  const repo = createAnalysisRepo(db);
  const executor = makeMetaToolExecutor(deps);

  // dono via run→agente (análise) OU via agentId direto (escrita por chat, runId null).
  const agViaRun = alias(agents, "ag_via_run");
  const agViaTc = alias(agents, "ag_via_tc");
  const orgOf = sql<string>`coalesce(${agViaTc.orgId}, ${agViaRun.orgId})`;
  const accountOf = sql<string>`coalesce(${agViaTc.adAccountId}, ${agViaRun.adAccountId})`;
  const [tc] = await db
    .select({
      id: agentToolCalls.id,
      runId: agentToolCalls.runId,
      beforeState: agentToolCalls.beforeState,
      args: agentToolCalls.args,
      result: agentToolCalls.result,
      adAccountId: accountOf,
    })
    .from(agentToolCalls)
    .leftJoin(agentRuns, eq(agentToolCalls.runId, agentRuns.id))
    .leftJoin(agViaRun, eq(agentRuns.agentId, agViaRun.id))
    .leftJoin(agViaTc, eq(agentToolCalls.agentId, agViaTc.id))
    .where(and(eq(agentToolCalls.id, input.toolCallId), eq(orgOf, input.orgId)))
    .limit(1);
  if (!tc) {
    logger.warn({ toolCallId: input.toolCallId, orgId: input.orgId }, "undo:tool_call não encontrado (org-scoped)");
    return { reverted: false, reason: "ação não encontrada" };
  }

  const account = await repo.loadAccount(input.orgId, tc.adAccountId);
  if (!account) {
    logger.warn({ orgId: input.orgId, adAccountId: tc.adAccountId }, "undo:conta não encontrada");
    return { reverted: false, reason: "conta indisponível" };
  }
  const accessToken = ports.vault.decrypt(account.tokenCripto);
  const ref = { adAccountId: account.metaAdAccountId, accessToken };

  return executor.revert({ orgId: input.orgId, account: ref, toolCall: tc, force: input.force ?? false });
}

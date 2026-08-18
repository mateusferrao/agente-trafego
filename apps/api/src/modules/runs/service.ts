import type { Database } from "@trafego/db";
import type { OrgId, RunId } from "@trafego/shared/types";
import type { RunSummary, RunTimeline } from "./schema.js";

export interface RunsDeps {
  readonly db: Database;
}

/**
 * Slice de runs (histórico/timeline §6/§15). Leitura da trilha de auditoria:
 * agent_runs + agent_run_steps + tool_calls. Escrita é feita pelo worker.
 */
export function createRunsService(deps: RunsDeps) {
  return {
    async list(_orgId: OrgId): Promise<RunSummary[]> {
      // TODO: select agent_runs where org_id = orgId order by started_at desc (paginado).
      void deps.db;
      return [];
    },

    async timeline(_orgId: OrgId, _runId: RunId): Promise<RunTimeline> {
      // TODO: join agent_runs + agent_run_steps (+ tool_calls) scoped por org.
      throw new Error("TODO: implementar timeline");
    },
  };
}

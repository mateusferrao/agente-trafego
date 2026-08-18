import type { Database } from "@trafego/db";
import type { AgentId, OrgId } from "@trafego/shared/types";
import type { AgentOutput, CreateAgentInput, UpdateAgentInput } from "./schema.js";

export interface AgentsDeps {
  readonly db: Database;
}

/**
 * Slice de agentes. Cria agente semeando defaults pelo arquétipo (§10) e
 * atualiza a config (persona/cadência/autonomia/guardrails/playbook/tools).
 * Superfície única: create semeia, update edita — sem wizard paralelo.
 */
export function createAgentsService(deps: AgentsDeps) {
  return {
    async get(_orgId: OrgId, _agentId: AgentId): Promise<AgentOutput> {
      // TODO: select agent scoped por org (via ad_account → org).
      void deps.db;
      throw new Error("TODO: implementar get agent");
    },

    async create(_orgId: OrgId, _input: CreateAgentInput): Promise<AgentOutput> {
      // TODO: semear config a partir do arquétipo (guardrail defaults conservadores,
      //       autonomy por origem, playbook base) + insert agent(1:1 ad_account).
      throw new Error("TODO: implementar create agent");
    },

    async update(_orgId: OrgId, _agentId: AgentId, _input: UpdateAgentInput): Promise<AgentOutput> {
      // TODO: patch parcial da config validada; reagendar cadência no SchedulerPort se mudou.
      throw new Error("TODO: implementar update agent");
    },
  };
}

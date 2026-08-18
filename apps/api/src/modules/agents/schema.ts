import { z } from "zod";
import {
  autonomyPolicySchema,
  guardrailConfigSchema,
  playbookRuleSchema,
} from "@trafego/shared/schemas";

// Config do agente (§6/§7/§10). Reusa os contratos canônicos de @trafego/shared.
export const archetype = z.enum(["conservador", "otimizador"]);

export const toolBinding = z.object({
  toolKey: z.string(),
  mode: z.enum(["off", "suggest", "auto"]),
});

export const createAgentInput = z.object({
  adAccountId: z.string().min(1),
  archetype,
  persona: z.string().optional(),
});
export type CreateAgentInput = z.infer<typeof createAgentInput>;

// PATCH parcial da superfície única de config (divulgação progressiva).
export const updateAgentInput = z
  .object({
    persona: z.string(),
    cadenceCron: z.string(),
    autonomy: autonomyPolicySchema,
    guardrails: guardrailConfigSchema,
    playbook: z.array(playbookRuleSchema),
    toolBindings: z.array(toolBinding),
    status: z.enum(["active", "paused"]),
  })
  .partial();
export type UpdateAgentInput = z.infer<typeof updateAgentInput>;

export const agentOutput = z.object({
  id: z.string(),
  adAccountId: z.string(),
  archetype,
  status: z.enum(["active", "paused"]),
});
export type AgentOutput = z.infer<typeof agentOutput>;

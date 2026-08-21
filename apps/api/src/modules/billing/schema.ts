import { z } from "zod";

// Status de acesso ao produto (mesmo enum durável de `access_grants.status`).
export const accessStatusOutput = z.object({
  status: z.enum(["pending", "active", "revoked"]),
});
export type AccessStatusOutput = z.infer<typeof accessStatusOutput>;

export const usageSummaryOutput = z.object({
  orgId: z.string(),
  period: z.string(), // "YYYY-MM"
  totalCostUsd: z.number(),
  byType: z.record(z.number()),
});
export type UsageSummaryOutput = z.infer<typeof usageSummaryOutput>;

// Custo (COGS) do owner por conta — economia unitária (6b).
export const costByAccount = z.object({
  accountId: z.string(),
  accountName: z.string().nullable(),
  costUsd: z.number(),
});

// Ponto da série temporal diária (custo do dia). `date` = "YYYY-MM-DD".
export const costDayPoint = z.object({ date: z.string(), costUsd: z.number() });

// Painel de custos do owner: janela (since/until) + total + série diária + por tipo +
// por conta + não-atribuído + cap.
export const costsOutput = z.object({
  since: z.string(), // "YYYY-MM-DD" (inclusivo)
  until: z.string(), // "YYYY-MM-DD" (inclusivo)
  totalCostUsd: z.number(),
  byDay: z.array(costDayPoint),
  byType: z.record(z.number()),
  byAccount: z.array(costByAccount),
  // custo sem run associado (chat/conversa — run_id null) → não mapeia a conta.
  unattributedCostUsd: z.number(),
  // cap de custo LLM de referência (env global; per-agente = fast-follow). 0 = sem cap.
  capUsd: z.number(),
});
export type CostsOutput = z.infer<typeof costsOutput>;

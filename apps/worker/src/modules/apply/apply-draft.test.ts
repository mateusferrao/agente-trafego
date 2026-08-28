import { describe, expect, it } from "vitest";
import { countCreationsLast24h } from "./apply-draft.js";
import type { Database } from "@trafego/db/client";

/** db fake sequencial: cada select().from().where() (sem .limit — count() é lido direto)
 *  consome UM resultado da fila, em ordem. Prova o bug (P0.4): o cap agora conta pelo
 *  APPLY-TIME real (agent_tool_calls), não pelo createdAt do rascunho, + soma o em-voo
 *  (campaign_drafts `creating`) só quando o agente NÃO está em dry-run. */
function fakeDb(rows: unknown[][]): { db: Database; calls: string[] } {
  const queue = [...rows];
  const calls: string[] = [];
  const db = {
    select: () => ({
      from: (table: { [Symbol.toPrimitive]?: () => string } | Record<string, unknown>) => ({
        where: () => {
          // registra qual tabela foi consultada (agentToolCalls tem coluna toolKey; campaignDrafts tem coluna status).
          calls.push("toolKey" in (table as Record<string, unknown>) ? "agentToolCalls" : "campaignDrafts");
          const result = queue.shift() ?? [];
          return { then: (resolve: (v: unknown) => void) => resolve(result) };
        },
      }),
    }),
  } as unknown as Database;
  return { db, calls };
}

describe("countCreationsLast24h", () => {
  it("dry-run: conta só agent_tool_calls (apply-time real), não consulta o em-voo", async () => {
    const { db, calls } = fakeDb([[{ n: 2 }]]);
    const n = await countCreationsLast24h(db, { agentId: "a1", adAccountId: "acc1", dryRun: true });
    expect(n).toBe(2);
    expect(calls).toEqual(["agentToolCalls"]);
  });

  it("soma aplicado (apply-time) + em-voo (creating do mesmo agente)", async () => {
    const { db, calls } = fakeDb([[{ n: 1 }], [{ n: 2 }]]);
    const n = await countCreationsLast24h(db, { agentId: "a1", adAccountId: "acc1", dryRun: false });
    expect(n).toBe(3);
    expect(calls).toEqual(["agentToolCalls", "campaignDrafts"]);
  });

  it("sem nenhuma criação recente nem em-voo → 0", async () => {
    const { db } = fakeDb([[], []]);
    const n = await countCreationsLast24h(db, { agentId: "a1", adAccountId: "acc1", dryRun: false });
    expect(n).toBe(0);
  });
});

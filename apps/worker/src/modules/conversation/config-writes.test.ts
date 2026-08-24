import { describe, expect, it, vi } from "vitest";
import type { WorkerDeps } from "../../composition.js";
import { applyPlaybookOp } from "./config-writes.js";

/**
 * DB falso: `select().from().where()` (min priority) resolve um array; `update`/`delete`
 * resolvem e expõem `.returning()` de uma fila; `insert().values()` captura o gravado.
 */
function makeDeps(opts: { minPriority?: number | null; updateReturns?: unknown[]; deleteReturns?: unknown[] }) {
  const captured: { inserts: Record<string, unknown>[]; updateSets: Record<string, unknown>[] } = { inserts: [], updateSets: [] };
  const updateReturns = [...(opts.updateReturns ?? [])];
  const deleteReturns = [...(opts.deleteReturns ?? [])];
  const returningNode = (queue: unknown[]) => {
    const node = Promise.resolve(undefined) as Promise<undefined> & { returning: () => Promise<unknown> };
    node.returning = () => Promise.resolve(queue.shift() ?? []);
    return node;
  };
  const db = {
    select: () => ({ from: () => ({ where: () => Promise.resolve([{ minPriority: opts.minPriority ?? null }]) }) }),
    insert: () => ({ values: async (v: Record<string, unknown>) => { captured.inserts.push(v); } }),
    update: () => ({
      set: (v: Record<string, unknown>) => {
        captured.updateSets.push(v);
        return { where: () => returningNode(updateReturns) };
      },
    }),
    delete: () => ({ where: () => returningNode(deleteReturns) }),
  };
  const deps = { db, logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn() } } as unknown as WorkerDeps;
  return { deps, captured };
}

const AGENT = "ag-1";
const ORG = "org-1";
const CONTACT = "ct-1";
const ACTOR = `contact:${CONTACT}`;

describe("applyPlaybookOp — add", () => {
  it("prioridade nova = fim da fila (min existente - 1) + insere e audita", async () => {
    const { deps, captured } = makeDeps({ minPriority: 4 });
    const res = await applyPlaybookOp(deps, {
      orgId: ORG,
      agentId: AGENT,
      actor: ACTOR,
      op: { kind: "add", rule: { scope: "ad", metric: "cpa", op: ">", value: 30, then: { type: "pause_entity" } } },
    });
    expect(res.ok).toBe(true);
    const ruleInsert = captured.inserts.find((i) => "thenActionType" in i);
    expect(ruleInsert?.priority).toBe(3);
    expect(ruleInsert?.thenActionType).toBe("pause_entity");
    // bump config_changed_at + linha de auditoria com o contato como ator.
    expect(captured.updateSets[0]?.configChangedAt).toBeDefined();
    const audit = captured.inserts.find((i) => "action" in i);
    expect(audit?.action).toBe("agent.playbook.add");
    expect(audit?.actor).toBe(ACTOR);
  });

  it("sem regra existente → prioridade 0", async () => {
    const { deps, captured } = makeDeps({ minPriority: null });
    await applyPlaybookOp(deps, {
      orgId: ORG,
      agentId: AGENT,
      actor: ACTOR,
      op: { kind: "add", rule: { scope: "ad", metric: "cpa", op: ">", value: 30, then: { type: "pause_entity" } } },
    });
    expect(captured.inserts.find((i) => "thenActionType" in i)?.priority).toBe(0);
  });
});

describe("applyPlaybookOp — toggle/remove", () => {
  it("toggle achou a regra → ok + mensagem de desligar", async () => {
    const { deps } = makeDeps({ updateReturns: [[{ id: "r1" }]] });
    const res = await applyPlaybookOp(deps, { orgId: ORG, agentId: AGENT, actor: ACTOR, op: { kind: "toggle", ruleId: "r1", enabled: false } });
    expect(res.ok).toBe(true);
    expect(res.message).toContain("Desliguei");
  });

  it("toggle não achou a regra → ok:false, mensagem honesta", async () => {
    const { deps } = makeDeps({ updateReturns: [[]] });
    const res = await applyPlaybookOp(deps, { orgId: ORG, agentId: AGENT, actor: ACTOR, op: { kind: "toggle", ruleId: "x", enabled: true } });
    expect(res.ok).toBe(false);
    expect(res.message).toContain("Não achei");
  });

  it("remove achou a regra → ok", async () => {
    const { deps } = makeDeps({ deleteReturns: [[{ id: "r2" }]] });
    const res = await applyPlaybookOp(deps, { orgId: ORG, agentId: AGENT, actor: ACTOR, op: { kind: "remove", ruleId: "r2" } });
    expect(res.ok).toBe(true);
    expect(res.message).toContain("Removi");
  });
});

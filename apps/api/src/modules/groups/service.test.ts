import { describe, expect, it, vi } from "vitest";
import type { Database } from "@trafego/db";
import type { OrgId } from "@trafego/shared/types";
import { createGroupsService } from "./service.js";

const ORG = "org-1" as OrgId;

/** Fila de `select().from().where().limit()` consumida na ORDEM em que o service chama
 *  (1º: sempre a linha de `channel_groups` OU `channel_instances`, conforme o método). */
function returningNode<T>(queue: T[]) {
  const node = Promise.resolve(undefined) as Promise<undefined> & { returning: () => Promise<T> };
  node.returning = () => Promise.resolve(queue.shift() as T);
  return node;
}

function makeDb(opts: { selectReturns?: unknown[][]; updateReturns?: unknown[] } = {}) {
  const selectQueue = [...(opts.selectReturns ?? [])];
  const updateReturns = [...(opts.updateReturns ?? [])];
  const inserts: Record<string, unknown>[] = [];
  const updateSets: Record<string, unknown>[] = [];
  const db = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => selectQueue.shift() ?? [] }) }) }),
    insert: () => ({ values: async (v: Record<string, unknown>) => { inserts.push(v); } }),
    update: () => ({
      set: (v: Record<string, unknown>) => {
        updateSets.push(v);
        return { where: () => returningNode(updateReturns) };
      },
    }),
  };
  return { db: db as unknown as Database, inserts, updateSets };
}

describe("groups.list", () => {
  it("canal conectado + grupo ativo → lista os grupos do número + activeGroupJid", async () => {
    const { db } = makeDb({ selectReturns: [[{ groupJid: "g1@g.us", status: "active" }], [{ evolutionInstance: "org-abc" }]] });
    const listGroups = vi.fn(async () => [{ jid: "g1@g.us", name: "Sala", size: 3 }, { jid: "g2@g.us", name: null }]);
    const service = createGroupsService({ db, messaging: { listGroups } as never });

    const res = await service.list(ORG);

    expect(res).toEqual({
      channelConnected: true,
      groups: [{ jid: "g1@g.us", name: "Sala", size: 3 }, { jid: "g2@g.us", name: null }],
      activeGroupJid: "g1@g.us",
    });
    expect(listGroups).toHaveBeenCalledWith({ instanceId: "org-abc" });
  });

  it("grupo registrado mas DESLIGADO (status disabled) → activeGroupJid null", async () => {
    const { db } = makeDb({ selectReturns: [[{ groupJid: "g1@g.us", status: "disabled" }], [{ evolutionInstance: "org-abc" }]] });
    const service = createGroupsService({ db, messaging: { listGroups: vi.fn(async () => []) } as never });

    const res = await service.list(ORG);

    expect(res.activeGroupJid).toBeNull();
  });

  it("sem canal conectado → channelConnected:false, groups:[], mas mantém activeGroupJid do DB", async () => {
    const { db } = makeDb({ selectReturns: [[{ groupJid: "g1@g.us", status: "active" }], []] });
    const listGroups = vi.fn();
    const service = createGroupsService({ db, messaging: { listGroups } as never });

    const res = await service.list(ORG);

    expect(res).toEqual({ channelConnected: false, groups: [], activeGroupJid: "g1@g.us" });
    expect(listGroups).not.toHaveBeenCalled();
  });

  it("sem grupo nenhum registrado → activeGroupJid null", async () => {
    const { db } = makeDb({ selectReturns: [[], [{ evolutionInstance: "org-abc" }]] });
    const service = createGroupsService({ db, messaging: { listGroups: vi.fn(async () => []) } as never });

    const res = await service.list(ORG);

    expect(res.activeGroupJid).toBeNull();
  });
});

describe("groups.set", () => {
  it("sem canal conectado → erro amigável (não deixa escolher grupo sem número)", async () => {
    const { db } = makeDb({ selectReturns: [[]] });
    const service = createGroupsService({ db, messaging: {} as never });

    await expect(service.set(ORG, { groupJid: "g1@g.us" })).rejects.toThrow(/conecte o whatsapp/i);
  });

  it("primeira vez (sem linha existente) → INSERT com status active", async () => {
    const { db, inserts } = makeDb({ selectReturns: [[{ evolutionInstance: "org-abc" }], []] });
    const service = createGroupsService({ db, messaging: {} as never });

    const res = await service.set(ORG, { groupJid: "g1@g.us", name: "Sala de Guerra" });

    expect(res).toEqual({ active: true, groupJid: "g1@g.us", name: "Sala de Guerra" });
    expect(inserts[0]).toMatchObject({ orgId: ORG, evolutionInstance: "org-abc", groupJid: "g1@g.us", name: "Sala de Guerra", status: "active" });
  });

  it("já existe linha → UPDATE (não duplica), reativa se estava desligada", async () => {
    const { db, inserts, updateSets } = makeDb({ selectReturns: [[{ evolutionInstance: "org-abc" }], [{ id: "grp-1" }]] });
    const service = createGroupsService({ db, messaging: {} as never });

    await service.set(ORG, { groupJid: "g2@g.us" });

    expect(inserts).toHaveLength(0);
    expect(updateSets[0]).toMatchObject({ evolutionInstance: "org-abc", groupJid: "g2@g.us", name: null, status: "active" });
  });
});

describe("groups.disable", () => {
  it("desliga (soft) e devolve o estado — mantém o registro pra reativar depois", async () => {
    const { db, updateSets } = makeDb({ updateReturns: [[{ groupJid: "g1@g.us", name: "Sala" }]] });
    const service = createGroupsService({ db, messaging: {} as never });

    const res = await service.disable(ORG);

    expect(res).toEqual({ active: false, groupJid: "g1@g.us", name: "Sala" });
    expect(updateSets[0]).toEqual({ status: "disabled" });
  });
});

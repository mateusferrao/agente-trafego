import { describe, expect, it, vi } from "vitest";
import type { OrgsRepo } from "./repo.js";
import { createOrgsService } from "./service.js";

const TZ = "America/Sao_Paulo";
function makeRepo(overrides: Partial<OrgsRepo> = {}): OrgsRepo {
  return {
    listForUser: vi.fn(async () => [{ id: "o1", name: "Org", role: "owner" as const, timezone: TZ }]),
    createWithOwner: vi.fn(async () => ({ id: "o2", name: "Nova", role: "owner" as const, timezone: TZ })),
    findMembershipRole: vi.fn(async () => "owner" as const),
    rename: vi.fn(async () => ({ id: "o1", name: "Renomeada", timezone: TZ })),
    setTimezone: vi.fn(async () => ({ id: "o1", name: "Org", timezone: TZ })),
    findById: vi.fn(async () => ({ id: "o1", name: "Org", timezone: TZ })),
    getMarketReference: vi.fn(async () => null),
    setMarketReference: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("orgsService", () => {
  it("listForUser delega ao repo", async () => {
    const repo = makeRepo();
    const service = createOrgsService({ repo });
    expect(await service.listForUser("u1")).toEqual([{ id: "o1", name: "Org", role: "owner", timezone: "America/Sao_Paulo" }]);
    expect(repo.listForUser).toHaveBeenCalledWith("u1");
  });

  it("create cria org com owner", async () => {
    const repo = makeRepo();
    const service = createOrgsService({ repo });
    const org = await service.create("u1", { name: "Nova" });
    expect(org).toEqual({ id: "o2", name: "Nova", role: "owner", timezone: "America/Sao_Paulo" });
    expect(repo.createWithOwner).toHaveBeenCalledWith("u1", "Nova");
  });

  it("membershipRole devolve null p/ não-membro", async () => {
    const repo = makeRepo({ findMembershipRole: vi.fn(async () => null) });
    const service = createOrgsService({ repo });
    expect(await service.membershipRole("u1", "o9")).toBeNull();
  });

  it("rename delega ao repo e compõe o papel quando o user é owner", async () => {
    const repo = makeRepo();
    const service = createOrgsService({ repo });
    const org = await service.rename("u1", "o1", { name: "Renomeada" });
    expect(org).toEqual({ id: "o1", name: "Renomeada", role: "owner", timezone: "America/Sao_Paulo" });
    expect(repo.rename).toHaveBeenCalledWith("o1", "Renomeada");
  });

  it("rename barra quem não é owner (member)", async () => {
    const repo = makeRepo({ findMembershipRole: vi.fn(async () => "member" as const) });
    const service = createOrgsService({ repo });
    await expect(service.rename("u1", "o1", { name: "X" })).rejects.toThrow();
    expect(repo.rename).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from "vitest";
import type { OrgsRepo } from "./repo.js";
import { createOrgsService } from "./service.js";

function makeRepo(overrides: Partial<OrgsRepo> = {}): OrgsRepo {
  return {
    listForUser: vi.fn(async () => [{ id: "o1", name: "Org", role: "owner" as const }]),
    createWithOwner: vi.fn(async () => ({ id: "o2", name: "Nova", role: "owner" as const })),
    findMembershipRole: vi.fn(async () => "owner" as const),
    ...overrides,
  };
}

describe("orgsService", () => {
  it("listForUser delega ao repo", async () => {
    const repo = makeRepo();
    const service = createOrgsService({ repo });
    expect(await service.listForUser("u1")).toEqual([{ id: "o1", name: "Org", role: "owner" }]);
    expect(repo.listForUser).toHaveBeenCalledWith("u1");
  });

  it("create cria org com owner", async () => {
    const repo = makeRepo();
    const service = createOrgsService({ repo });
    const org = await service.create("u1", { name: "Nova" });
    expect(org).toEqual({ id: "o2", name: "Nova", role: "owner" });
    expect(repo.createWithOwner).toHaveBeenCalledWith("u1", "Nova");
  });

  it("membershipRole devolve null p/ não-membro", async () => {
    const repo = makeRepo({ findMembershipRole: vi.fn(async () => null) });
    const service = createOrgsService({ repo });
    expect(await service.membershipRole("u1", "o9")).toBeNull();
  });
});

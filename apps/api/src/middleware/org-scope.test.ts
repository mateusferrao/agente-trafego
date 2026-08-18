import { describe, expect, it, vi } from "vitest";
import type { FastifyRequest } from "fastify";
import { orgIdOf, requireOrgScope, resolveBusinessScope } from "./org-scope.js";

/** Request falso com um membershipRole configurável no container. */
function reqWith(opts: {
  userId?: string | undefined;
  orgId?: string | undefined;
  role?: "owner" | "member" | null;
}): { request: FastifyRequest; membershipRole: ReturnType<typeof vi.fn> } {
  const membershipRole = vi.fn(async () => opts.role ?? null);
  const request = {
    userId: opts.userId,
    orgId: opts.orgId,
    server: { container: { services: { orgs: { membershipRole } } } },
  } as unknown as FastifyRequest;
  return { request, membershipRole };
}

describe("requireOrgScope", () => {
  it("passa quando o user é membro da org ativa", async () => {
    const { request, membershipRole } = reqWith({ userId: "u1", orgId: "o1", role: "owner" });
    await expect(requireOrgScope(request, {} as never)).resolves.toBeUndefined();
    expect(membershipRole).toHaveBeenCalledWith("u1", "o1");
  });

  it("403 quando o user NÃO tem membership na org (isolamento de tenant)", async () => {
    const { request } = reqWith({ userId: "u1", orgId: "o-alheia", role: null });
    await expect(requireOrgScope(request, {} as never)).rejects.toMatchObject({ statusCode: 403 });
  });

  it("403 sem org ativa", async () => {
    const { request } = reqWith({ userId: "u1", orgId: undefined });
    await expect(requireOrgScope(request, {} as never)).rejects.toMatchObject({ statusCode: 403 });
  });

  it("401 sem user", async () => {
    const { request } = reqWith({ userId: undefined, orgId: "o1" });
    await expect(requireOrgScope(request, {} as never)).rejects.toMatchObject({ statusCode: 401 });
  });
});

describe("resolveBusinessScope", () => {
  it("sem candidate usa a org ativa (validada)", async () => {
    const { request } = reqWith({ userId: "u1", orgId: "o1", role: "member" });
    expect(await resolveBusinessScope(request)).toBe("o1");
  });

  it("com candidate válido (membro) devolve o candidate", async () => {
    const { request, membershipRole } = reqWith({ userId: "u1", orgId: "o1", role: "owner" });
    expect(await resolveBusinessScope(request, "o2")).toBe("o2");
    expect(membershipRole).toHaveBeenCalledWith("u1", "o2");
  });

  it("403 quando candidate não é do user (bloqueia troca de tenant)", async () => {
    const { request } = reqWith({ userId: "u1", orgId: "o1", role: null });
    await expect(resolveBusinessScope(request, "o-alheia")).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe("orgIdOf", () => {
  it("devolve o orgId quando resolvido", () => {
    const request = { orgId: "o1" } as unknown as FastifyRequest;
    expect(orgIdOf(request)).toBe("o1");
  });
  it("falha quando ausente", () => {
    const request = {} as unknown as FastifyRequest;
    expect(() => orgIdOf(request)).toThrow();
  });
});

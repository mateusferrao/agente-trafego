import { describe, expect, it, vi } from "vitest";
import type { PasswordHasher } from "./password.js";
import type { AuthRepo, PrincipalRow, UserRow } from "./repo.js";
import { hashSessionToken } from "./session-token.js";
import { createAuthService } from "./service.js";

const CTX = { ipAddress: "1.2.3.4", userAgent: "vitest" };

const PRINCIPAL: PrincipalRow = {
  userId: "u1",
  email: "a@b.com",
  name: "Ana",
  orgId: "o1",
  orgName: "Org",
  role: "owner",
  accessStatus: "pending",
};

const USER: UserRow = { id: "u1", email: "a@b.com", name: "Ana", passwordHash: "HASH" };

function makeRepo(overrides: Partial<AuthRepo> = {}): AuthRepo {
  return {
    findUserByEmail: vi.fn(async () => null),
    createUserWithOrg: vi.fn(async () => ({
      userId: "u1",
      orgId: "o1",
      orgName: "Org",
      role: "owner" as const,
      accessStatus: "pending" as const,
    })),
    loadPrincipal: vi.fn(async () => PRINCIPAL),
    createSession: vi.fn(async () => undefined),
    findActiveSessionByHash: vi.fn(async () => null),
    slideSession: vi.fn(async () => undefined),
    revokeSession: vi.fn(async () => undefined),
    ...overrides,
  };
}

function makeHasher(verifyResult = true): PasswordHasher {
  return {
    hash: vi.fn(async (p: string) => `hashed:${p}`),
    verify: vi.fn(async () => verifyResult),
  };
}

describe("authService.signup", () => {
  it("cria user+org+session e devolve MeOutput + token opaco", async () => {
    const repo = makeRepo();
    const hasher = makeHasher();
    const service = createAuthService({ repo, hasher });

    const out = await service.signup(
      { name: "Ana", email: "a@b.com", password: "s3nhaforte", orgName: "Org" },
      CTX,
    );

    expect(hasher.hash).toHaveBeenCalledWith("s3nhaforte");
    expect(repo.createUserWithOrg).toHaveBeenCalledWith({
      email: "a@b.com",
      name: "Ana",
      passwordHash: "hashed:s3nhaforte",
      orgName: "Org",
    });
    expect(repo.createSession).toHaveBeenCalledOnce();
    // token opaco (não é o hash) — o DB guarda o hash do que voltou.
    const created = (repo.createSession as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(created.tokenHash).toBe(hashSessionToken(out.rawToken));
    expect(created.ipAddress).toBe("1.2.3.4");
    expect(out.me).toMatchObject({ userId: "u1", orgId: "o1", role: "owner", accessStatus: "pending" });
  });

  it("409 quando o email já existe (não cria nada)", async () => {
    const repo = makeRepo({ findUserByEmail: vi.fn(async () => USER) });
    const service = createAuthService({ repo, hasher: makeHasher() });

    await expect(
      service.signup({ name: "X", email: "a@b.com", password: "s3nhaforte", orgName: "O" }, CTX),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(repo.createUserWithOrg).not.toHaveBeenCalled();
    expect(repo.createSession).not.toHaveBeenCalled();
  });
});

describe("authService.login", () => {
  it("cria sessão quando a senha confere", async () => {
    const repo = makeRepo({ findUserByEmail: vi.fn(async () => USER) });
    const hasher = makeHasher(true);
    const service = createAuthService({ repo, hasher });

    const out = await service.login({ email: "a@b.com", password: "s3nhaforte" }, CTX);

    expect(hasher.verify).toHaveBeenCalledWith("HASH", "s3nhaforte");
    expect(repo.createSession).toHaveBeenCalledOnce();
    expect(out.me).toMatchObject({ userId: "u1", email: "a@b.com" });
  });

  it("401 quando o email não existe (ainda roda um verify — anti-timing)", async () => {
    const repo = makeRepo({ findUserByEmail: vi.fn(async () => null) });
    const hasher = makeHasher(false);
    const service = createAuthService({ repo, hasher });

    await expect(service.login({ email: "no@b.com", password: "x123456789" }, CTX)).rejects.toMatchObject({
      statusCode: 401,
    });
    expect(hasher.verify).toHaveBeenCalledOnce(); // verificou contra o dummy
    expect(repo.createSession).not.toHaveBeenCalled();
  });

  it("401 quando a senha está errada", async () => {
    const repo = makeRepo({ findUserByEmail: vi.fn(async () => USER) });
    const service = createAuthService({ repo, hasher: makeHasher(false) });

    await expect(service.login({ email: "a@b.com", password: "errada123" }, CTX)).rejects.toMatchObject({
      statusCode: 401,
    });
    expect(repo.createSession).not.toHaveBeenCalled();
  });
});

describe("authService.logout / resolveSession", () => {
  it("logout revoga pelo hash do token", async () => {
    const repo = makeRepo();
    const service = createAuthService({ repo, hasher: makeHasher() });
    await service.logout("raw-token-abc");
    expect(repo.revokeSession).toHaveBeenCalledWith(hashSessionToken("raw-token-abc"));
  });

  it("resolveSession devolve principal e desliza quando o último uso é antigo", async () => {
    const repo = makeRepo({
      // lastUsedAt bem no passado → passa do throttle → desliza.
      findActiveSessionByHash: vi.fn(async () => ({
        userId: "u1",
        orgId: "o1",
        lastUsedAt: new Date(0),
      })),
    });
    const service = createAuthService({ repo, hasher: makeHasher() });

    const res = await service.resolveSession("raw-token-abc");

    expect(res).toEqual({ userId: "u1", orgId: "o1" });
    expect(repo.slideSession).toHaveBeenCalledOnce();
  });

  it("resolveSession NÃO desliza quando usada há pouco (throttle)", async () => {
    const repo = makeRepo({
      findActiveSessionByHash: vi.fn(async () => ({
        userId: "u1",
        orgId: "o1",
        lastUsedAt: new Date(), // agora → dentro do throttle
      })),
    });
    const service = createAuthService({ repo, hasher: makeHasher() });

    const res = await service.resolveSession("raw-token-abc");

    expect(res).toEqual({ userId: "u1", orgId: "o1" });
    expect(repo.slideSession).not.toHaveBeenCalled();
  });

  it("resolveSession devolve null quando não há sessão ativa (revogada/expirada)", async () => {
    const repo = makeRepo({ findActiveSessionByHash: vi.fn(async () => null) });
    const service = createAuthService({ repo, hasher: makeHasher() });

    expect(await service.resolveSession("qualquer")).toBeNull();
    expect(repo.slideSession).not.toHaveBeenCalled();
  });
});

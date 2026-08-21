import { describe, expect, it, vi } from "vitest";
import type { MailQueuePort } from "@trafego/shared/ports";
import type { PasswordHasher } from "./password.js";
import type { AuthRepo, PrincipalRow, UserRow } from "./repo.js";
import { hashSessionToken } from "./session-token.js";
import { hashEmailCode } from "./one-time-token.js";
import { createAuthService, type AuthDeps } from "./service.js";

const CTX = { ipAddress: "1.2.3.4", userAgent: "vitest" };
const NOW = () => new Date("2026-08-21T12:00:00Z");

const PRINCIPAL: PrincipalRow = {
  userId: "u1",
  email: "a@b.com",
  name: "Ana",
  orgId: "o1",
  orgName: "Org",
  role: "owner",
  accessStatus: "pending",
};

const VERIFIED: UserRow = {
  id: "u1",
  email: "a@b.com",
  name: "Ana",
  passwordHash: "HASH",
  emailVerifiedAt: new Date("2026-08-01T00:00:00Z"),
};
const UNVERIFIED: UserRow = { ...VERIFIED, emailVerifiedAt: null };

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
    issueOneTimeToken: vi.fn(async () => undefined),
    findUsableToken: vi.fn(async () => null),
    consumeOneTimeToken: vi.fn(async () => true),
    markEmailVerified: vi.fn(async () => undefined),
    ...overrides,
  };
}

function makeHasher(verifyResult = true): PasswordHasher {
  return {
    hash: vi.fn(async (p: string) => `hashed:${p}`),
    verify: vi.fn(async () => verifyResult),
  };
}

function makeMailQueue(): MailQueuePort {
  return { enqueue: vi.fn(async () => undefined) };
}

function makeService(repo: AuthRepo, hasher = makeHasher(), mailQueue = makeMailQueue()) {
  const deps: AuthDeps = {
    repo,
    hasher,
    mailQueue,
    email: { from: "no-reply@x.co", appUrl: "http://app", codeTtlMinutes: 15, resetTtlMinutes: 60 },
    now: NOW,
  };
  return { service: createAuthService(deps), mailQueue };
}

describe("authService.signup (6b: não autentica, manda código)", () => {
  it("cria user+org, emite código e NÃO cria sessão", async () => {
    const repo = makeRepo();
    const { service, mailQueue } = makeService(repo, makeHasher());

    const out = await service.signup({ name: "Ana", email: "a@b.com", password: "s3nhaforte", orgName: "Org" });

    expect(out).toEqual({ pendingVerification: true });
    expect(repo.createUserWithOrg).toHaveBeenCalledOnce();
    expect(repo.issueOneTimeToken).toHaveBeenCalledOnce();
    expect(mailQueue.enqueue).toHaveBeenCalledOnce();
    expect(repo.createSession).not.toHaveBeenCalled();
  });

  it("email já existente → resposta idêntica + email 'conta existe', sem criar nada", async () => {
    const repo = makeRepo({ findUserByEmail: vi.fn(async () => VERIFIED) });
    const { service, mailQueue } = makeService(repo);

    const out = await service.signup({ name: "X", email: "a@b.com", password: "s3nhaforte", orgName: "O" });

    expect(out).toEqual({ pendingVerification: true });
    expect(repo.createUserWithOrg).not.toHaveBeenCalled();
    expect(mailQueue.enqueue).toHaveBeenCalledOnce(); // aviso "conta existe"
  });

  it("senha fraca → 400 (não cria)", async () => {
    const repo = makeRepo();
    const { service } = makeService(repo);
    await expect(
      service.signup({ name: "A", email: "a@b.com", password: "semnumero", orgName: "Org" }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(repo.createUserWithOrg).not.toHaveBeenCalled();
  });
});

describe("authService.login (6b: bloqueia não-verificado)", () => {
  it("verificado + senha ok → sessão", async () => {
    const repo = makeRepo({ findUserByEmail: vi.fn(async () => VERIFIED) });
    const { service } = makeService(repo, makeHasher(true));
    const out = await service.login({ email: "a@b.com", password: "s3nhaforte" }, CTX);
    expect(repo.createSession).toHaveBeenCalledOnce();
    expect(out.me).toMatchObject({ userId: "u1" });
  });

  it("não-verificado → 403 auth_email_not_verified + reenvia código", async () => {
    const repo = makeRepo({ findUserByEmail: vi.fn(async () => UNVERIFIED) });
    const { service, mailQueue } = makeService(repo, makeHasher(true));
    await expect(service.login({ email: "a@b.com", password: "s3nhaforte" }, CTX)).rejects.toMatchObject({
      statusCode: 403,
      code: "auth_email_not_verified",
    });
    expect(mailQueue.enqueue).toHaveBeenCalledOnce();
    expect(repo.createSession).not.toHaveBeenCalled();
  });

  it("senha errada → 401", async () => {
    const repo = makeRepo({ findUserByEmail: vi.fn(async () => VERIFIED) });
    const { service } = makeService(repo, makeHasher(false));
    await expect(service.login({ email: "a@b.com", password: "errada123" }, CTX)).rejects.toMatchObject({
      statusCode: 401,
    });
  });
});

describe("authService.verifyEmailCode", () => {
  it("código válido → consome, marca verificado e cria sessão", async () => {
    const repo = makeRepo({
      findUsableToken: vi.fn(async () => ({ id: "t1", userId: "u1", email: "a@b.com" })),
    });
    const { service } = makeService(repo);

    const out = await service.verifyEmailCode({ email: "a@b.com", code: "123456" }, CTX);

    expect(repo.findUsableToken).toHaveBeenCalledWith(
      "email_verification",
      hashEmailCode("a@b.com", "123456"),
      NOW(),
    );
    expect(repo.consumeOneTimeToken).toHaveBeenCalledWith("t1");
    expect(repo.markEmailVerified).toHaveBeenCalledWith("u1");
    expect(repo.createSession).toHaveBeenCalledOnce();
    expect(out.me).toMatchObject({ userId: "u1" });
  });

  it("código inexistente/expirado → 400", async () => {
    const repo = makeRepo({ findUsableToken: vi.fn(async () => null) });
    const { service } = makeService(repo);
    await expect(service.verifyEmailCode({ email: "a@b.com", code: "000000" }, CTX)).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("perde a corrida no consume → 400 (não cria sessão)", async () => {
    const repo = makeRepo({
      findUsableToken: vi.fn(async () => ({ id: "t1", userId: "u1", email: "a@b.com" })),
      consumeOneTimeToken: vi.fn(async () => false),
    });
    const { service } = makeService(repo);
    await expect(service.verifyEmailCode({ email: "a@b.com", code: "123456" }, CTX)).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(repo.createSession).not.toHaveBeenCalled();
  });
});

describe("authService.requestEmailCode (anti-enum)", () => {
  it("user não-verificado → emite código", async () => {
    const repo = makeRepo({ findUserByEmail: vi.fn(async () => UNVERIFIED) });
    const { service, mailQueue } = makeService(repo);
    await service.requestEmailCode({ email: "a@b.com" });
    expect(mailQueue.enqueue).toHaveBeenCalledOnce();
  });

  it("email inexistente → resolve em silêncio (não vaza)", async () => {
    const repo = makeRepo({ findUserByEmail: vi.fn(async () => null) });
    const { service, mailQueue } = makeService(repo);
    await service.requestEmailCode({ email: "no@b.com" });
    expect(mailQueue.enqueue).not.toHaveBeenCalled();
  });
});

describe("authService.logout / resolveSession", () => {
  it("logout revoga pelo hash do token", async () => {
    const repo = makeRepo();
    const { service } = makeService(repo);
    await service.logout("raw-token-abc");
    expect(repo.revokeSession).toHaveBeenCalledWith(hashSessionToken("raw-token-abc"));
  });

  it("resolveSession desliza quando o último uso é antigo", async () => {
    const repo = makeRepo({
      findActiveSessionByHash: vi.fn(async () => ({ userId: "u1", orgId: "o1", lastUsedAt: new Date(0) })),
    });
    const { service } = makeService(repo);
    const res = await service.resolveSession("raw-token-abc");
    expect(res).toEqual({ userId: "u1", orgId: "o1" });
    expect(repo.slideSession).toHaveBeenCalledOnce();
  });

  it("resolveSession null quando não há sessão ativa", async () => {
    const repo = makeRepo({ findActiveSessionByHash: vi.fn(async () => null) });
    const { service } = makeService(repo);
    expect(await service.resolveSession("qualquer")).toBeNull();
  });
});

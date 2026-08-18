import { describe, expect, it } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import { buildAuditEntry } from "./audit.js";

function req(opts: {
  method?: string;
  orgId?: string | undefined;
  userId?: string | undefined;
  url?: string;
  ip?: string;
}): FastifyRequest {
  return {
    method: opts.method ?? "POST",
    orgId: opts.orgId,
    userId: opts.userId,
    ip: opts.ip ?? "1.2.3.4",
    url: opts.url ?? "/api/x",
    routeOptions: { url: opts.url ?? "/api/x" },
  } as unknown as FastifyRequest;
}
const reply = (statusCode: number): FastifyReply => ({ statusCode }) as unknown as FastifyReply;

describe("buildAuditEntry", () => {
  it("gera entrada p/ write org-scoped 2xx", () => {
    const entry = buildAuditEntry(
      req({ method: "POST", orgId: "o1", userId: "u1", url: "/api/orgs" }),
      reply(201),
    );
    expect(entry).toEqual({
      orgId: "o1",
      actor: "user",
      actorUserId: "u1",
      action: "POST /api/orgs",
      metadata: { statusCode: 201, ip: "1.2.3.4" },
    });
  });

  it("null para leitura (GET)", () => {
    expect(buildAuditEntry(req({ method: "GET", orgId: "o1" }), reply(200))).toBeNull();
  });

  it("null para resposta de erro (>=400)", () => {
    expect(buildAuditEntry(req({ orgId: "o1" }), reply(403))).toBeNull();
  });

  it("null para write sem tenant (auth — sem orgId)", () => {
    expect(buildAuditEntry(req({ orgId: undefined, userId: "u1" }), reply(200))).toBeNull();
  });

  it("actor=system quando não há user", () => {
    const entry = buildAuditEntry(req({ orgId: "o1", userId: undefined }), reply(200));
    expect(entry).toMatchObject({ actor: "system", actorUserId: null });
  });
});

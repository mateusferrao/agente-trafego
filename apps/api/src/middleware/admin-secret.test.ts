import { describe, expect, it } from "vitest";
import type { FastifyRequest } from "fastify";
import { makeRequireAdminSecret, ADMIN_SECRET_HEADER } from "./admin-secret.js";

const SECRET = "s3cr3t";
const guard = makeRequireAdminSecret(SECRET);

function reqWith(headerValue: string | undefined): FastifyRequest {
  return { headers: { [ADMIN_SECRET_HEADER]: headerValue } } as unknown as FastifyRequest;
}

describe("makeRequireAdminSecret", () => {
  it("passa quando o header bate com o segredo", async () => {
    await expect(guard(reqWith(SECRET))).resolves.toBeUndefined();
  });

  it("rejeita (401) quando o header falta", async () => {
    await expect(guard(reqWith(undefined))).rejects.toMatchObject({ statusCode: 401 });
  });

  it("rejeita (401) quando o segredo está errado", async () => {
    await expect(guard(reqWith("errado"))).rejects.toMatchObject({ statusCode: 401 });
  });
});

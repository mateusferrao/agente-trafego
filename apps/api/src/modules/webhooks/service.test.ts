import { describe, expect, it, vi } from "vitest";
import { WHATSAPP_INBOUND_QUEUE } from "@trafego/shared";
import { createWebhooksService } from "./service.js";

/** db falso: a query é sempre `select().from().where().limit(1)` → devolve `rows`. */
function fakeDb(rows: unknown[]) {
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    limit: async () => rows,
  };
  return chain as never;
}

function makeService(rows: unknown[]) {
  const enqueue = vi.fn(async (_spec: { queue: string; name: string; payload: unknown }) => {});
  const service = createWebhooksService({ db: fakeDb(rows), scheduler: { enqueue } as never });
  return { service, enqueue };
}

const INSTANCE = "org-123";
const SECRET = "s3cr3t-abc";
const PAYLOAD = { event: "MESSAGES_UPSERT", data: {} };

describe("createWebhooksService.handleEvolutionInbound", () => {
  it("secret correto → enfileira o payload cru e aceita", async () => {
    const { service, enqueue } = makeService([{ webhookSecret: SECRET }]);
    const res = await service.handleEvolutionInbound(INSTANCE, SECRET, PAYLOAD);
    expect(res).toEqual({ accepted: true });
    expect(enqueue).toHaveBeenCalledOnce();
    const spec = enqueue.mock.calls[0]![0] as { queue: string; payload: unknown };
    expect(spec.queue).toBe(WHATSAPP_INBOUND_QUEUE);
    expect(spec.payload).toEqual({ instanceId: INSTANCE, raw: PAYLOAD });
  });

  it("secret divergente → 401 e não enfileira", async () => {
    const { service, enqueue } = makeService([{ webhookSecret: SECRET }]);
    await expect(service.handleEvolutionInbound(INSTANCE, "errado", PAYLOAD)).rejects.toThrow();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("instância desconhecida → 401 e não enfileira", async () => {
    const { service, enqueue } = makeService([]);
    await expect(service.handleEvolutionInbound(INSTANCE, SECRET, PAYLOAD)).rejects.toThrow();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("secret ausente (header não-string) → 401", async () => {
    const { service, enqueue } = makeService([{ webhookSecret: SECRET }]);
    await expect(service.handleEvolutionInbound(INSTANCE, undefined, PAYLOAD)).rejects.toThrow();
    expect(enqueue).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from "vitest";
import { loadGroupParticipantsMap } from "./group-participants-cache.js";

const INSTANCE = { instanceId: "org-1" };
const GROUP_JID = "120363427920375586@g.us";
const MAP = { "95529518235847@lid": "+5531953479261" };

function makeDeps(cached: string | null = null) {
  const redis = { get: vi.fn(async () => cached), set: vi.fn(async () => "OK" as const) };
  const messaging = { resolveGroupParticipants: vi.fn(async () => MAP) };
  return { deps: { redis, messaging, ttlSec: 3600 } as never, redis, messaging };
}

describe("loadGroupParticipantsMap", () => {
  it("cache miss: busca na Evolution e grava no cache com TTL", async () => {
    const { deps, redis, messaging } = makeDeps(null);

    const result = await loadGroupParticipantsMap(deps, INSTANCE, GROUP_JID);

    expect(result).toEqual(MAP);
    expect(messaging.resolveGroupParticipants).toHaveBeenCalledWith(INSTANCE, GROUP_JID);
    expect(redis.set).toHaveBeenCalledWith(`evo:group-participants:${GROUP_JID}`, JSON.stringify(MAP), "EX", 3600);
  });

  it("cache hit: devolve do Redis sem chamar a Evolution", async () => {
    const { deps, messaging } = makeDeps(JSON.stringify(MAP));

    const result = await loadGroupParticipantsMap(deps, INSTANCE, GROUP_JID);

    expect(result).toEqual(MAP);
    expect(messaging.resolveGroupParticipants).not.toHaveBeenCalled();
  });

  it("cache corrompido (JSON inválido) → refresh na Evolution", async () => {
    const { deps, messaging } = makeDeps("{not json");

    const result = await loadGroupParticipantsMap(deps, INSTANCE, GROUP_JID);

    expect(result).toEqual(MAP);
    expect(messaging.resolveGroupParticipants).toHaveBeenCalled();
  });
});

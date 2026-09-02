import { describe, expect, it } from "vitest";
import { snapshotToRunLearning } from "./repo.js";

describe("snapshotToRunLearning", () => {
  const at = new Date("2026-02-01T00:00:00.000Z");

  it("mapeia cards por-campanha (tier + healthSignals)", () => {
    const snap = {
      campaigns: [{ externalId: "c1", name: "Camp 1", tier: "performer", healthSignals: ["creative_fatigue"] }],
    };
    const out = snapshotToRunLearning("r1", at, snap);
    expect(out.campaigns).toEqual([
      { externalId: "c1", name: "Camp 1", tier: "performer", healthSignals: ["creative_fatigue"] },
    ]);
    expect(out.trackingSuspect).toBe(false);
  });

  it("captura zumbi SÓ-RESUMIDO (ausente dos cards) a partir de waste.zombies", () => {
    const snap = {
      campaigns: [{ externalId: "c1", name: "Camp 1", tier: "performer" }],
      waste: { totalSpend: 100, wastedSpend: 40, wastedPct: 40, zombies: [{ id: "cZ", name: "Zumbi Silencioso", spend: 40 }] },
    };
    const out = snapshotToRunLearning("r1", at, snap);
    const zombie = out.campaigns.find((c) => c.externalId === "cZ");
    expect(zombie).toEqual({ externalId: "cZ", name: "Zumbi Silencioso", tier: "zombie" });
  });

  it("não sobrescreve o tier de um card existente com o de waste.zombies", () => {
    const snap = {
      campaigns: [{ externalId: "c1", name: "Camp 1", tier: "winner" }],
      waste: { totalSpend: 100, wastedSpend: 10, wastedPct: 10, zombies: [{ id: "c1", name: "Camp 1", spend: 10 }] },
    };
    const out = snapshotToRunLearning("r1", at, snap);
    expect(out.campaigns.find((c) => c.externalId === "c1")?.tier).toBe("winner");
  });

  it("trackingSuspect vem do trackingHealth.suspect", () => {
    const out = snapshotToRunLearning("r1", at, { campaigns: [], trackingHealth: { suspect: true } });
    expect(out.trackingSuspect).toBe(true);
  });

  it("snapshot nulo → sem campanhas, sem suspeita", () => {
    const out = snapshotToRunLearning("r1", at, null);
    expect(out.campaigns).toEqual([]);
    expect(out.trackingSuspect).toBe(false);
  });
});

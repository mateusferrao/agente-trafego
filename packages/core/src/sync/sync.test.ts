import { describe, expect, it } from "vitest";
import { planSyncWindow } from "./index.js";

// today fixo (injetado) → determinístico. retention=30, refetch=7 nos casos abaixo.
const TODAY = "2026-08-18";

describe("planSyncWindow", () => {
  it("1º sync (sem snapshot) → busca a retenção inteira", () => {
    const w = planSyncWindow({
      today: TODAY,
      latestSnapshotDate: null,
      refetchWindowDays: 7,
      retentionDays: 30,
    });
    // 2026-08-18 menos 29 dias = 2026-07-20
    expect(w).toEqual({ since: "2026-07-20", until: "2026-08-18" });
  });

  it("incremental → rebusca só a janela de re-fetch (atribuição) + dias novos", () => {
    const w = planSyncWindow({
      today: TODAY,
      latestSnapshotDate: "2026-08-17",
      refetchWindowDays: 7,
      retentionDays: 30,
    });
    // max(retentionStart=2026-07-20, 2026-08-17-6=2026-08-11) = 2026-08-11
    expect(w).toEqual({ since: "2026-08-11", until: "2026-08-18" });
  });

  it("buraco grande (sync parado) → backfill, mas clampado na retenção", () => {
    const w = planSyncWindow({
      today: TODAY,
      latestSnapshotDate: "2026-06-01",
      refetchWindowDays: 7,
      retentionDays: 30,
    });
    // latest-6 = 2026-05-26, mas retentionStart = 2026-07-20 vence (não busca além da retenção)
    expect(w).toEqual({ since: "2026-07-20", until: "2026-08-18" });
  });

  it("latest no futuro (dado inconsistente/clock skew) → null (nada válido a buscar)", () => {
    const w = planSyncWindow({
      today: TODAY,
      latestSnapshotDate: "2026-09-01",
      refetchWindowDays: 7,
      retentionDays: 30,
    });
    expect(w).toBeNull();
  });
});

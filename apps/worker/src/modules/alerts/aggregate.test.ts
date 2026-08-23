import { describe, expect, it } from "vitest";
import { buildSignalComparisons, strongestSignal, type SnapshotDay } from "./aggregate.js";

const TODAY = "2026-08-23";

function day(over: Partial<SnapshotDay> & { entityId: string; date: string }): SnapshotDay {
  return { level: "campaign", ...over };
}

describe("buildSignalComparisons", () => {
  it("current = dia fechado mais recente; baseline = média dos anteriores", () => {
    const rows: SnapshotDay[] = [
      day({ entityId: "c1", entityName: "C1", date: "2026-08-20", results: 10, spend: 100 }),
      day({ entityId: "c1", entityName: "C1", date: "2026-08-21", results: 10, spend: 100 }),
      day({ entityId: "c1", entityName: "C1", date: "2026-08-22", results: 4, spend: 100 }),
    ];
    const cmps = buildSignalComparisons(rows, TODAY);
    expect(cmps).toHaveLength(1);
    expect(cmps[0]!.current).toEqual({ results: 4, spend: 100 });
    expect(cmps[0]!.baseline).toEqual({ results: 10, spend: 100 });
    expect(cmps[0]!.entityRef).toEqual({ level: "campaign", id: "c1", name: "C1" });
  });

  it("ignora o dia corrente (não-fechado)", () => {
    const rows: SnapshotDay[] = [
      day({ entityId: "c1", date: "2026-08-21", results: 10 }),
      day({ entityId: "c1", date: "2026-08-22", results: 9 }),
      day({ entityId: "c1", date: TODAY, results: 0 }), // hoje, atribuição incompleta → ignorado
    ];
    const cmps = buildSignalComparisons(rows, TODAY);
    expect(cmps[0]!.current.results).toBe(9); // D-1 (22), não hoje
  });

  it("entidade com < 2 dias fechados é ignorada (sem baseline)", () => {
    const rows: SnapshotDay[] = [day({ entityId: "c1", date: "2026-08-22", results: 5 })];
    expect(buildSignalComparisons(rows, TODAY)).toEqual([]);
  });
});

describe("strongestSignal", () => {
  it("escolhe o de maior magnitude", () => {
    const s = strongestSignal([{ magnitudePct: 30 }, { magnitudePct: 80 }, { magnitudePct: 50 }]);
    expect(s).toEqual({ magnitudePct: 80 });
  });

  it("vazio → undefined", () => {
    expect(strongestSignal([])).toBeUndefined();
  });
});

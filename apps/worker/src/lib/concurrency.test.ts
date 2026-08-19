import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "./concurrency.js";

describe("mapWithConcurrency", () => {
  it("preserva a ordem dos resultados (não a de conclusão)", async () => {
    const out = await mapWithConcurrency([10, 1, 5], 3, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return `${i}:${ms}`;
    });
    expect(out).toEqual(["0:10", "1:1", "2:5"]);
  });

  it("respeita o teto de concorrência (nunca mais que `limit` em voo)", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 10 }, (_, i) => i), 3, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1); // de fato paralelizou
  });

  it("processa todos os itens", async () => {
    const out = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => n * 2);
    expect(out).toEqual([2, 4, 6, 8, 10]);
  });

  it("lista vazia → []", async () => {
    expect(await mapWithConcurrency([], 4, async (n) => n)).toEqual([]);
  });

  it("limit < 1 é normalizado p/ 1 (não trava)", async () => {
    const out = await mapWithConcurrency([1, 2, 3], 0, async (n) => n);
    expect(out).toEqual([1, 2, 3]);
  });
});

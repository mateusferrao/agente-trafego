import { describe, expect, it } from "vitest";
import {
  addTokenUsage,
  costSnapshotFromUsage,
  isCostPartial,
  type AccumulatedTokenUsage,
} from "./index.js";

describe("addTokenUsage", () => {
  it("soma tokens e custo quando o provider reporta custo", () => {
    const a = addTokenUsage(undefined, {
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.0012,
    });
    const b = addTokenUsage(a, {
      inputTokens: 50,
      outputTokens: 10,
      cachedTokens: 5,
      costUsd: 0.0008,
    });
    expect(b.inputTokens).toBe(150);
    expect(b.outputTokens).toBe(30);
    expect(b.cachedTokens).toBe(5);
    expect(b.costUsd).toBeCloseTo(0.002, 6);
    expect(b.costReportedCalls).toBe(2);
    expect(b.costMissingCalls).toBe(0);
  });

  it("custo ausente ≠ custo zero: mantém costUsd ausente e conta a chamada", () => {
    const a = addTokenUsage(undefined, { inputTokens: 100, outputTokens: 20 });
    expect(a.costUsd).toBeUndefined();
    expect(a.costReportedCalls).toBe(0);
    expect(a.costMissingCalls).toBe(1);
    expect(a.inputTokens).toBe(100);
  });

  it("run misto (uma com custo, outra sem) preserva o custo reportado", () => {
    let acc: AccumulatedTokenUsage | undefined;
    acc = addTokenUsage(acc, { inputTokens: 10, outputTokens: 2, costUsd: 0.001 });
    acc = addTokenUsage(acc, { inputTokens: 10, outputTokens: 2 });
    expect(acc.costUsd).toBeCloseTo(0.001, 6);
    expect(acc.costReportedCalls).toBe(1);
    expect(acc.costMissingCalls).toBe(1);
    expect(isCostPartial(acc)).toBe(true);
  });
});

describe("isCostPartial", () => {
  it("é parcial só quando há reportadas E ausentes", () => {
    expect(isCostPartial({ inputTokens: 0, outputTokens: 0, cachedTokens: 0, costReportedCalls: 2, costMissingCalls: 0 })).toBe(false);
    expect(isCostPartial({ inputTokens: 0, outputTokens: 0, cachedTokens: 0, costReportedCalls: 0, costMissingCalls: 2 })).toBe(false);
    expect(isCostPartial({ inputTokens: 0, outputTokens: 0, cachedTokens: 0, costReportedCalls: 1, costMissingCalls: 1 })).toBe(true);
  });
});

describe("costSnapshotFromUsage", () => {
  it("retorna o custo total quando reportado", () => {
    const acc = addTokenUsage(undefined, { inputTokens: 1, outputTokens: 1, costUsd: 0.5 });
    expect(costSnapshotFromUsage(acc)).toBeCloseTo(0.5, 6);
  });

  it("retorna null quando nenhum custo foi reportado (não inventa zero)", () => {
    const acc = addTokenUsage(undefined, { inputTokens: 1, outputTokens: 1 });
    expect(costSnapshotFromUsage(acc)).toBeNull();
  });
});

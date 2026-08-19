import { describe, expect, it } from "vitest";
import type { FunnelBreakdown } from "@trafego/shared";
import { computeFunnelSummary, mergeFunnel } from "./index.js";

describe("mergeFunnel", () => {
  it("soma por estágio entre breakdowns", () => {
    const a: FunnelBreakdown = [{ stage: "conversation_started", count: 10 }, { stage: "first_reply", count: 4 }];
    const b: FunnelBreakdown = [{ stage: "conversation_started", count: 5 }, { stage: "depth_3", count: 2 }];
    const merged = Object.fromEntries(mergeFunnel([a, b]).map((f) => [f.stage, f.count]));
    expect(merged).toEqual({ conversation_started: 15, first_reply: 4, depth_3: 2 });
  });
});

describe("computeFunnelSummary", () => {
  it("calcula taxas (reply/depth) sobre conversas iniciadas", () => {
    const s = computeFunnelSummary([
      { stage: "conversation_started", count: 100 },
      { stage: "first_reply", count: 40 },
      { stage: "depth_3", count: 15 },
    ]);
    expect(s?.counts.conversation_started).toBe(100);
    expect(s?.replyRate).toBeCloseTo(0.4, 4);
    expect(s?.depthRate).toBeCloseTo(0.15, 4);
  });

  it("usa depth_2 quando não há depth_3", () => {
    const s = computeFunnelSummary([
      { stage: "conversation_started", count: 50 },
      { stage: "depth_2", count: 10 },
    ]);
    expect(s?.depthRate).toBeCloseTo(0.2, 4);
  });

  it("sem conversas iniciadas → sem taxas (guarda ÷0)", () => {
    const s = computeFunnelSummary([{ stage: "first_reply", count: 3 }]);
    expect(s?.replyRate).toBeUndefined();
    expect(s?.depthRate).toBeUndefined();
  });

  it("breakdown vazio → undefined (entidade sem messaging não tem funil)", () => {
    expect(computeFunnelSummary([])).toBeUndefined();
  });
});

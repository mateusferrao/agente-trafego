import { describe, expect, it } from "vitest";
import { createTimelineService } from "./service.js";

/** DB fake chainável: cada select inicia uma query que consome o próximo da fila. */
function fakeDb(queue: unknown[][]) {
  let i = 0;
  const makeChain = () => {
    const result = queue[i++] ?? [];
    const chain: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") return (res: (v: unknown) => void) => res(result);
          return () => chain;
        },
      },
    );
    return chain;
  };
  return new Proxy({}, { get: () => makeChain }) as never;
}

describe("createTimelineService.timeline", () => {
  it("une runs+ações+aprovações, ordena desc e aninha recomendações no run", async () => {
    const db = fakeDb([
      [{ agentId: "ag1" }], // agente
      [
        { id: "runS", status: "succeeded", summary: null, finishedAt: new Date("2026-08-20T10:00:00Z"), createdAt: new Date("2026-08-20T09:00:00Z"), grade: "B", headline: "tudo ok" },
        { id: "runF", status: "failed", summary: "não consegui", finishedAt: new Date("2026-08-19T10:00:00Z"), createdAt: new Date("2026-08-19T09:00:00Z"), grade: null, headline: null },
      ],
      [{ id: "rec1", runId: "runS", title: "Pausar X", riskLevel: "low", status: "open" }], // recs
      [{ id: "tc1", toolKey: "pause_entity", args: { target: { name: "Camp" } }, runId: null, at: new Date("2026-08-20T11:00:00Z") }], // ações
      [{ id: "ap1", status: "pending", actionType: "pause_entity", action: { target: { name: "Camp" } }, createdAt: new Date("2026-08-18T09:00:00Z"), resolvedAt: null }], // aprovações
    ]);
    const service = createTimelineService({ db });

    const out = await service.timeline("org-1" as never, "acc-1");
    expect(out.hasMore).toBe(false);
    expect(out.items.map((e) => e.type)).toEqual([
      "action_applied", // 08-20 11:00 (mais novo)
      "analysis_completed", // 08-20 10:00
      "error", // 08-19 10:00
      "approval_requested", // 08-18 09:00
    ]);
    const completed = out.items[1]!;
    if (completed.type !== "analysis_completed") throw new Error("esperado analysis_completed");
    expect(completed.recommendationCount).toBe(1);
    expect(completed.recommendations[0]!.title).toBe("Pausar X");
    const action = out.items[0]!;
    if (action.type !== "action_applied") throw new Error("esperado action_applied");
    expect(action.fromChat).toBe(true);
  });

  it("filtra por tipo", async () => {
    const db = fakeDb([
      [{ agentId: "ag1" }],
      [{ id: "runS", status: "succeeded", summary: null, finishedAt: new Date("2026-08-20T10:00:00Z"), createdAt: new Date("2026-08-20T09:00:00Z"), grade: "A", headline: "x" }],
      [], // recs
      [{ id: "tc1", toolKey: "pause_entity", args: { target: { name: "C" } }, runId: "runS", at: new Date("2026-08-20T11:00:00Z") }],
      [], // aprovações
    ]);
    const service = createTimelineService({ db });
    const out = await service.timeline("org-1" as never, "acc-1", { types: ["analysis_completed"] });
    expect(out.items.map((e) => e.type)).toEqual(["analysis_completed"]);
  });

  it("conta sem agente → vazio", async () => {
    const db = fakeDb([[]]);
    const service = createTimelineService({ db });
    expect(await service.timeline("org-1" as never, "nope")).toEqual({ items: [], hasMore: false });
  });
});

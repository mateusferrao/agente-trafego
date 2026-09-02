import { describe, expect, it } from "vitest";
import type { Database } from "@trafego/db";
import type { OrgId } from "@trafego/shared";
import { dismissAdvisory, forgetLesson, rejectProposal } from "./learning-actions.js";

const ORG = "org-1" as OrgId;
const REF = { orgId: ORG, agentId: "agent-1", lessonId: "lesson-1" };

/**
 * DB falso: cada `select(...).from(...).where(...)` consome o próximo array de `selects`
 * (via `.limit()` ou await direto). Captura o `.set()` do update e o `.values()` do insert.
 */
function fakeDb(selects: unknown[][]) {
  const captured: { updateSet?: Record<string, unknown>; insertValues?: Record<string, unknown> } = {};
  const whereResult = () => {
    const rows = selects.shift() ?? [];
    return { limit: async () => rows, then: (r: (v: unknown) => void) => r(rows) };
  };
  const db = {
    select: () => ({ from: () => ({ innerJoin: () => ({ where: () => whereResult() }), where: () => whereResult() }) }),
    update: () => ({ set: (v: Record<string, unknown>) => { captured.updateSet = v; return { where: async () => undefined }; } }),
    insert: () => ({ values: (v: Record<string, unknown>) => { captured.insertValues = v; return { onConflictDoUpdate: async () => undefined }; } }),
  } as unknown as Database;
  return { db, captured };
}

describe("learning-actions (casca compartilhada site+chat)", () => {
  it("forgetLesson arquiva (soft) quando a lição existe", async () => {
    const { db, captured } = fakeDb([[{ id: "lesson-1" }]]);
    const r = await forgetLesson(db, REF);
    expect(r.ok).toBe(true);
    expect(captured.updateSet?.lifecycle).toBe("archived");
  });

  it("forgetLesson → not_found quando a lição não existe", async () => {
    const { db } = fakeDb([[]]);
    const r = await forgetLesson(db, REF);
    expect(r).toMatchObject({ ok: false, code: "not_found" });
  });

  it("rejectProposal descarta o patch e marca resolvido", async () => {
    const { db, captured } = fakeDb([[{ patch: { threshold: "zombieMinSpend" } }]]);
    const r = await rejectProposal(db, REF);
    expect(r.ok).toBe(true);
    expect(captured.updateSet?.proposedThresholdPatch).toBeNull();
    expect(captured.updateSet?.thresholdResolvedAt).toBeDefined();
  });

  it("rejectProposal → bad_request quando não há proposta pendente", async () => {
    const { db } = fakeDb([[{ patch: null }]]);
    const r = await rejectProposal(db, REF);
    expect(r).toMatchObject({ ok: false, code: "bad_request" });
  });

  it("dismissAdvisory faz upsert do cooldown quando o agente existe", async () => {
    const until = new Date("2026-10-01T00:00:00.000Z");
    const { db, captured } = fakeDb([[{ id: "agent-1" }]]);
    const r = await dismissAdvisory(db, { orgId: ORG, agentId: "agent-1", key: "guardrail_opportunity:maxBudgetChangePct", dismissedUntil: until });
    expect(r.ok).toBe(true);
    expect(captured.insertValues?.key).toBe("guardrail_opportunity:maxBudgetChangePct");
    expect(captured.insertValues?.dismissedUntil).toBe(until);
  });

  it("dismissAdvisory → not_found quando o agente não é da org", async () => {
    const { db } = fakeDb([[]]);
    const r = await dismissAdvisory(db, { orgId: ORG, agentId: "x", key: "k", dismissedUntil: new Date() });
    expect(r).toMatchObject({ ok: false, code: "not_found" });
  });
});

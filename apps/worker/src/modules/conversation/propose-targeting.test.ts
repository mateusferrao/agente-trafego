import { describe, expect, it, vi } from "vitest";
import type { LLMProviderPort } from "@trafego/shared/ports";
import { proposeTargetingForOpportunity } from "./propose-targeting.js";

const baseInput = {
  kind: "remarketing" as const,
  rationale: "tem público de engajados + tráfego",
  model: "m",
  savedAudienceNames: ["Engajamento 90d", "Compradores"],
  meta: { orgId: "org", adAccountId: "acc" },
};

function llmReturning(output: unknown): { llm: LLMProviderPort; spy: ReturnType<typeof vi.fn> } {
  const spy = vi.fn(async () => ({ output, usage: { inputTokens: 0, outputTokens: 0 } }));
  return { llm: { completeStructured: spy, complete: vi.fn() } as unknown as LLMProviderPort, spy };
}

describe("proposeTargetingForOpportunity", () => {
  it("devolve o targeting proposto (parseado) e chama a LLM com schema", async () => {
    const { llm, spy } = llmReturning({
      mode: "copy",
      sourceCampaignId: "C1",
      geoNames: [],
      interestNames: [],
      behaviorNames: [],
      includeAudienceNames: ["Engajamento 90d"],
      excludeAudienceNames: ["Compradores"],
      rationale: "remarketing nos engajados excluindo quem comprou",
    });
    const out = await proposeTargetingForOpportunity(llm, { ...baseInput, winnerCampaignId: "C1" });
    expect(out?.mode).toBe("copy");
    expect(out?.includeAudienceNames).toEqual(["Engajamento 90d"]);
    expect(out?.excludeAudienceNames).toEqual(["Compradores"]);
    const req = spy.mock.calls[0]![0] as { responseSchema?: unknown; responseSchemaName?: string; meta?: { type?: string } };
    expect(req.responseSchema).toBeTruthy();
    expect(req.responseSchemaName).toBe("proposed_targeting");
    expect(req.meta?.type).toBe("propose_targeting");
  });

  it("output inválido (falta rationale) → null (caller cai no default)", async () => {
    const { llm } = llmReturning({ mode: "create", geoNames: [], interestNames: [], behaviorNames: [], includeAudienceNames: [], excludeAudienceNames: [] });
    expect(await proposeTargetingForOpportunity(llm, baseInput)).toBeNull();
  });

  it("LLM lança → null (degrada, não quebra o run)", async () => {
    const llm = { completeStructured: vi.fn(async () => { throw new Error("upstream"); }), complete: vi.fn() } as unknown as LLMProviderPort;
    expect(await proposeTargetingForOpportunity(llm, baseInput)).toBeNull();
  });
});

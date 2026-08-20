import { describe, expect, it, vi } from "vitest";
import { APPROVAL_APPLY_QUEUE } from "@trafego/shared";
import { AGENT_TOOL_NAMES, makeConversationTools, type ConversationToolContext } from "./tools.js";

const CTX: ConversationToolContext = {
  orgId: "org-1",
  agentId: "ag-1",
  adAccountId: "acc-1",
  contactId: "ct-1",
  conversationId: "cv-1",
};

function pending(id: string, orgId = "org-1") {
  return { id, orgId, status: "pending", action: { target: { name: "Campanha X" } } };
}

function makeDeps(getByIdImpl: (id: string) => unknown) {
  const enqueue = vi.fn(async (_spec: { queue: string; name: string; payload: unknown }) => {});
  const resolve = vi.fn(async (_id: string, _input: { status: string }) => ({}) as never);
  const getById = vi.fn(async (id: string) => getByIdImpl(id) as never);
  const deps = {
    db: {} as never,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    ports: {
      approval: { getById, resolve, listPendingByOrg: vi.fn(async () => []) },
      scheduler: { enqueue },
      metering: {},
    },
    costCapUsd: 0,
  } as never;
  return { deps, enqueue, resolve, getById };
}

function toolOf(deps: never, name: string): { invoke: (args: unknown) => Promise<string> } {
  const found = makeConversationTools(deps, CTX, AGENT_TOOL_NAMES).find((t) => t.name === name)!;
  return found as unknown as { invoke: (args: unknown) => Promise<string> };
}

describe("approve tool", () => {
  it("enfileira o apply-service p/ cada pendente da org, com o contato p/ o desfecho", async () => {
    const { deps, enqueue } = makeDeps((id) => (id === "ap-1" ? pending("ap-1") : null));
    const out = (await toolOf(deps, "approve").invoke({ approvalIds: ["ap-1", "ap-x"] })) as string;

    expect(enqueue).toHaveBeenCalledOnce();
    const spec = enqueue.mock.calls[0]![0] as { queue: string; payload: unknown };
    expect(spec.queue).toBe(APPROVAL_APPLY_QUEUE);
    expect(spec.payload).toEqual({ orgId: "org-1", approvalId: "ap-1", notifyContactId: "ct-1" });
    expect(out).toContain("aplicando");
  });

  it("pendente de OUTRA org → ignora (não enfileira)", async () => {
    const { deps, enqueue } = makeDeps(() => pending("ap-1", "org-outra"));
    await toolOf(deps, "approve").invoke({ approvalIds: ["ap-1"] });
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("reject tool", () => {
  it("resolve como rejeitada (sem escrever na Meta)", async () => {
    const { deps, resolve } = makeDeps((id) => (id === "ap-1" ? pending("ap-1") : null));
    await toolOf(deps, "reject").invoke({ approvalIds: ["ap-1"] });
    expect(resolve).toHaveBeenCalledWith("ap-1", { status: "rejected" });
  });

  it("já resolvida (não-pendente) → ignora", async () => {
    const { deps, resolve } = makeDeps(() => ({ id: "ap-1", orgId: "org-1", status: "approved" }));
    await toolOf(deps, "reject").invoke({ approvalIds: ["ap-1"] });
    expect(resolve).not.toHaveBeenCalled();
  });
});

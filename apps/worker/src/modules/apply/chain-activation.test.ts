import { describe, expect, it, vi } from "vitest";
import type { Action, ActivationTree } from "@trafego/shared/types";
import { expandChainActivation, isActivateAction } from "./chain-activation.js";

const act = (type: Action["type"], level: Action["target"]["level"], id: string, params: Record<string, unknown> = {}): Action => ({
  id: `t:${id}`,
  type,
  target: { level, id, name: id },
  params,
  source: "llm",
  riskLevel: "medium",
  reason: "x",
});

const adset = (id: string, status: "active" | "paused") => ({ id, name: id, status });
const ad = (id: string, adsetId: string, status: "active" | "paused") => ({ id, name: id, status, adsetId });

describe("isActivateAction", () => {
  it("resume_entity → true; set_status ACTIVE → true; set_status PAUSED/pause/budget → false", () => {
    expect(isActivateAction(act("resume_entity", "campaign", "c1"))).toBe(true);
    expect(isActivateAction(act("set_status", "campaign", "c1", { status: "active" }))).toBe(true);
    expect(isActivateAction(act("set_status", "campaign", "c1", { status: "paused" }))).toBe(false);
    expect(isActivateAction(act("pause_entity", "campaign", "c1"))).toBe(false);
    expect(isActivateAction(act("adjust_budget", "campaign", "c1"))).toBe(false);
  });
});

describe("expandChainActivation", () => {
  it("ativar campanha com filhos pausados → expande a subárvore + nota + marca chainActivated", async () => {
    const tree: ActivationTree = {
      adsets: [adset("s1", "active"), adset("s2", "paused")],
      ads: [ad("a1", "s1", "active"), ad("a2", "s2", "paused")],
    };
    const readTree = vi.fn(async () => tree);
    const r = await expandChainActivation([act("resume_entity", "campaign", "c1")], readTree);
    expect(r.chainActivated).toBe(true);
    // originais + 1 conjunto + 1 anúncio pausados
    expect(r.expanded.map((a) => a.target.id)).toEqual(["c1", "s2", "a2"]);
    expect([...r.childIds].length).toBe(2);
    expect(r.notes[0]).toContain("Também vou ligar");
    expect(r.notes[0]).toContain("1 conjunto");
    expect(r.notes[0]).toContain("1 anúncio");
  });

  it("ativar campanha já entregando (tudo ativo) → sem expansão, sem nota", async () => {
    const tree: ActivationTree = { adsets: [adset("s1", "active")], ads: [ad("a1", "s1", "active")] };
    const r = await expandChainActivation([act("resume_entity", "campaign", "c1")], async () => tree);
    expect(r.chainActivated).toBe(false);
    expect(r.expanded).toHaveLength(1);
    expect(r.notes).toEqual([]);
  });

  it("ativar campanha SEM anúncio (nada a religar e não entrega) → ⚠️ não-entrega", async () => {
    const tree: ActivationTree = { adsets: [adset("s1", "active")], ads: [] };
    const r = await expandChainActivation([act("resume_entity", "campaign", "c1")], async () => tree);
    expect(r.chainActivated).toBe(false);
    expect(r.notes[0]).toContain("⚠️");
    expect(r.notes[0]).toContain("não vai veicular");
  });

  it("PAUSAR campanha → NÃO expande (granularidade da pausa preservada)", async () => {
    const readTree = vi.fn(async () => ({ adsets: [], ads: [] }) as ActivationTree);
    const r = await expandChainActivation([act("pause_entity", "campaign", "c1")], readTree);
    expect(readTree).not.toHaveBeenCalled();
    expect(r.chainActivated).toBe(false);
    expect(r.expanded).toHaveLength(1);
  });

  it("ativar um ANÚNCIO (nó-folha) → NÃO expande", async () => {
    const readTree = vi.fn(async () => ({ adsets: [], ads: [] }) as ActivationTree);
    const r = await expandChainActivation([act("resume_entity", "ad", "a1")], readTree);
    expect(readTree).not.toHaveBeenCalled();
    expect(r.expanded).toHaveLength(1);
  });

  it("ativar conjunto → expande só os anúncios pausados dele", async () => {
    const tree: ActivationTree = { adsets: [], ads: [ad("a1", "s1", "paused"), ad("a2", "s1", "active")] };
    const r = await expandChainActivation([act("resume_entity", "adset", "s1")], async () => tree);
    expect(r.chainActivated).toBe(true);
    expect(r.expanded.map((a) => a.target.id)).toEqual(["s1", "a1"]);
  });

  it("leitura da árvore falha (null) → degrada: só o nó, sem expansão nem nota", async () => {
    const r = await expandChainActivation([act("resume_entity", "campaign", "c1")], async () => null);
    expect(r.chainActivated).toBe(false);
    expect(r.expanded).toHaveLength(1);
    expect(r.notes).toEqual([]);
  });
});

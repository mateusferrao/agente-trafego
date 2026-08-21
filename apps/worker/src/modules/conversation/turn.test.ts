import { describe, expect, it } from "vitest";
import type { Database } from "@trafego/db";
import { configToolsFor } from "./turn.js";
import { CONFIG_CHAT_TOOL_NAMES } from "../../graphs/whatsapp-conversation/tools.js";

/** DB falso: devolve UMA linha de agente (autonomyPolicy) na leitura. */
function fakeDb(autonomyPolicy: unknown) {
  return {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ autonomyPolicy }] }) }) }),
  } as unknown as Database;
}

describe("configToolsFor (kill-switch da auto-config por chat, S2.3)", () => {
  it("ausente (default) → ON: liga TODAS as tools de config", async () => {
    const r = await configToolsFor(fakeDb({ bySource: { playbook: "suggest", llm: "suggest" } }), "org-1", "ag-1");
    expect(r.enabled).toBe(true);
    expect(new Set(r.tools)).toEqual(CONFIG_CHAT_TOOL_NAMES);
  });

  it("autoConfigViaChat=true → ON", async () => {
    const r = await configToolsFor(fakeDb({ bySource: { playbook: "suggest", llm: "suggest" }, autoConfigViaChat: true }), "o", "a");
    expect(r.enabled).toBe(true);
    expect(r.tools.length).toBeGreaterThan(0);
  });

  it("autoConfigViaChat=false → OFF: nenhuma tool de config entra na allowlist", async () => {
    const r = await configToolsFor(fakeDb({ bySource: { playbook: "suggest", llm: "suggest" }, autoConfigViaChat: false }), "o", "a");
    expect(r.enabled).toBe(false);
    expect(r.tools).toEqual([]);
  });
});

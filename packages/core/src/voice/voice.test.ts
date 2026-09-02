import { describe, expect, it } from "vitest";
import { DEFAULT_POSTURE } from "@trafego/shared";
import { composeAgentVoice, type AgentVoiceInput } from "../archetypes/index.js";
import { AI_JARGON_BLOCKLIST, BRAND_VOICE_KERNEL, composeSpeakingVoice } from "./index.js";

const baseInput: AgentVoiceInput & { posture: typeof DEFAULT_POSTURE } = {
  systemPrompt: null,
  archetype: "conservador",
  persona: null,
  tone: null,
  businessContext: null,
  guidance: null,
  posture: DEFAULT_POSTURE,
};

describe("BRAND_VOICE_KERNEL", () => {
  it("carrega o nome fixo Roy e a proibição de se dizer IA", () => {
    expect(BRAND_VOICE_KERNEL).toContain("Roy");
    expect(BRAND_VOICE_KERNEL.toLowerCase()).toContain("como uma ia");
  });

  it("é a fonte da voz da marca — traz caráter positivo (do lado do dono no dinheiro)", () => {
    expect(BRAND_VOICE_KERNEL.toLowerCase()).toContain("dinheiro");
  });
});

describe("AI_JARGON_BLOCKLIST", () => {
  it("lista as frases proibidas (fonte única)", () => {
    expect(AI_JARGON_BLOCKLIST).toContain("como uma IA");
    expect(AI_JARGON_BLOCKLIST.length).toBeGreaterThan(2);
  });
});

describe("composeSpeakingVoice", () => {
  it("anexa o kernel de marca à voz base", () => {
    const out = composeSpeakingVoice(baseInput);
    expect(out).toContain(BRAND_VOICE_KERNEL);
  });

  it("anexa o bloco de postura", () => {
    const out = composeSpeakingVoice(baseInput);
    expect(out).toContain("Postura de comunicação com o dono");
  });

  it("começa pela identidade (Você é Roy)", () => {
    const out = composeSpeakingVoice(baseInput);
    expect(out.startsWith("Você é Roy")).toBe(true);
  });

  it("o analista (composeAgentVoice cru) NÃO carrega o kernel — voz separada", () => {
    const analyst = composeAgentVoice(baseInput);
    expect(analyst).not.toContain(BRAND_VOICE_KERNEL);
  });
});

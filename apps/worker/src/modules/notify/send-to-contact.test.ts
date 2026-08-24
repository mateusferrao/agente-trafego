import { describe, expect, it, vi } from "vitest";
import type { MessagingChannelPort, OutboundMessage } from "@trafego/shared/ports";
import { createSendToContact, createSendToConversation } from "./send-to-contact.js";
import type { NotifyRepo } from "./repo.js";
import { TYPING_MIN_MS } from "./typing.js";

const TARGET = { instanceId: "inst-1", phone: "5511999999999", orgId: "org-1" };
const GROUP_TARGET = { instanceId: "inst-1", groupJid: "120363000000000000@g.us", orgId: "org-1" };

function makeDeps(overrides: { target?: typeof TARGET | null; groupTarget?: typeof GROUP_TARGET | null } = {}) {
  const sent: OutboundMessage[] = [];
  const recorded: Array<{ direction: string; body: string | null }> = [];
  const messaging = {
    sendMessage: vi.fn(async (_i, msg: OutboundMessage) => {
      sent.push(msg);
    }),
  } as unknown as MessagingChannelPort;
  const repo = {
    resolveOutboundTarget: vi.fn(async () => (overrides.target === undefined ? TARGET : overrides.target)),
    ensureConversation: vi.fn(async () => "conv-1"),
    resolveGroupTarget: vi.fn(async () => (overrides.groupTarget === undefined ? GROUP_TARGET : overrides.groupTarget)),
    ensureGroupConversation: vi.fn(async () => "conv-grp-1"),
    recordMessage: vi.fn(async (_c, direction: string, body: string | null) => {
      recorded.push({ direction, body });
      return "msg-id";
    }),
  } as unknown as NotifyRepo;
  return { deps: { messaging, repo }, sent, recorded };
}

describe("sendToContact", () => {
  it("sem instância/contato → não envia (false)", async () => {
    const { deps, sent } = makeDeps({ target: null });
    const ok = await createSendToContact(deps)("contact-1", "oi");
    expect(ok).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("sanitiza o texto do LLM antes de enviar (** → *)", async () => {
    const { deps, sent } = makeDeps();
    await createSendToContact(deps)("contact-1", "isto é **importante**");
    expect(sent[0]!.text).toBe("isto é *importante*");
  });

  it("split:true quebra em balões, cada um com typingHint proporcional", async () => {
    const { deps, sent } = makeDeps();
    await createSendToContact(deps)("contact-1", "primeiro bloco\n\nsegundo bloco", { split: true });
    expect(sent.map((m) => m.text)).toEqual(["primeiro bloco", "segundo bloco"]);
    for (const m of sent) expect(m.typingHintMs).toBeGreaterThanOrEqual(TYPING_MIN_MS);
  });

  it("split:false (cron) envia inteiro, sanitizado, num balão só, com typingHint", async () => {
    const { deps, sent } = makeDeps();
    await createSendToContact(deps)("contact-1", "linha um\n\nlinha dois", { split: false });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toBe("linha um\n\nlinha dois");
    expect(sent[0]!.typingHintMs).toBeGreaterThanOrEqual(TYPING_MIN_MS);
  });

  it("grava cada balão como outbound na conversa", async () => {
    const { deps, recorded } = makeDeps();
    await createSendToContact(deps)("contact-1", "a\n\nb", { split: true });
    expect(recorded).toEqual([
      { direction: "outbound", body: "a" },
      { direction: "outbound", body: "b" },
    ]);
  });
});

describe("sendToConversation — grupo", () => {
  it("reativo (thread por participante): resolve o JID do grupo + toIsGroup:true", async () => {
    const { deps, sent, recorded } = makeDeps();
    const ref = { kind: "group" as const, groupId: "grp-1", participantPhone: "+5511999999999" };
    const ok = await createSendToConversation(deps)(ref, "oi", { split: false });
    expect(ok).toBe(true);
    expect(sent[0]).toMatchObject({ to: GROUP_TARGET.groupJid, toIsGroup: true });
    expect(deps.repo.ensureGroupConversation).toHaveBeenCalledWith("org-1", "grp-1", "+5511999999999");
    expect(recorded).toEqual([{ direction: "outbound", body: "oi" }]);
  });

  it("proativo/broadcast (participantPhone null): thread de broadcast do grupo", async () => {
    const { deps } = makeDeps();
    const ref = { kind: "group" as const, groupId: "grp-1", participantPhone: null };
    await createSendToConversation(deps)(ref, "alerta", { split: false });
    expect(deps.repo.ensureGroupConversation).toHaveBeenCalledWith("org-1", "grp-1", null);
  });

  it("sem grupo resolvível → não envia (false)", async () => {
    const { deps, sent } = makeDeps({ groupTarget: null });
    const ok = await createSendToConversation(deps)({ kind: "group", groupId: "grp-1", participantPhone: null }, "x");
    expect(ok).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("ref contact ainda funciona (sem toIsGroup)", async () => {
    const { deps, sent } = makeDeps();
    await createSendToConversation(deps)({ kind: "contact", contactId: "contact-1" }, "oi");
    expect(sent[0]).toMatchObject({ to: TARGET.phone });
    expect(sent[0]!.toIsGroup).toBeUndefined();
  });
});

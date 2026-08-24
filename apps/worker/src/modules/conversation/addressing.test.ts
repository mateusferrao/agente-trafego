import { describe, expect, it } from "vitest";
import { isAddressedToBot } from "./addressing.js";

const BOT_PHONE = "+5511900000000";

describe("isAddressedToBot", () => {
  it("telefone do bot está em mentionedPhones → dirigido", () => {
    expect(isAddressedToBot({ mentionedPhones: [BOT_PHONE], quotedAuthorPhone: null }, BOT_PHONE)).toBe(true);
  });

  it("quotedAuthorPhone = telefone do bot (reply) → dirigido", () => {
    expect(isAddressedToBot({ mentionedPhones: [], quotedAuthorPhone: BOT_PHONE }, BOT_PHONE)).toBe(true);
  });

  it("nem menção nem reply ao bot → não dirigido", () => {
    expect(isAddressedToBot({ mentionedPhones: ["+5511888888888"], quotedAuthorPhone: null }, BOT_PHONE)).toBe(false);
  });

  it("reply a mensagem de OUTRO participante (não o bot) → não dirigido", () => {
    expect(isAddressedToBot({ mentionedPhones: [], quotedAuthorPhone: "+5511777777777" }, BOT_PHONE)).toBe(false);
  });

  it("sem telefone do bot conhecido (instância sem número resolvido) → nunca dirigido", () => {
    expect(isAddressedToBot({ mentionedPhones: [BOT_PHONE], quotedAuthorPhone: null }, null)).toBe(false);
  });
});

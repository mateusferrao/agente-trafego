import { describe, expect, it } from "vitest";
import { daysAgoInTz, todayInTz } from "./index.js";

const SP = "America/Sao_Paulo"; // UTC-3

describe("todayInTz", () => {
  it("noite BRT NÃO vira o dia seguinte (o bug): 02:00 UTC = 23:00 BRT do dia anterior", () => {
    expect(todayInTz(new Date("2026-08-25T02:00:00Z"), SP)).toBe("2026-08-24");
  });

  it("mesmo instante em UTC dá o dia seguinte (prova que o fuso importa)", () => {
    expect(todayInTz(new Date("2026-08-25T02:00:00Z"), "UTC")).toBe("2026-08-25");
  });

  it("meio do dia BRT → o dia corrente", () => {
    expect(todayInTz(new Date("2026-08-24T14:00:00Z"), SP)).toBe("2026-08-24"); // 11:00 BRT
  });

  it("fuso positivo (Asia/Tokyo, UTC+9): 20:00 UTC já é o dia seguinte", () => {
    expect(todayInTz(new Date("2026-08-24T20:00:00Z"), "Asia/Tokyo")).toBe("2026-08-25");
  });
});

describe("daysAgoInTz", () => {
  it("days=1 = hoje (no fuso)", () => {
    const now = new Date("2026-08-25T02:00:00Z");
    expect(daysAgoInTz(now, SP, 1)).toBe(todayInTz(now, SP));
  });

  it("days=7 = 6 dias antes de hoje (no fuso)", () => {
    expect(daysAgoInTz(new Date("2026-08-25T02:00:00Z"), SP, 7)).toBe("2026-08-18");
  });
});

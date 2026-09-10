import { describe, expect, it } from "vitest";
import {
  currencyExponent,
  currencySymbol,
  formatMoney,
  formatMoneyMinor,
  minorToMajor,
  minorUnitDivisor,
  toMinorUnits,
} from "./money.js";

describe("currencyExponent / minorUnitDivisor", () => {
  it("2 casas (default) p/ moedas comuns", () => {
    expect(currencyExponent("BRL")).toBe(2);
    expect(currencyExponent("USD")).toBe(2);
    expect(minorUnitDivisor("BRL")).toBe(100);
    expect(minorUnitDivisor("usd")).toBe(100); // case-insensitive
  });
  it("0 casas p/ moedas sem sub-unidade (JPY/KRW/CLP)", () => {
    expect(currencyExponent("JPY")).toBe(0);
    expect(minorUnitDivisor("JPY")).toBe(1);
    expect(minorUnitDivisor("KRW")).toBe(1);
    expect(minorUnitDivisor("CLP")).toBe(1);
  });
  it("3 casas p/ moedas de milésimos (BHD/KWD)", () => {
    expect(currencyExponent("BHD")).toBe(3);
    expect(minorUnitDivisor("BHD")).toBe(1000);
    expect(minorUnitDivisor("KWD")).toBe(1000);
  });
  it("moeda desconhecida / nula → default 2 casas (nunca corrompe)", () => {
    expect(minorUnitDivisor("ZZZ")).toBe(100);
    expect(minorUnitDivisor(null)).toBe(100);
    expect(minorUnitDivisor(undefined)).toBe(100);
  });
});

describe("toMinorUnits (unidade maior → menor)", () => {
  it("BRL: reais → centavos (×100)", () => {
    expect(toMinorUnits(50, "BRL")).toBe(5000);
    expect(toMinorUnits(12.34, "BRL")).toBe(1234);
  });
  it("JPY: ienes → ienes (×1, sem inflar 100×)", () => {
    expect(toMinorUnits(1000, "JPY")).toBe(1000);
  });
  it("BHD: dinares → fils (×1000)", () => {
    expect(toMinorUnits(5, "BHD")).toBe(5000);
  });
});

describe("minorToMajor / formatMoneyMinor (unidade menor → exibição)", () => {
  it("BRL: centavos → R$ com 2 casas", () => {
    expect(minorToMajor(5000, "BRL")).toBe(50);
    expect(formatMoneyMinor(123456, "BRL")).toBe("R$ 1234,56");
  });
  it("JPY: ienes → sem casas decimais (não divide por 100)", () => {
    expect(minorToMajor(1000, "JPY")).toBe(1000);
    expect(formatMoneyMinor(1000, "JPY")).toBe("JPY 1000");
  });
  it("BHD: fils → 3 casas", () => {
    expect(formatMoneyMinor(5000, "BHD")).toBe("BHD 5,000");
  });
});

describe("formatMoney casas por moeda", () => {
  it("símbolo conhecido + 2 casas p/ BRL", () => {
    expect(formatMoney(120.5, "BRL")).toBe("R$ 120,50");
  });
  it("0 casas p/ JPY (arredonda)", () => {
    expect(formatMoney(120.5, "JPY")).toBe("JPY 121");
  });
  it("currencySymbol: conhecido vs fallback ISO", () => {
    expect(currencySymbol("BRL")).toBe("R$");
    expect(currencySymbol("JPY")).toBe("JPY");
  });
});

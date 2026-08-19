import { describe, expect, it } from "vitest";
import type { AccessibleAccount } from "@trafego/shared";
import { reconcileSelect, reconcileSync, type ManagedAccount } from "./index.js";

const acc = (id: string, name = `Conta ${id}`, currency = "BRL"): AccessibleAccount => ({
  id,
  name,
  currency,
});
const managed = (adAccountId: string, status: ManagedAccount["status"]): ManagedAccount => ({
  adAccountId,
  status,
});
const ids = (xs: readonly AccessibleAccount[]) => xs.map((a) => a.id).sort();

describe("reconcileSync — descoberta aditiva, nunca destrutiva", () => {
  it("conta acessível já gerida ativa: refresca metadados, sem reativar", () => {
    const plan = reconcileSync({
      available: [acc("1", "Novo nome")],
      existingHere: [managed("1", "active")],
    });
    expect(ids(plan.toRefresh)).toEqual(["1"]);
    expect(plan.toReactivate).toEqual([]);
    expect(plan.toMarkUnavailable).toEqual([]);
    expect(plan.newAvailable).toEqual([]);
  });

  it("conta que estava unavailable e voltou: reativa", () => {
    const plan = reconcileSync({
      available: [acc("1")],
      existingHere: [managed("1", "unavailable")],
    });
    expect(plan.toReactivate).toEqual(["1"]);
    expect(ids(plan.toRefresh)).toEqual(["1"]);
  });

  it("conta ativa que sumiu da plataforma: marca unavailable (soft), não deleta", () => {
    const plan = reconcileSync({
      available: [],
      existingHere: [managed("1", "active")],
    });
    expect(plan.toMarkUnavailable).toEqual(["1"]);
    expect(plan.toRefresh).toEqual([]);
  });

  it("resultado vazio nunca é lido como 'apagar tudo' — só marca unavailable os ativos", () => {
    const plan = reconcileSync({
      available: [],
      existingHere: [managed("1", "active"), managed("2", "removed"), managed("3", "unavailable")],
    });
    expect(plan.toMarkUnavailable).toEqual(["1"]); // removed/unavailable ficam como estão
  });

  it("conta nova acessível: vira disponível (opt-in), não auto-ativa", () => {
    const plan = reconcileSync({
      available: [acc("9")],
      existingHere: [],
    });
    expect(ids(plan.newAvailable)).toEqual(["9"]);
    expect(plan.toRefresh).toEqual([]);
    expect(plan.toReactivate).toEqual([]);
  });

  it("conta já gerida por outra conexão: connectedElsewhere, não duplica nem vira nova", () => {
    const plan = reconcileSync({
      available: [acc("5")],
      existingHere: [],
      managedElsewhereIds: ["5"],
    });
    expect(plan.connectedElsewhere).toEqual(["5"]);
    expect(plan.newAvailable).toEqual([]);
  });

  it("removed que continua acessível não reativa sozinha (respeita a escolha do dono)", () => {
    const plan = reconcileSync({
      available: [acc("1")],
      existingHere: [managed("1", "removed")],
    });
    expect(plan.toReactivate).toEqual([]);
    expect(plan.toMarkUnavailable).toEqual([]);
  });
});

describe("reconcileSelect — multi-seleção do dono", () => {
  it("ativa selecionadas novas e remove (soft) as desmarcadas", () => {
    const plan = reconcileSelect({
      available: [acc("1"), acc("2")],
      existingHere: [managed("1", "active")],
      selectedIds: ["2"],
    });
    expect(ids(plan.toActivate)).toEqual(["2"]);
    expect(plan.toRemove).toEqual(["1"]);
  });

  it("ignora seleção que a plataforma não oferece", () => {
    const plan = reconcileSelect({
      available: [acc("1")],
      existingHere: [],
      selectedIds: ["1", "999"],
    });
    expect(ids(plan.toActivate)).toEqual(["1"]);
    expect(plan.ignoredUnavailable).toEqual(["999"]);
  });

  it("não ativa conta já gerida por outra conexão", () => {
    const plan = reconcileSelect({
      available: [acc("5")],
      existingHere: [],
      selectedIds: ["5"],
      managedElsewhereIds: ["5"],
    });
    expect(plan.toActivate).toEqual([]);
    expect(plan.connectedElsewhere).toEqual(["5"]);
  });

  it("reativa uma conta antes removida quando o dono a seleciona de novo", () => {
    const plan = reconcileSelect({
      available: [acc("1")],
      existingHere: [managed("1", "removed")],
      selectedIds: ["1"],
    });
    expect(ids(plan.toActivate)).toEqual(["1"]);
    expect(plan.toRemove).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import {
  CONTRADICTION_STALE_FLOOR,
  OBSERVATIONAL_CONFIDENCE_CAP,
  PROMPT_CONFIDENCE_THRESHOLD,
  applyContradiction,
  applyDecay,
  classifyOutcomeEvidence,
  computeConfidence,
  distillAccountPriors,
  computeOutcome,
  confidenceTier,
  decayCutoffs,
  describeLessonForRedactor,
  detectFactCandidates,
  fallbackLessonText,
  lessonKeyOf,
  manualChangeToAction,
  nextThresholdValue,
  proposalForCalibration,
  selectLessonsForBrief,
  type ComputeOutcomeInput,
  type RunLearningSnapshot,
  type StoredLesson,
} from "./index.js";

// ─── lessonKeyOf ──────────────────────────────────────────────────────────
describe("lessonKeyOf", () => {
  it("é canônica e estável para a mesma chave", () => {
    const a = lessonKeyOf({ scope: "entity", dimension: "budget", direction: "lower", subjectId: "c1" });
    const b = lessonKeyOf({ scope: "entity", dimension: "budget", direction: "lower", subjectId: "c1" });
    expect(a).toBe(b);
    expect(a).toBe("entity:budget:lower:c1");
  });

  it("omite subjectId quando ausente (escopo conta)", () => {
    expect(lessonKeyOf({ scope: "account", dimension: "tracking", direction: "neutral" })).toBe(
      "account:tracking:neutral",
    );
  });

  it("distingue direções e dimensões diferentes", () => {
    const raise = lessonKeyOf({ scope: "account", dimension: "pacing", direction: "raise" });
    const lower = lessonKeyOf({ scope: "account", dimension: "pacing", direction: "lower" });
    expect(raise).not.toBe(lower);
  });

  it("Fase 2: inclui o PADRÃO — mesmo (dim,dir) com padrões diferentes → chaves DISTINTAS (N por dimensão)", () => {
    const fatigue = lessonKeyOf({ scope: "account", dimension: "creative", direction: "neutral", pattern: "account_fatigue_timing" });
    const weakHook = lessonKeyOf({ scope: "account", dimension: "creative", direction: "neutral", pattern: "weak_hook" as never });
    expect(fatigue).toBe("account:creative:neutral:account_fatigue_timing");
    expect(fatigue).not.toBe(weakHook); // não colidem mais numa vaga só
  });

  it("Fase 2: ordem scope:dim:dir:padrão:subjectId (padrão antes do subjectId)", () => {
    expect(lessonKeyOf({ scope: "entity", dimension: "creative", direction: "neutral", pattern: "account_fatigue_timing", subjectId: "ad1" })).toBe(
      "entity:creative:neutral:account_fatigue_timing:ad1",
    );
  });
});

// ─── computeConfidence ────────────────────────────────────────────────────
describe("computeConfidence", () => {
  it("observação nasce baixa e NUNCA passa o teto observacional só observando", () => {
    let c = computeConfidence(null, { type: "observe", occurrenceRatio: 1, origin: "observational" });
    expect(c).toBeGreaterThan(0);
    expect(c).toBeLessThan(OBSERVATIONAL_CONFIDENCE_CAP);
    // reforço repetido aproxima do teto mas não ultrapassa
    for (let i = 0; i < 50; i++) {
      c = computeConfidence(c, { type: "observe", occurrenceRatio: 1, origin: "observational" });
    }
    expect(c).toBeLessThanOrEqual(OBSERVATIONAL_CONFIDENCE_CAP);
    // e fica abaixo do limiar de entrada no prompt (só observação nunca entra sozinha)
    expect(c).toBeLessThan(PROMPT_CONFIDENCE_THRESHOLD);
  });

  it("confirmação humana dá salto acima do limiar do prompt", () => {
    const low = computeConfidence(null, { type: "observe", occurrenceRatio: 0.6, origin: "observational" });
    const confirmed = computeConfidence(low, { type: "confirm" });
    expect(confirmed).toBeGreaterThanOrEqual(PROMPT_CONFIDENCE_THRESHOLD);
  });

  it("contradição derruba a confiança", () => {
    const c = computeConfidence(0.5, { type: "contradict" });
    expect(c).toBeLessThan(0.5);
  });

  it("outcome medido positivo de ação nossa pode passar o limiar do prompt", () => {
    let c = computeConfidence(null, { type: "measured", positive: true });
    c = computeConfidence(c, { type: "measured", positive: true });
    c = computeConfidence(c, { type: "measured", positive: true });
    expect(c).toBeGreaterThan(OBSERVATIONAL_CONFIDENCE_CAP);
  });

  it("nunca sai do intervalo [0,1]", () => {
    expect(computeConfidence(0.95, { type: "confirm" })).toBeLessThanOrEqual(1);
    expect(computeConfidence(0.01, { type: "contradict" })).toBeGreaterThanOrEqual(0);
  });
});

// ─── confidenceTier ───────────────────────────────────────────────────────
describe("confidenceTier", () => {
  it("mapeia confiança + confirmação nos três selos", () => {
    expect(confidenceTier(0.2, false)).toBe("explorando");
    expect(confidenceTier(0.55, false)).toBe("provavel");
    expect(confidenceTier(0.2, true)).toBe("confirmado");
    expect(confidenceTier(0.9, false)).toBe("confirmado");
  });
});

// ─── detectFactCandidates ─────────────────────────────────────────────────
function runWith(campaigns: RunLearningSnapshot["campaigns"], at: string, trackingSuspect = false): RunLearningSnapshot {
  return { runId: `run-${at}`, at, campaigns, trackingSuspect };
}

describe("detectFactCandidates", () => {
  it("não emite nada abaixo do mínimo de runs", () => {
    const runs = [runWith([{ externalId: "c1", name: "Camp 1", tier: "zombie" }], "2026-01-01")];
    expect(detectFactCandidates({ runs })).toEqual([]);
  });

  it("NÃO emite padrão por-entidade (zumbi/fadiga são redundantes com a análise stateless)", () => {
    // v3: os padrões observacionais por-campanha foram removidos — a análise já os recalcula
    // e recomenda a cada run. Aprendizado de entidade não é mais criado aqui.
    const zombie = [{ externalId: "c1", name: "Institucional", tier: "zombie" as const, healthSignals: ["creative_fatigue" as const] }];
    const runs = [runWith(zombie, "d1"), runWith(zombie, "d2"), runWith(zombie, "d3"), runWith(zombie, "d4")];
    expect(detectFactCandidates({ runs }).every((c) => c.key.scope !== "entity")).toBe(true);
  });

  it("detecta tracking suspeito recorrente → dimensão tracking, escopo conta", () => {
    const c = [{ externalId: "c1", name: "Camp", tier: "performer" as const }];
    const runs = [runWith(c, "d1", true), runWith(c, "d2", true), runWith(c, "d3", true)];
    const lesson = detectFactCandidates({ runs }).find((x) => x.key.dimension === "tracking");
    expect(lesson).toBeDefined();
    expect(lesson?.key.scope).toBe("account");
  });
});

// ─── classifyOutcomeEvidence + distillAccountPriors (v3, cross-seccional) ──
describe("classifyOutcomeEvidence", () => {
  it("corte positivo sustenta budget/lower; negativo contradiz", () => {
    expect(classifyOutcomeEvidence({ actionType: "pause_entity", outcome: "positive", subjectId: "c1" })).toEqual([
      { dimension: "budget", direction: "lower", supports: true },
    ]);
    expect(classifyOutcomeEvidence({ actionType: "pause_entity", outcome: "negative", subjectId: "c1" })[0]?.supports).toBe(false);
  });
  it("escala positiva sustenta pacing/raise e contradiz pacing/lower", () => {
    const e = classifyOutcomeEvidence({ actionType: "adjust_budget", params: { mode: "increase" }, outcome: "positive", subjectId: "c1" });
    expect(e).toContainEqual({ dimension: "pacing", direction: "raise", supports: true });
    expect(e).toContainEqual({ dimension: "pacing", direction: "lower", supports: false });
  });
  it("neutro não vira evidência", () => {
    expect(classifyOutcomeEvidence({ actionType: "pause_entity", outcome: "neutral", subjectId: "c1" })).toEqual([]);
  });
});

describe("distillAccountPriors", () => {
  const cfg = { minEntities: 3 };
  const cutPays = (entityId: string) => ({ dimension: "budget" as const, direction: "lower" as const, supports: true, entityId });

  it("≥3 entidades DISTINTAS sustentando → nasce prior de conta (budget/lower)", () => {
    const priors = distillAccountPriors([cutPays("a"), cutPays("b"), cutPays("c")], cfg);
    const p = priors.find((x) => x.key.dimension === "budget");
    expect(p).toBeDefined();
    expect(p?.key.scope).toBe("account");
    expect(p?.key.subjectId).toBeUndefined();
    expect(p?.evidence.occurrences).toBe(3);
    expect(p?.confidence).toBeGreaterThanOrEqual(0.7); // 3 entidades → ≥ limiar do prompt
  });
  it("a MESMA entidade repetida não conta (distintas=1) → não nasce", () => {
    expect(distillAccountPriors([cutPays("a"), cutPays("a"), cutPays("a")], cfg)).toEqual([]);
  });
  it("<K entidades distintas → não nasce", () => {
    expect(distillAccountPriors([cutPays("a"), cutPays("b")], cfg)).toEqual([]);
  });
  it("oposição domina (O ≥ S) → não nasce", () => {
    const oppose = (entityId: string) => ({ dimension: "budget" as const, direction: "lower" as const, supports: false, entityId });
    const rows = [cutPays("a"), cutPays("b"), cutPays("c"), oppose("d"), oppose("e"), oppose("f")];
    expect(distillAccountPriors(rows, cfg).find((x) => x.key.dimension === "budget")).toBeUndefined();
  });
});

// ─── computeOutcome (Sinal A) ─────────────────────────────────────────────
describe("computeOutcome", () => {
  const base = (over: Partial<ComputeOutcomeInput>): ComputeOutcomeInput => ({
    actionType: "adjust_budget",
    entityPre: { spend: 100, results: 10, cpa: 10 },
    entityPost: { spend: 150, results: 15, cpa: 10 },
    ...over,
  });

  it("ajuste de orçamento: CPA da entidade manteve → positive", () => {
    expect(computeOutcome(base({ params: { mode: "increase" } }))).toBe("positive");
  });
  it("ajuste de orçamento: CPA da entidade piorou além da tolerância → negative", () => {
    expect(computeOutcome(base({ params: { mode: "increase" }, entityPost: { spend: 200, results: 10, cpa: 20 } }))).toBe("negative");
  });
  it("ajuste de orçamento: sem resultados suficientes → neutral (não declara o que não mede)", () => {
    expect(computeOutcome(base({ entityPre: { spend: 5, results: 1 }, entityPost: { spend: 6, results: 1 } }))).toBe("neutral");
  });
  it("pausa: mede a CONTA (a entidade zera) — conta melhorou → positive", () => {
    const out = computeOutcome({
      actionType: "pause_entity",
      entityPre: { spend: 50, results: 0 },
      entityPost: { spend: 0, results: 0 },
      accountPre: { spend: 500, results: 40, cpa: 12.5 },
      accountPost: { spend: 500, results: 50, cpa: 10 },
    });
    expect(out).toBe("positive");
  });
  it("pausa sem dado de conta → neutral", () => {
    expect(computeOutcome({ actionType: "pause_entity", entityPre: { spend: 50, results: 0 }, entityPost: { spend: 0, results: 0 } })).toBe("neutral");
  });
  it("reativação que passou a entregar → positive; gastou sem converter → negative", () => {
    expect(computeOutcome({ actionType: "resume_entity", entityPre: { spend: 0, results: 0 }, entityPost: { spend: 80, results: 8 } })).toBe("positive");
    expect(computeOutcome({ actionType: "resume_entity", entityPre: { spend: 0, results: 0 }, entityPost: { spend: 80, results: 0 } })).toBe("negative");
  });
  it("set_status → active é reativação (mesma medição do resume)", () => {
    expect(computeOutcome({ actionType: "set_status", params: { status: "active" }, entityPre: { spend: 0, results: 0 }, entityPost: { spend: 80, results: 8 } })).toBe("positive");
  });
  it("set_status → paused mede a CONTA (como pausa)", () => {
    const out = computeOutcome({
      actionType: "set_status",
      params: { status: "paused" },
      entityPre: { spend: 50, results: 0 },
      entityPost: { spend: 0, results: 0 },
      accountPre: { spend: 500, results: 40 },
      accountPost: { spend: 500, results: 50 },
    });
    expect(out).toBe("positive");
  });
  it("adjust_budget mode 'set' (absoluto) → neutral (direção indeterminável)", () => {
    expect(computeOutcome({ actionType: "adjust_budget", params: { mode: "set" }, entityPre: { spend: 100, results: 10 }, entityPost: { spend: 100, results: 5 } })).toBe("neutral");
  });
});

describe("manualChangeToAction", () => {
  it("ativo → pausado = pausa", () => {
    expect(manualChangeToAction({ status: "active" }, { status: "paused" })).toEqual({ actionType: "pause_entity", params: {} });
  });
  it("pausado → ativo = reativação", () => {
    expect(manualChangeToAction({ status: "paused" }, { status: "active" })).toEqual({ actionType: "resume_entity", params: {} });
  });
  it("orçamento subiu materialmente = escalar", () => {
    expect(manualChangeToAction({ status: "active", dailyBudgetMinor: 100 }, { status: "active", dailyBudgetMinor: 200 })).toEqual({ actionType: "adjust_budget", params: { mode: "increase" } });
  });
  it("orçamento caiu materialmente = reduzir", () => {
    expect(manualChangeToAction({ status: "active", dailyBudgetMinor: 200 }, { status: "active", dailyBudgetMinor: 100 })).toEqual({ actionType: "adjust_budget", params: { mode: "decrease" } });
  });
  it("variação pequena de orçamento → null (não material)", () => {
    expect(manualChangeToAction({ status: "active", dailyBudgetMinor: 100 }, { status: "active", dailyBudgetMinor: 105 })).toBeNull();
  });
  it("sem mudança → null", () => {
    expect(manualChangeToAction({ status: "active", dailyBudgetMinor: 100 }, { status: "active", dailyBudgetMinor: 100 })).toBeNull();
  });
});

// ─── calibração paramétrica (S6) ──────────────────────────────────────────
describe("proposalForCalibration / nextThresholdValue", () => {
  it("só calibração conservadora (direção lower) propõe limiar", () => {
    expect(proposalForCalibration("calibration", "pacing", "lower")?.threshold).toBe("marginalCpaWorsenPct");
    expect(proposalForCalibration("calibration", "budget", "lower")?.threshold).toBe("zombieMinSpend");
    expect(proposalForCalibration("fact", "pacing", "lower")).toBeNull();
    expect(proposalForCalibration("calibration", "tracking", "lower")).toBeNull();
  });
  it("prior AGRESSIVO (direção raise = escalar compensa) NUNCA propõe limiar", () => {
    expect(proposalForCalibration("calibration", "pacing", "raise")).toBeNull();
    expect(proposalForCalibration("calibration", "budget", "raise")).toBeNull();
  });
  it("aperta o limiar reduzindo do valor atual, respeitando o piso", () => {
    const p = proposalForCalibration("calibration", "pacing", "lower")!;
    expect(nextThresholdValue(20, p)).toBe(15); // 20 * 0.75
    expect(nextThresholdValue(6, p)).toBe(5); // piso 5
  });
});

// ─── redator ──────────────────────────────────────────────────────────────
describe("describeLessonForRedactor / fallbackLessonText", () => {
  it("monta payload estruturado e um texto de fallback determinístico em PT (prior de conta)", () => {
    const c = [{ externalId: "c1", name: "Camp", tier: "performer" as const }];
    const cands = detectFactCandidates({ runs: [runWith(c, "d1", true), runWith(c, "d2", true), runWith(c, "d3", true)] });
    const cand = cands.find((x) => x.key.dimension === "tracking");
    expect(cand).toBeDefined();
    if (!cand) return;
    const payload = describeLessonForRedactor(cand);
    expect(payload.dimension).toBe("tracking");
    expect(payload.scope).toBe("account");
    const text = fallbackLessonText(payload);
    expect(text.length).toBeGreaterThan(0);
  });
});

// ─── applyDecay / applyContradiction ──────────────────────────────────────
describe("applyDecay", () => {
  const cfg = { staleDays: 30, archiveDays: 60 };
  const now = new Date("2026-03-01T00:00:00.000Z");
  const daysAgo = (n: number): Date => new Date(now.getTime() - n * 24 * 60 * 60 * 1000);

  it("ativa sem reforço além do prazo → stale", () => {
    expect(applyDecay({ lifecycle: "active", lastReinforcedAt: daysAgo(31) }, now, cfg)).toBe("stale");
  });
  it("ativa recente → não muda", () => {
    expect(applyDecay({ lifecycle: "active", lastReinforcedAt: daysAgo(10) }, now, cfg)).toBeNull();
  });
  it("stale além do prazo de arquivo → archived", () => {
    expect(applyDecay({ lifecycle: "stale", lastReinforcedAt: daysAgo(61) }, now, cfg)).toBe("archived");
  });
  it("nunca pula ativa → archived num passo só", () => {
    // ativa há 61 dias: vira stale primeiro (um degrau por vez), não archived.
    expect(applyDecay({ lifecycle: "active", lastReinforcedAt: daysAgo(61) }, now, cfg)).toBe("stale");
  });
  it("sem carimbo de evidência → não decai (seguro)", () => {
    expect(applyDecay({ lifecycle: "active", lastReinforcedAt: null }, now, cfg)).toBeNull();
  });
  it("decayCutoffs deriva as datas de corte", () => {
    const { staleBefore, archiveBefore } = decayCutoffs(now, cfg);
    expect(staleBefore.toISOString()).toBe("2026-01-30T00:00:00.000Z");
    expect(archiveBefore.toISOString()).toBe("2025-12-31T00:00:00.000Z");
  });
});

describe("applyContradiction", () => {
  it("derruba a confiança", () => {
    const r = applyContradiction(0.5);
    expect(r.confidence).toBeLessThan(0.5);
  });
  it("rebaixa p/ stale quando cai abaixo do piso", () => {
    const r = applyContradiction(0.2);
    expect(r.confidence).toBeLessThan(CONTRADICTION_STALE_FLOOR);
    expect(r.demoteToStale).toBe(true);
  });
  it("confiança alta contradita cai mas não rebaixa ainda", () => {
    const r = applyContradiction(0.8);
    expect(r.demoteToStale).toBe(false);
  });
});

// ─── selectLessonsForBrief ────────────────────────────────────────────────
function lesson(partial: Partial<StoredLesson> & Pick<StoredLesson, "id" | "confidence">): StoredLesson {
  return {
    kind: "fact",
    key: { scope: "account", dimension: "pacing", direction: "lower" },
    content: "texto",
    confirmedByHuman: false,
    origin: "observational",
    lifecycle: "active",
    reinforceCount: 0,
    ...partial,
  };
}

describe("selectLessonsForBrief", () => {
  it("confirmada/alta confiança vai pro prompt; hipótese de conta lower vira guard (mesmo forte)", () => {
    const confirmed = lesson({ id: "a", confidence: 0.4, confirmedByHuman: true });
    const highConf = lesson({ id: "b", confidence: 0.8 }); // account:pacing:lower não-confirmada
    const lowHyp = lesson({ id: "c", confidence: 0.3 });
    const { prompt, guards } = selectLessonsForBrief([confirmed, highConf, lowHyp], 10);
    expect(prompt.map((p) => p.id).sort()).toEqual(["a", "b"]);
    // F-core-3: prior de conta lower não-confirmado alimenta o guard SEM depender da confiança —
    // o forte (b, 0,8) também, não só o fraco (c, 0,3). Confirmado (a) NÃO vira guard.
    expect(guards.map((g) => g.id).sort()).toEqual(["b", "c"]);
  });

  it("F-core-3: prior de conta lower forte recém-nascido (0,744) vai a prompt E guard", () => {
    const fresh = lesson({ id: "f", confidence: 0.74375, key: { scope: "account", dimension: "budget", direction: "lower" } });
    const { prompt, guards } = selectLessonsForBrief([fresh], 10);
    expect(prompt.map((p) => p.id)).toEqual(["f"]);
    expect(guards.map((g) => g.id)).toEqual(["f"]);
  });

  it("F-core-3: prior de conta lower CONFIRMADO sai do guard (só prompt)", () => {
    const conf = lesson({ id: "k", confidence: 0.9, confirmedByHuman: true, key: { scope: "account", dimension: "budget", direction: "lower" } });
    const { prompt, guards } = selectLessonsForBrief([conf], 10);
    expect(prompt.map((p) => p.id)).toEqual(["k"]);
    expect(guards).toEqual([]);
  });

  it("F-core-3: prior de conta RAISE (agressivo) nunca vira guard", () => {
    const raise = lesson({ id: "r", confidence: 0.3, key: { scope: "account", dimension: "pacing", direction: "raise" } });
    const { guards } = selectLessonsForBrief([raise], 10);
    expect(guards).toEqual([]);
  });

  it("F-core-4: ressalva de tracking observacional (0,30) entra no prompt como contexto, não vira guard", () => {
    const tracking = lesson({ id: "t", confidence: 0.3, origin: "observational", key: { scope: "account", dimension: "tracking", direction: "neutral" } });
    const { prompt, guards } = selectLessonsForBrief([tracking], 10);
    expect(prompt.map((p) => p.id)).toEqual(["t"]); // apareceria "explorando", mas aparece
    expect(guards).toEqual([]); // neutral não alimenta o guard
  });

  it("Fase 2 (cota por dimensão): uma dimensão forte NÃO crowda outra (diversidade)", () => {
    const budget = (id: string, confidence: number) => lesson({ id, confidence, key: { scope: "account", dimension: "budget", direction: "lower", pattern: "account_cut_pays" } });
    const creative = lesson({ id: "cr", confidence: 0.72, key: { scope: "account", dimension: "creative", direction: "neutral", pattern: "account_fatigue_timing" } });
    // 3 budget fortes + 1 criativo mais fraco, topK=2: top-confiança puro pegaria 2 budget e sumiria
    // com o criativo; a cota pega 1 de cada dimensão.
    const { prompt } = selectLessonsForBrief([budget("b1", 0.9), budget("b2", 0.85), budget("b3", 0.8), creative], 2);
    expect(prompt).toHaveLength(2);
    expect(prompt.map((p) => p.id)).toContain("cr"); // criativo preservado pela cota
    expect(prompt.map((p) => p.id)).toContain("b1"); // + o budget mais forte
  });

  it("respeita o teto top-K no prompt (ordena por confiança)", () => {
    const lessons = [
      lesson({ id: "a", confidence: 0.9, confirmedByHuman: true }),
      lesson({ id: "b", confidence: 0.85, confirmedByHuman: true }),
      lesson({ id: "c", confidence: 0.8, confirmedByHuman: true }),
    ];
    const { prompt } = selectLessonsForBrief(lessons, 2);
    expect(prompt).toHaveLength(2);
    expect(prompt.map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("ignora lições não-ativas", () => {
    const archived = lesson({ id: "a", confidence: 0.9, confirmedByHuman: true, lifecycle: "archived" });
    const stale = lesson({ id: "b", confidence: 0.9, confirmedByHuman: true, lifecycle: "stale" });
    const { prompt, guards } = selectLessonsForBrief([archived, stale], 10);
    expect(prompt).toEqual([]);
    expect(guards).toEqual([]);
  });
});

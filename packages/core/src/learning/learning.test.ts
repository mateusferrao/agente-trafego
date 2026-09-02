import { describe, expect, it } from "vitest";
import {
  CONTRADICTION_STALE_FLOOR,
  OBSERVATIONAL_CONFIDENCE_CAP,
  PROMPT_CONFIDENCE_THRESHOLD,
  applyContradiction,
  applyDecay,
  computeConfidence,
  confidenceTier,
  decayCutoffs,
  describeLessonForRedactor,
  detectFactCandidates,
  fallbackLessonText,
  lessonKeyOf,
  selectLessonsForBrief,
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

  it("detecta zumbi persistente numa campanha e emite lição fact/budget/lower/entity", () => {
    const zombie = [{ externalId: "c1", name: "Institucional", tier: "zombie" as const }];
    const runs = [
      runWith(zombie, "2026-01-01"),
      runWith(zombie, "2026-01-02"),
      runWith(zombie, "2026-01-03"),
      runWith(zombie, "2026-01-04"),
    ];
    const out = detectFactCandidates({ runs });
    const zombieLesson = out.find((c) => c.key.subjectId === "c1");
    expect(zombieLesson).toBeDefined();
    expect(zombieLesson?.kind).toBe("fact");
    expect(zombieLesson?.key.scope).toBe("entity");
    expect(zombieLesson?.key.dimension).toBe("budget");
    expect(zombieLesson?.key.direction).toBe("lower");
    expect(zombieLesson?.origin).toBe("observational");
    expect(zombieLesson?.confidence).toBeGreaterThan(0);
    expect(zombieLesson?.confidence).toBeLessThan(PROMPT_CONFIDENCE_THRESHOLD);
  });

  it("não emite quando o padrão é esporádico (abaixo do ratio)", () => {
    const zombie = [{ externalId: "c1", name: "Camp 1", tier: "zombie" as const }];
    const ok = [{ externalId: "c1", name: "Camp 1", tier: "performer" as const }];
    const runs = [runWith(zombie, "d1"), runWith(ok, "d2"), runWith(ok, "d3"), runWith(ok, "d4")];
    expect(detectFactCandidates({ runs }).find((c) => c.key.subjectId === "c1")).toBeUndefined();
  });

  it("detecta fadiga de criativo recorrente → dimensão creative", () => {
    const fatigued = [{ externalId: "c2", name: "Promo", tier: "performer" as const, healthSignals: ["creative_fatigue" as const] }];
    const runs = [runWith(fatigued, "d1"), runWith(fatigued, "d2"), runWith(fatigued, "d3")];
    const lesson = detectFactCandidates({ runs }).find((c) => c.key.dimension === "creative");
    expect(lesson).toBeDefined();
    expect(lesson?.key.subjectId).toBe("c2");
  });

  it("detecta tracking suspeito recorrente → dimensão tracking, escopo conta", () => {
    const c = [{ externalId: "c1", name: "Camp", tier: "performer" as const }];
    const runs = [runWith(c, "d1", true), runWith(c, "d2", true), runWith(c, "d3", true)];
    const lesson = detectFactCandidates({ runs }).find((x) => x.key.dimension === "tracking");
    expect(lesson).toBeDefined();
    expect(lesson?.key.scope).toBe("account");
  });
});

// ─── redator ──────────────────────────────────────────────────────────────
describe("describeLessonForRedactor / fallbackLessonText", () => {
  it("monta payload estruturado e um texto de fallback determinístico em PT", () => {
    const cands = detectFactCandidates({
      runs: [
        runWith([{ externalId: "c1", name: "Institucional", tier: "zombie" }], "d1"),
        runWith([{ externalId: "c1", name: "Institucional", tier: "zombie" }], "d2"),
        runWith([{ externalId: "c1", name: "Institucional", tier: "zombie" }], "d3"),
      ],
    });
    const cand = cands[0];
    expect(cand).toBeDefined();
    if (!cand) return;
    const payload = describeLessonForRedactor(cand);
    expect(payload.subjectName).toBe("Institucional");
    expect(payload.dimension).toBe("budget");
    const text = fallbackLessonText(payload);
    expect(text).toContain("Institucional");
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
  it("confirmada/alta confiança vai pro prompt; baixa vira guard", () => {
    const confirmed = lesson({ id: "a", confidence: 0.4, confirmedByHuman: true });
    const highConf = lesson({ id: "b", confidence: 0.8 });
    const lowHyp = lesson({ id: "c", confidence: 0.3 });
    const { prompt, guards } = selectLessonsForBrief([confirmed, highConf, lowHyp], 10);
    expect(prompt.map((p) => p.id).sort()).toEqual(["a", "b"]);
    expect(guards.map((g) => g.id)).toEqual(["c"]);
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

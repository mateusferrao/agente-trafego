import { z } from "zod";
import { LESSON_CONFIDENCE_TIERS, LESSON_ORIGINS, LESSON_SCOPES } from "@trafego/core";

// Aprendizado contínuo — contrato de leitura da aba "Aprendizados" (S1, read-only).
// A UI mostra a frase, o selo de confiança (tier), a origem e o escopo; edição/
// confirmação/esquecer entram na S5.
// Tier/origem/escopo reusam as tuplas canônicas de @trafego/core (§13 fonte única — sem
// re-declarar os literais, que sairiam do sincronismo se a tupla do core mudasse).

export const lessonTier = z.enum(LESSON_CONFIDENCE_TIERS);
export const lessonOrigin = z.enum(LESSON_ORIGINS);
export const lessonKindSchema = z.enum(["fact", "calibration"]);
export const lessonScope = z.enum(LESSON_SCOPES);

export const learningItem = z.object({
  id: z.string(),
  kind: lessonKindSchema,
  content: z.string(),
  tier: lessonTier,
  origin: lessonOrigin,
  scope: lessonScope,
  dimension: z.string().nullable(),
  confirmedByHuman: z.boolean(),
  lifecycle: z.enum(["active", "stale", "archived"]),
  reinforceCount: z.number().int(),
  sourceRunId: z.string().nullable(),
  createdAt: z.string(),
  /** proposta de ajuste de comportamento (calibração paramétrica, S6) — null quando não há. */
  proposedBehavior: z.string().nullable(),
  /** ajuste de comportamento já APLICADO (revertível, v3) — null quando não há. */
  appliedBehavior: z.string().nullable(),
});
export type LearningItem = z.infer<typeof learningItem>;

/** Aviso de OPORTUNIDADE de teto (v3, "sinal vivo") — derivado do último run; não é aprendizado. */
export const learningOpportunity = z.object({
  key: z.string(),
  threshold: z.string(),
  wantedPct: z.number(),
  cappedPct: z.number(),
  /** unidade menor da moeda que o teto está deixando na mesa por dia. */
  foregoneMinor: z.number(),
  /** já em unidade MAIOR (o front formata com `money()` + `currency` — sem hardcodar R$ nem /100). */
  foregoneMajor: z.number(),
  /** moeda da conta (ISO) — o símbolo/locale certo vem daqui, não de "R$" fixo. */
  currency: z.string(),
});
export type LearningOpportunity = z.infer<typeof learningOpportunity>;

export const learningsList = z.object({
  items: z.array(learningItem),
  opportunities: z.array(learningOpportunity),
  /** aprendizados arquivados (zona recolhida — filtro/busca + restaurar). */
  archived: z.array(learningItem),
});
export type LearningsList = z.infer<typeof learningsList>;

/** Editar a frase de um aprendizado (o usuário reescreve com as próprias palavras). */
export const editLearningInput = z.object({ content: z.string().min(1).max(2000) });
export type EditLearningInput = z.infer<typeof editLearningInput>;

export const learningOk = z.object({ ok: z.boolean() });
export type LearningOk = z.infer<typeof learningOk>;

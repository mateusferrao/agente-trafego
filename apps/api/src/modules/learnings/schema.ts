import { z } from "zod";

// Aprendizado contínuo — contrato de leitura da aba "Aprendizados" (S1, read-only).
// A UI mostra a frase, o selo de confiança (tier), a origem e o escopo; edição/
// confirmação/esquecer entram na S5.

export const lessonTier = z.enum(["explorando", "provavel", "confirmado"]);
export const lessonOrigin = z.enum(["our_action", "observational", "human_feedback", "human_manual"]);
export const lessonKindSchema = z.enum(["fact", "calibration"]);
export const lessonScope = z.enum(["entity", "account", "org", "global"]);

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
});
export type LearningItem = z.infer<typeof learningItem>;

export const learningsList = z.object({ items: z.array(learningItem) });
export type LearningsList = z.infer<typeof learningsList>;

/** Editar a frase de um aprendizado (o usuário reescreve com as próprias palavras). */
export const editLearningInput = z.object({ content: z.string().min(1).max(2000) });
export type EditLearningInput = z.infer<typeof editLearningInput>;

export const learningOk = z.object({ ok: z.boolean() });
export type LearningOk = z.infer<typeof learningOk>;

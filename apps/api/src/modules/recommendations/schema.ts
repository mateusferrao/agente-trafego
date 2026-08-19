import { z } from "zod";

// 👍/👎 numa recomendação (site-only; reply no WhatsApp = 5b). 👎 vira memória
// "rejeitado" p/ o agente não repetir (loop de feedback barato — §7/§12).
export const feedbackInput = z.object({
  vote: z.enum(["up", "down"]),
  note: z.string().max(2000).optional(),
});
export type FeedbackInput = z.infer<typeof feedbackInput>;

export const feedbackOutput = z.object({ ok: z.boolean() });
export type FeedbackOutput = z.infer<typeof feedbackOutput>;

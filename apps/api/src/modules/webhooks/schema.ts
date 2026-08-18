import { z } from "zod";

// O payload cru da Evolution é opaco/variável — validação fina fica no adapter
// (messaging.parseInbound). Aqui só garantimos que é objeto.
export const evolutionWebhookParams = z.object({
  instanceId: z.string().min(1),
});
export type EvolutionWebhookParams = z.infer<typeof evolutionWebhookParams>;

export const evolutionWebhookBody = z.record(z.unknown());
export type EvolutionWebhookBody = z.infer<typeof evolutionWebhookBody>;

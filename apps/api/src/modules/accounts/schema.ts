import { z } from "zod";

export const adAccountOutput = z.object({
  id: z.string(),
  adAccountId: z.string(),
  name: z.string().nullable(),
  currency: z.string().nullable(),
  /** Ciclo de vida sob gestão. Contas listadas são sempre `active` no MVP. */
  status: z.enum(["active", "unavailable", "removed"]),
  /** Token status efetivo (o da conexão dona do token). */
  tokenStatus: z.enum(["valid", "invalid", "unchecked"]),
  lastValidatedAt: z.string().nullable(),
});
export type AdAccountOutput = z.infer<typeof adAccountOutput>;

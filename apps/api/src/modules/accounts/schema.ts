import { z } from "zod";

// Onboarding Meta (§9): cola System User token → valida → lista contas → escolhe.
export const connectTokenInput = z.object({
  /** System User token colado (não expira). Nunca logar. */
  token: z.string().min(20),
});
export type ConnectTokenInput = z.infer<typeof connectTokenInput>;

export const accessibleAccount = z.object({
  id: z.string(),
  name: z.string(),
});
export type AccessibleAccount = z.infer<typeof accessibleAccount>;

export const selectAccountInput = z.object({
  adAccountId: z.string().min(1),
});
export type SelectAccountInput = z.infer<typeof selectAccountInput>;

export const adAccountOutput = z.object({
  id: z.string(),
  adAccountId: z.string(),
  tokenStatus: z.enum(["valid", "invalid", "unchecked"]),
  lastValidatedAt: z.string().nullable(),
});
export type AdAccountOutput = z.infer<typeof adAccountOutput>;

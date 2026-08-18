import { z } from "zod";

/** Comprimento mínimo defensivo do System User token (nunca logar). */
const TOKEN_MIN_LENGTH = 20;

// Onboarding Meta (§9): cola System User token → valida → lista contas → escolhe.
export const connectTokenInput = z.object({
  /** System User token colado (não expira). Nunca logar. */
  token: z.string().min(TOKEN_MIN_LENGTH),
});
export type ConnectTokenInput = z.infer<typeof connectTokenInput>;

/** Conta acessível pelo token (exibida no passo de seleção). */
export const accessibleAccount = z.object({
  id: z.string(),
  name: z.string(),
  currency: z.string().optional(),
});
export type AccessibleAccount = z.infer<typeof accessibleAccount>;

/** Resposta do /connect: as contas que o token pode acessar. */
export const connectAccountsOutput = z.object({
  accounts: z.array(accessibleAccount),
});
export type ConnectAccountsOutput = z.infer<typeof connectAccountsOutput>;

// O token é reenviado do cliente (stateless — nada de token pendente no servidor).
export const selectAccountInput = z.object({
  token: z.string().min(TOKEN_MIN_LENGTH),
  adAccountId: z.string().min(1),
});
export type SelectAccountInput = z.infer<typeof selectAccountInput>;

export const adAccountOutput = z.object({
  id: z.string(),
  adAccountId: z.string(),
  name: z.string().nullable(),
  currency: z.string().nullable(),
  tokenStatus: z.enum(["valid", "invalid", "unchecked"]),
  lastValidatedAt: z.string().nullable(),
});
export type AdAccountOutput = z.infer<typeof adAccountOutput>;

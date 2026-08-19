import { z } from "zod";

/** Comprimento mínimo defensivo do System User token (nunca logar). */
const TOKEN_MIN_LENGTH = 20;
const platform = z.enum(["meta"]);
const tokenStatus = z.enum(["valid", "invalid", "unchecked"]);
const lifecycle = z.enum(["active", "unavailable", "removed"]);

/** Conexão com um sistema externo (colar token → cria a conexão dona do token). */
export const createConnectionInput = z.object({
  token: z.string().min(TOKEN_MIN_LENGTH),
});
export type CreateConnectionInput = z.infer<typeof createConnectionInput>;

/** Conta de anúncio acessível pela conexão (id sem prefixo `act_`). */
export const connectionAccount = z.object({
  id: z.string(),
  name: z.string(),
  currency: z.string().optional(),
});
export type ConnectionAccount = z.infer<typeof connectionAccount>;

/** Conta já sob gestão desta conexão + seu ciclo de vida. */
export const managedAccountRef = z.object({
  adAccountId: z.string(),
  status: lifecycle,
});
export type ManagedAccountRef = z.infer<typeof managedAccountRef>;

/** Conexão exibida em Integrações. */
export const connectionOutput = z.object({
  id: z.string(),
  platform,
  label: z.string().nullable(),
  externalBusinessId: z.string().nullable(),
  tokenStatus,
  lastValidatedAt: z.string().nullable(),
  lastSyncedAt: z.string().nullable(),
  /** contas ativas sob esta conexão. */
  accountsCount: z.number(),
});
export type ConnectionOutput = z.infer<typeof connectionOutput>;

/** Resposta do POST /connections: a conexão criada + contas p/ escolher já. */
export const createConnectionOutput = z.object({
  connection: connectionOutput,
  available: z.array(connectionAccount),
});
export type CreateConnectionOutput = z.infer<typeof createConnectionOutput>;

/** Contas de uma conexão: acessíveis na plataforma + as já geridas. */
export const connectionAccountsOutput = z.object({
  available: z.array(connectionAccount),
  managed: z.array(managedAccountRef),
});
export type ConnectionAccountsOutput = z.infer<typeof connectionAccountsOutput>;

/** Param `:id` da conexão (validado na borda — alinha contrato↔runtime). */
export const connectionParams = z.object({ id: z.string().uuid() });

/** Multi-seleção do dono: os ad account ids que devem ficar ativos. */
export const selectAccountsInput = z.object({
  adAccountIds: z.array(z.string()),
});
export type SelectAccountsInput = z.infer<typeof selectAccountsInput>;

/** Resumo do que a sincronização reconciliou (feedback em toast na UI). */
export const syncOutput = z.object({
  available: z.array(connectionAccount),
  managed: z.array(managedAccountRef),
  changes: z.object({
    reactivated: z.number(),
    markedUnavailable: z.number(),
    newAvailable: z.number(),
    connectedElsewhere: z.number(),
  }),
});
export type SyncOutput = z.infer<typeof syncOutput>;

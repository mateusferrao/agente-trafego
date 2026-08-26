import { z } from "zod";
import { marketReferenceSchema } from "@trafego/shared";

export const createOrgInput = z.object({
  name: z.string().min(2),
});
export type CreateOrgInput = z.infer<typeof createOrgInput>;

// Renomear = mudar só o nome de exibição (slug permanece estável — identidade durável).
export const renameOrgInput = z.object({
  name: z.string().min(2),
});
export type RenameOrgInput = z.infer<typeof renameOrgInput>;

// Fuso da org (Fatia 4) — usado p/ avaliar a cadência das análises. IANA tz string.
export const setTimezoneInput = z.object({ timezone: z.string().min(1) });
export type SetTimezoneInput = z.infer<typeof setTimezoneInput>;

export const orgOutput = z.object({
  id: z.string(),
  name: z.string(),
  role: z.enum(["owner", "member"]),
  /** fuso horário (IANA) da org — default BR até o dono mudar. */
  timezone: z.string(),
});
export type OrgOutput = z.infer<typeof orgOutput>;

// Referência de mercado padrão da org (pivô) — faixas base do mercado do usuário.
// `null` = não configurada (não usa como contexto). Editável só pelo owner.
export const setMarketReferenceInput = z.object({
  marketReference: marketReferenceSchema.nullable(),
});
export type SetMarketReferenceInput = z.infer<typeof setMarketReferenceInput>;

export const marketReferenceOutput = z.object({
  marketReference: marketReferenceSchema.nullable(),
});
export type MarketReferenceOutput = z.infer<typeof marketReferenceOutput>;

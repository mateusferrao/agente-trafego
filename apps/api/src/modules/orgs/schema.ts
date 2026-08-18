import { z } from "zod";

export const createOrgInput = z.object({
  name: z.string().min(2),
});
export type CreateOrgInput = z.infer<typeof createOrgInput>;

// Renomear = mudar só o nome de exibição (slug permanece estável — identidade durável).
export const renameOrgInput = z.object({
  name: z.string().min(2),
});
export type RenameOrgInput = z.infer<typeof renameOrgInput>;

export const orgOutput = z.object({
  id: z.string(),
  name: z.string(),
  role: z.enum(["owner", "member"]),
});
export type OrgOutput = z.infer<typeof orgOutput>;

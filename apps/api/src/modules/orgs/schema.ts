import { z } from "zod";

export const createOrgInput = z.object({
  name: z.string().min(2),
});
export type CreateOrgInput = z.infer<typeof createOrgInput>;

export const orgOutput = z.object({
  id: z.string(),
  name: z.string(),
  role: z.enum(["owner", "member"]),
});
export type OrgOutput = z.infer<typeof orgOutput>;

import { z } from "zod";

// DTOs do slice de auth (zod nas bordas → também alimentam OpenAPI).
export const loginInput = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});
export type LoginInput = z.infer<typeof loginInput>;

export const meOutput = z.object({
  userId: z.string(),
  email: z.string().email(),
  orgId: z.string().nullable(),
});
export type MeOutput = z.infer<typeof meOutput>;

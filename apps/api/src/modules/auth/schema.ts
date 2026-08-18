import { z } from "zod";

// Email normalizado na borda: `trim` + lowercase → evita contas duplicadas por
// caixa (User@x.com vs user@x.com) e login case-sensitive. Mesma normalização
// vale p/ lookup e insert (o service usa sempre o valor parseado).
const emailInput = z
  .string()
  .trim()
  .email()
  .transform((v) => v.toLowerCase());

// DTOs do slice de auth (zod nas bordas → também alimentam OpenAPI).
export const signupInput = z.object({
  name: z.string().min(1),
  email: emailInput,
  password: z.string().min(8),
  orgName: z.string().min(2),
});
export type SignupInput = z.infer<typeof signupInput>;

export const loginInput = z.object({
  email: emailInput,
  password: z.string().min(8),
});
export type LoginInput = z.infer<typeof loginInput>;

// Sessão corrente (retorno de login/signup e de GET /me). Refinado na 1a.2.
export const meOutput = z.object({
  userId: z.string(),
  email: z.string().email(),
  name: z.string().nullable(),
  orgId: z.string().nullable(),
  orgName: z.string().nullable(),
  role: z.enum(["owner", "member"]).nullable(),
  // status de acesso ao produto (gate); nome durável pós-beta.
  accessStatus: z.enum(["pending", "active", "revoked"]).nullable(),
});
export type MeOutput = z.infer<typeof meOutput>;

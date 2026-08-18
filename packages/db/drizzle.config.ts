import { defineConfig } from "drizzle-kit";

/**
 * Config do Drizzle Kit. Migrations só via `pnpm db:generate` (nunca SQL à mão).
 * Lê a conexão de DATABASE_URL (ver .env.example).
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dbCredentials: {
    // TODO: validar via packages/config (schema zod no boot). Aqui é só o Kit CLI.
    url: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/trafego",
  },
  casing: "snake_case",
  verbose: true,
  strict: true,
});

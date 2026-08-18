/**
 * A validação canônica de env vive em `@trafego/config` (schema zod, fail-fast
 * no boot — cobre TODAS as vars do `.env.example`). A casca HTTP só reexporta o
 * env já validado; não duplica schema (reuso-primeiro / sem string mágica).
 */
import { loadEnv, type Env } from "@trafego/config";

export type { Env };

export const env: Env = loadEnv();

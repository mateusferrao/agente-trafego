/**
 * Backfill ONE-TIME do PADRÃO na chave de aprendizado (Fase 2). A chave passou de
 * `scope:dimensão:direção` (1 lição por dim/dir) para `scope:dimensão:direção:padrão` (N por
 * dimensão). Linhas antigas têm 3 segmentos e `pattern` NULL → o código novo geraria chave de 4
 * segmentos e NÃO casaria a linha antiga (inseriria duplicata). Este backfill deriva o padrão de
 * (dimensão,direção) — determinístico, 1:1 no v3 — preenche a coluna `pattern` e reescreve a
 * `semantic_key` p/ 4 segmentos.
 *
 * IDEMPOTENTE: só toca linhas com `pattern` NULL e chave ainda de 3 segmentos; rerun = no-op.
 * Uso: pnpm backfill:learning-pattern
 */
import { sql } from "drizzle-orm";
import { createDb } from "@trafego/db";
import { loadEnv } from "@trafego/config";

async function main(): Promise<void> {
  const env = loadEnv();
  const db = createDb(env.DATABASE_URL);

  // 1) deriva o padrão de (dimensão,direção) — mesma tabela do core (ACCOUNT_PATTERN + temporais/tracking).
  const setPattern = await db.execute(sql`
    UPDATE agent_memory SET pattern = CASE
      WHEN dimension='budget'     AND direction='lower'   THEN 'account_cut_pays'
      WHEN dimension='pacing'     AND direction='lower'   THEN 'account_scale_backfires'
      WHEN dimension='pacing'     AND direction='raise'   THEN 'account_scale_pays'
      WHEN dimension='creative'   AND direction='neutral' THEN 'account_fatigue_timing'
      WHEN dimension='conversion' AND direction='neutral' THEN 'account_conversion_lag'
      WHEN dimension='tracking'   AND direction='neutral' THEN 'recurring_tracking_suspect'
    END
    WHERE semantic_key IS NOT NULL AND scope='account' AND pattern IS NULL
      AND (dimension, direction) IN (
        ('budget','lower'),('pacing','lower'),('pacing','raise'),
        ('creative','neutral'),('conversion','neutral'),('tracking','neutral')
      )
  `);

  // 2) reescreve a semantic_key p/ incluir o padrão — SÓ chaves ainda de 3 segmentos (scope:dim:dir),
  //    sem subjectId (prior de conta). Idempotente: após reescrever, deixa de casar a condição.
  const rewriteKey = await db.execute(sql`
    UPDATE agent_memory
    SET semantic_key = scope || ':' || dimension || ':' || direction || ':' || pattern,
        updated_at = now()
    WHERE pattern IS NOT NULL
      AND semantic_key = scope || ':' || dimension || ':' || direction
  `);

  console.log(`✓ pattern preenchido: ${setPattern.rowCount ?? 0} · semantic_key reescrita: ${rewriteKey.rowCount ?? 0}`);
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error("falha no backfill:", err);
  process.exit(1);
});

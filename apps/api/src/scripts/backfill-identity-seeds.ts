/**
 * Backfill ONE-TIME dos seeds de identidade (refactor de voz): os seeds de
 * `persona`/`tone` por arquétipo foram reescopados — persona vira papel puro e
 * tom vira afeto (não mais duplicando a postura). Agentes semeados com os valores
 * ANTIGOS (não editados pelo dono) recebem os valores NOVOS; valor customizado
 * (≠ seed antigo) fica intacto.
 *
 * IDEMPOTENTE: só toca linhas cujo valor é EXATAMENTE o seed antigo do arquétipo;
 * rerun não faz nada. Os valores NOVOS vêm de `archetypeDefaults` (fonte única).
 * Uso:
 *   pnpm backfill:identity-seeds
 */
import { and, eq, sql } from "drizzle-orm";
import { createDb, agents } from "@trafego/db";
import { archetypeDefaults } from "@trafego/core";
import { loadEnv } from "@trafego/config";

/** Seeds ANTIGOS por arquétipo (histórico — não importáveis, pois o código já mudou). */
const OLD_SEEDS: Readonly<Record<string, { persona: string; tone: string }>> = {
  conservador: {
    persona: "Gestor de tráfego pago que analisa a conta e sugere melhorias com cautela.",
    tone: "consultivo, claro e sem jargão",
  },
  otimizador: {
    persona: "Gestor de tráfego focado em eficiência: protege o que converte e corta o desperdício.",
    tone: "direto, orientado a número, sem rodeio",
  },
  vigia_intensivo: {
    persona: "Vigia intensivo: monitora de perto e alerta cedo pra não perder o timing em momento crítico.",
    tone: "atento, ágil, direto ao ponto; alerta cedo sem alarmismo",
  },
};

async function main(): Promise<void> {
  const env = loadEnv();
  const db = createDb(env.DATABASE_URL);

  let personaMigrated = 0;
  let toneMigrated = 0;
  for (const [key, old] of Object.entries(OLD_SEEDS)) {
    const next = archetypeDefaults(key);
    // persona e tom migram INDEPENDENTES (o dono pode ter editado só um).
    const p = await db
      .update(agents)
      .set({ persona: next.persona, updatedAt: sql`now()` })
      .where(and(eq(agents.archetype, key), eq(agents.persona, old.persona)))
      .returning({ id: agents.id });
    const t = await db
      .update(agents)
      .set({ tone: next.tone, updatedAt: sql`now()` })
      .where(and(eq(agents.archetype, key), eq(agents.tone, old.tone)))
      .returning({ id: agents.id });
    personaMigrated += p.length;
    toneMigrated += t.length;
  }
  console.log(`✓ seeds de identidade migrados — persona: ${personaMigrated}, tom: ${toneMigrated}`);

  process.exit(0);
}

main().catch((err: unknown) => {
  console.error("falha no backfill:", err);
  process.exit(1);
});

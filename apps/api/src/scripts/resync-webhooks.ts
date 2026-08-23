/**
 * Backfill ONE-TIME: re-registra o webhook Evolution (`webhook/set`) das instâncias
 * JÁ conectadas. Motivo: a config do webhook mudou (`base64: false` → `true`, pra
 * entregar áudio inline) e só é re-escrita dentro do fluxo `connect()` — instâncias
 * pareadas ANTES desse deploy ficam com a config antiga até re-parear manualmente.
 * Idempotente (sobrescreve a mesma config sempre) — seguro rodar mais de uma vez.
 *
 * Uso: `tsx --env-file=.env apps/api/src/scripts/resync-webhooks.ts`
 */
import { eq } from "drizzle-orm";
import { createDb, channelInstances } from "@trafego/db";
import { loadEnv } from "@trafego/config";
import { EvolutionAdapter, EvolutionClient } from "@trafego/channel-evolution";

async function main(): Promise<void> {
  const env = loadEnv();
  const db = createDb(env.DATABASE_URL);
  const messaging = new EvolutionAdapter({
    client: new EvolutionClient({ baseUrl: env.EVOLUTION_BASE_URL, apiKey: env.EVOLUTION_API_KEY }),
    apiOrigin: env.API_ORIGIN,
  });

  const instances = await db
    .select({ evolutionInstance: channelInstances.evolutionInstance, webhookSecret: channelInstances.webhookSecret })
    .from(channelInstances)
    .where(eq(channelInstances.status, "connected"));

  for (const row of instances) {
    await messaging.syncWebhook({ instanceId: row.evolutionInstance, webhookSecret: row.webhookSecret });
    console.log(`✓ webhook re-registrado: ${row.evolutionInstance}`);
  }
  console.log(`✓ resync concluído: ${instances.length} instância(s) conectada(s)`);
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error("falha no resync de webhooks:", err);
  process.exit(1);
});

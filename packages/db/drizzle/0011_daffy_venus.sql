--> USING adicionado à mão: Drizzle não gera a cláusula de cast p/ text→jsonb.
--> Backfill idempotente: cron legado (text) vira CadenceSpec {kind:'raw',cron}; null→null.
ALTER TABLE "agents" ALTER COLUMN "cadence" SET DATA TYPE jsonb USING (
  CASE WHEN "cadence" IS NULL OR "cadence" = '' THEN NULL
       ELSE jsonb_build_object('kind', 'raw', 'cron', "cadence")
  END
);--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "timezone" text DEFAULT 'America/Sao_Paulo' NOT NULL;
CREATE TYPE "public"."recommendation_kind" AS ENUM('platform_action', 'human_direction', 'insight');--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN "kind" "recommendation_kind" DEFAULT 'platform_action' NOT NULL;--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN "tool_key" text;--> statement-breakpoint
-- backfill (S2): recomendações legadas SEM ação eram consultivas → viram insight
-- (o default de coluna cobriu as com ação como platform_action). Idempotente.
UPDATE "recommendations" SET "kind" = 'insight' WHERE "proposed_action" IS NULL;
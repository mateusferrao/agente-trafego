CREATE TYPE "public"."lesson_dimension" AS ENUM('pacing', 'creative', 'audience', 'tracking', 'budget', 'significance', 'conversion', 'other');--> statement-breakpoint
CREATE TYPE "public"."memory_direction" AS ENUM('raise', 'lower', 'neutral');--> statement-breakpoint
CREATE TYPE "public"."memory_origin" AS ENUM('our_action', 'observational', 'human_feedback', 'human_manual');--> statement-breakpoint
CREATE TYPE "public"."memory_scope" AS ENUM('entity', 'account', 'org', 'global');--> statement-breakpoint
ALTER TABLE "agent_memory" ADD COLUMN "scope" "memory_scope" DEFAULT 'account' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_memory" ADD COLUMN "dimension" "lesson_dimension";--> statement-breakpoint
ALTER TABLE "agent_memory" ADD COLUMN "direction" "memory_direction";--> statement-breakpoint
ALTER TABLE "agent_memory" ADD COLUMN "subject_id" text;--> statement-breakpoint
ALTER TABLE "agent_memory" ADD COLUMN "origin" "memory_origin" DEFAULT 'human_feedback' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_memory" ADD COLUMN "semantic_key" text;--> statement-breakpoint
ALTER TABLE "agent_memory" ADD COLUMN "reinforce_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_memory" ADD COLUMN "last_reinforced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_memory" ADD COLUMN "last_contradicted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_memory" ADD COLUMN "confirmed_by_human" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_memory" ADD COLUMN "source_run_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_memory" ADD COLUMN "source_recommendation_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_memory" ADD COLUMN "proposed_threshold_patch" jsonb;--> statement-breakpoint
CREATE INDEX "agent_memory_agent_type_lifecycle_idx" ON "agent_memory" USING btree ("agent_id","type","lifecycle");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_memory_agent_semantic_key_uq" ON "agent_memory" USING btree ("agent_id","semantic_key") WHERE "agent_memory"."semantic_key" is not null and "agent_memory"."lifecycle" <> 'archived';
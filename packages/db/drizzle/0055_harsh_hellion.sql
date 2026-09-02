ALTER TABLE "agent_memory" ADD COLUMN "applied_threshold_patch" jsonb;--> statement-breakpoint
ALTER TABLE "agent_memory" ADD COLUMN "threshold_resolved_at" timestamp with time zone;
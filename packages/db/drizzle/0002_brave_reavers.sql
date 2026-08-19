ALTER TABLE "agent_runs" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "partial" boolean DEFAULT false NOT NULL;
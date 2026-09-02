ALTER TABLE "recommendations" ADD COLUMN "expected_impact" text;--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN "what_to_monitor" text;--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN "finding_refs" jsonb;
ALTER TYPE "public"."approval_status" ADD VALUE 'blocked';--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "agent_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "entity_level" "entity_level" NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "entity_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "action_type" "action_type" NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "action" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "resolved_reason" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approvals_agent_status_idx" ON "approvals" USING btree ("agent_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_pending_uq" ON "approvals" USING btree ("agent_id","entity_level","entity_id","action_type") WHERE status = 'pending';
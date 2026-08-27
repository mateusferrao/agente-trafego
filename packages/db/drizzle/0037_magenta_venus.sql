ALTER TABLE "approvals" ALTER COLUMN "entity_level" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ALTER COLUMN "entity_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ALTER COLUMN "action_type" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ALTER COLUMN "action" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "draft_id" uuid;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_draft_id_campaign_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."campaign_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approvals_draft_idx" ON "approvals" USING btree ("draft_id");--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_action_xor_draft" CHECK (("approvals"."action" is not null and "approvals"."draft_id" is null) or ("approvals"."action" is null and "approvals"."draft_id" is not null));
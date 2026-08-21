ALTER TABLE "usage_events" ADD COLUMN "ad_account_id" uuid;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_ad_account_id_ad_accounts_id_fk" FOREIGN KEY ("ad_account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "usage_events_account_idx" ON "usage_events" USING btree ("ad_account_id");
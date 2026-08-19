ALTER TABLE "contacts" ADD COLUMN "verification_code_hash" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "verification_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_one_in_flight_uq" ON "agent_runs" USING btree ("agent_id") WHERE status in ('pending', 'running', 'waiting_approval');--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_org_phone_uq" UNIQUE("org_id","phone");
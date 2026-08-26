CREATE TYPE "public"."activity_state" AS ENUM('active', 'dormant');--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "notify_policy" SET DEFAULT '{"pulse":{"enabled":false,"cadence":{"kind":"weekly","weekday":1,"hour":8}},"alerts":{"enabled":false,"sensitivity":"normal","throttleHours":6},"runPush":{"enabled":true},"reactivation":{"enabled":false}}'::jsonb;--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD COLUMN "last_activity_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD COLUMN "activity_state" "activity_state" DEFAULT 'active' NOT NULL;
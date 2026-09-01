ALTER TABLE "ad_accounts" ADD COLUMN "meta_account_status" text;--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD COLUMN "meta_disable_reason" text;--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD COLUMN "meta_balance" numeric(12, 4);--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD COLUMN "meta_amount_spent" numeric(12, 4);--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD COLUMN "meta_spend_cap" numeric(12, 4);--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD COLUMN "meta_payment_method_label" text;--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD COLUMN "meta_funding_type" text;--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD COLUMN "meta_health_checked_at" timestamp with time zone;
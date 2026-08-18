ALTER TABLE "ad_accounts" ALTER COLUMN "meta_business_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD CONSTRAINT "ad_accounts_org_account_uq" UNIQUE("org_id","ad_account_id");
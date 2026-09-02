CREATE TYPE "public"."breakdown_dimension" AS ENUM('demographic', 'placement');--> statement-breakpoint
CREATE TABLE "insights_breakdowns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"ad_account_id" uuid NOT NULL,
	"entity_level" "entity_level" NOT NULL,
	"entity_id" text NOT NULL,
	"dimension" "breakdown_dimension" NOT NULL,
	"segments" jsonb NOT NULL,
	"date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "insights_breakdowns" ADD CONSTRAINT "insights_breakdowns_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insights_breakdowns" ADD CONSTRAINT "insights_breakdowns_ad_account_id_ad_accounts_id_fk" FOREIGN KEY ("ad_account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "insights_breakdowns_account_idx" ON "insights_breakdowns" USING btree ("ad_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "insights_breakdowns_unique_idx" ON "insights_breakdowns" USING btree ("ad_account_id","entity_id","dimension");
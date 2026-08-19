CREATE TABLE "conversion_labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"ad_account_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"goal" text NOT NULL,
	"custom_conversion_id" text DEFAULT '' NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "business_context" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "guidance" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "config_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversion_labels" ADD CONSTRAINT "conversion_labels_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversion_labels" ADD CONSTRAINT "conversion_labels_ad_account_id_ad_accounts_id_fk" FOREIGN KEY ("ad_account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversion_labels_account_idx" ON "conversion_labels" USING btree ("ad_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversion_labels_unique_idx" ON "conversion_labels" USING btree ("ad_account_id","goal","custom_conversion_id");
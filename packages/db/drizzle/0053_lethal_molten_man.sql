CREATE TABLE "entity_config_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"ad_account_id" uuid NOT NULL,
	"entity_level" "entity_level" NOT NULL,
	"entity_id" text NOT NULL,
	"date" date NOT NULL,
	"config_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "entity_config_snapshots" ADD CONSTRAINT "entity_config_snapshots_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_config_snapshots" ADD CONSTRAINT "entity_config_snapshots_ad_account_id_ad_accounts_id_fk" FOREIGN KEY ("ad_account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "entity_config_snapshots_account_idx" ON "entity_config_snapshots" USING btree ("ad_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "entity_config_snapshots_unique_idx" ON "entity_config_snapshots" USING btree ("ad_account_id","entity_id","date");
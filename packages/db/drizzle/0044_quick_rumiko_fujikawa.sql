CREATE TABLE "custom_audiences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"ad_account_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"subtype" text,
	"approximate_count" double precision,
	"is_lookalike" boolean DEFAULT false NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "custom_audiences" ADD CONSTRAINT "custom_audiences_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_audiences" ADD CONSTRAINT "custom_audiences_ad_account_id_ad_accounts_id_fk" FOREIGN KEY ("ad_account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "custom_audiences_account_idx" ON "custom_audiences" USING btree ("ad_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "custom_audiences_unique_idx" ON "custom_audiences" USING btree ("ad_account_id","external_id");
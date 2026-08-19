CREATE TYPE "public"."account_lifecycle" AS ENUM('active', 'unavailable', 'removed');--> statement-breakpoint
CREATE TYPE "public"."platform_type" AS ENUM('meta');--> statement-breakpoint
CREATE TABLE "platform_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"platform" "platform_type" DEFAULT 'meta' NOT NULL,
	"external_business_id" text,
	"label" text,
	"token_cripto" jsonb NOT NULL,
	"token_status" "token_status" DEFAULT 'unchecked' NOT NULL,
	"last_validated_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD COLUMN "connection_id" uuid;--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD COLUMN "status" "account_lifecycle" DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_connections" ADD CONSTRAINT "platform_connections_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "platform_connections_org_idx" ON "platform_connections" USING btree ("org_id");--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD CONSTRAINT "ad_accounts_connection_id_platform_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."platform_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ad_accounts_connection_idx" ON "ad_accounts" USING btree ("connection_id");
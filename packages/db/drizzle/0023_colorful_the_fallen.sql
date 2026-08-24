CREATE TYPE "public"."channel_group_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TABLE "channel_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"evolution_instance" text NOT NULL,
	"group_jid" text NOT NULL,
	"name" text,
	"status" "channel_group_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_groups_org_uq" UNIQUE("org_id")
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "group_id" uuid;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "participant_phone" text;--> statement-breakpoint
ALTER TABLE "channel_groups" ADD CONSTRAINT "channel_groups_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_group_id_channel_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."channel_groups"("id") ON DELETE set null ON UPDATE no action;
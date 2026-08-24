CREATE TABLE "group_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"author_phone" text,
	"author_name" text,
	"body" text,
	"message_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_messages_group_message_uq" UNIQUE("group_id","message_id")
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "focused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "group_messages" ADD CONSTRAINT "group_messages_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_messages" ADD CONSTRAINT "group_messages_group_id_channel_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."channel_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "group_messages_group_created_idx" ON "group_messages" USING btree ("org_id","group_id","created_at");
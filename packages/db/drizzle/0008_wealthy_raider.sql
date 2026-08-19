CREATE TABLE "agent_muted_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"entity_level" "entity_level" NOT NULL,
	"external_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_muted_entities" ADD CONSTRAINT "agent_muted_entities_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_muted_entities" ADD CONSTRAINT "agent_muted_entities_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_muted_entities_agent_idx" ON "agent_muted_entities" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_muted_entities_uq" ON "agent_muted_entities" USING btree ("agent_id","entity_level","external_id");
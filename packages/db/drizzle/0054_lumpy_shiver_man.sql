CREATE TABLE "learning_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"dimension" "lesson_dimension" NOT NULL,
	"direction" "memory_direction" NOT NULL,
	"entity_id" text NOT NULL,
	"supports" boolean NOT NULL,
	"outcome" "outcome_status" NOT NULL,
	"source" "memory_origin" NOT NULL,
	"dedupe_ref" text NOT NULL,
	"measured_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "learning_evidence" ADD CONSTRAINT "learning_evidence_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_evidence" ADD CONSTRAINT "learning_evidence_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "learning_evidence_agent_idx" ON "learning_evidence" USING btree ("agent_id","dimension","direction");--> statement-breakpoint
CREATE UNIQUE INDEX "learning_evidence_dedupe_uq" ON "learning_evidence" USING btree ("agent_id","dedupe_ref");
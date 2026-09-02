CREATE TYPE "public"."creative_asset_origin" AS ENUM('reuse', 'upload');--> statement-breakpoint
CREATE TYPE "public"."creative_asset_status" AS ENUM('pending', 'ready', 'error');--> statement-breakpoint
CREATE TYPE "public"."creative_format" AS ENUM('image', 'video');--> statement-breakpoint
CREATE TYPE "public"."draft_kind" AS ENUM('from_scratch', 'duplicate');--> statement-breakpoint
CREATE TYPE "public"."draft_origin" AS ENUM('on_demand', 'proactive');--> statement-breakpoint
CREATE TYPE "public"."draft_status" AS ENUM('proposed', 'approved', 'creating', 'created', 'failed', 'reverted');--> statement-breakpoint
CREATE TABLE "campaign_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"ad_account_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"run_id" uuid,
	"kind" "draft_kind" NOT NULL,
	"status" "draft_status" DEFAULT 'proposed' NOT NULL,
	"origin" "draft_origin" NOT NULL,
	"spec" jsonb NOT NULL,
	"source_ref" jsonb,
	"created_ids" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "creative_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"ad_account_id" uuid NOT NULL,
	"origin" "creative_asset_origin" NOT NULL,
	"format" "creative_format" NOT NULL,
	"status" "creative_asset_status" DEFAULT 'ready' NOT NULL,
	"storage_ref" text,
	"meta_image_hash" text,
	"meta_video_id" text,
	"source_ad_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "guardrail_configs" ADD COLUMN "max_new_daily_budget_minor" integer DEFAULT 5000 NOT NULL;--> statement-breakpoint
ALTER TABLE "guardrail_configs" ADD COLUMN "max_new_campaigns_per_day" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "guardrail_configs" ADD COLUMN "scale_pct" integer DEFAULT 50 NOT NULL;--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN "draft_id" uuid;--> statement-breakpoint
ALTER TABLE "campaign_drafts" ADD CONSTRAINT "campaign_drafts_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_drafts" ADD CONSTRAINT "campaign_drafts_ad_account_id_ad_accounts_id_fk" FOREIGN KEY ("ad_account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_drafts" ADD CONSTRAINT "campaign_drafts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_drafts" ADD CONSTRAINT "campaign_drafts_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_assets" ADD CONSTRAINT "creative_assets_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_assets" ADD CONSTRAINT "creative_assets_ad_account_id_ad_accounts_id_fk" FOREIGN KEY ("ad_account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "campaign_drafts_account_idx" ON "campaign_drafts" USING btree ("ad_account_id");--> statement-breakpoint
CREATE INDEX "campaign_drafts_agent_idx" ON "campaign_drafts" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_drafts_proactive_pending_uq" ON "campaign_drafts" USING btree ("ad_account_id") WHERE status = 'proposed' and origin = 'proactive';--> statement-breakpoint
CREATE INDEX "creative_assets_account_idx" ON "creative_assets" USING btree ("ad_account_id");--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_draft_id_campaign_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."campaign_drafts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recommendations_draft_idx" ON "recommendations" USING btree ("draft_id");
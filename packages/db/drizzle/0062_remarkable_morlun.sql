ALTER TABLE "creative_assets" ADD COLUMN "conversation_id" uuid;--> statement-breakpoint
ALTER TABLE "creative_assets" ADD COLUMN "source_message_id" text;--> statement-breakpoint
ALTER TABLE "creative_assets" ADD COLUMN "vision_content_hash" text;
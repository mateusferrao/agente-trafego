CREATE TYPE "public"."tool_approval_policy" AS ENUM('auto', 'approvals_table', 'chat_confirm');--> statement-breakpoint
ALTER TABLE "agent_tool_definitions" ADD COLUMN "executable_in_chat" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_tool_definitions" ADD COLUMN "proposable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_tool_definitions" ADD COLUMN "approval_policy" "tool_approval_policy" DEFAULT 'approvals_table' NOT NULL;
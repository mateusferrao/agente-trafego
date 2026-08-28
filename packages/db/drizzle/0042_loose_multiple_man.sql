CREATE TYPE "public"."approval_kind" AS ENUM('action', 'draft', 'activation');--> statement-breakpoint
ALTER TABLE "approvals" DROP CONSTRAINT "approvals_action_xor_draft";--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "kind" "approval_kind" DEFAULT 'action' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_pending_draft_uq" ON "approvals" USING btree ("draft_id","kind") WHERE status = 'pending' and draft_id is not null;--> statement-breakpoint
-- backfill (P0.1): linhas legadas de RASCUNHO (draft_id set) tinham `kind` implícito por
-- nulidade — o default de coluna cobriu as de AÇÃO como 'action'. Idempotente.
UPDATE "approvals" SET "kind" = 'draft' WHERE "draft_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_action_xor_draft" CHECK (("approvals"."kind" = 'action' and "approvals"."action" is not null and "approvals"."draft_id" is null)
          or ("approvals"."kind" in ('draft', 'activation') and "approvals"."action" is null and "approvals"."draft_id" is not null));
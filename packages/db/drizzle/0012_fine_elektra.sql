DROP INDEX "guardrail_configs_agent_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "guardrail_configs_agent_uq" ON "guardrail_configs" USING btree ("agent_id");
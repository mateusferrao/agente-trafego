import { and, eq } from "drizzle-orm";
import { adAccounts, BETA_ORG_SLUG, orgs, type Database } from "@trafego/db";
import type { CredentialVaultPort, SchedulerPort } from "@trafego/shared/ports";
import { ANALYSIS_QUEUE, ANALYSIS_RUN_JOB, type AnalysisRunPayload } from "@trafego/shared";
import { badRequest, notFound } from "../../middleware/error-handler.js";
import type { ConnectAccountInput } from "./schema.js";

export interface AdminDeps {
  readonly db: Database;
  readonly vault: CredentialVaultPort;
  readonly scheduler: SchedulerPort;
}

/**
 * Slice admin da Fatia 0 (scaffolding, guardado por header). Cola token (cripto)
 * e dispara a análise via fila. Sem UI/auth — substituído por onboarding real (1a/1b).
 */
export function createAdminService(deps: AdminDeps) {
  /** Resolve a org beta por slug (semeada). Fatia 0: org única. */
  async function betaOrgId(): Promise<string> {
    const [org] = await deps.db
      .select({ id: orgs.id })
      .from(orgs)
      .where(eq(orgs.slug, BETA_ORG_SLUG))
      .limit(1);
    if (!org) throw badRequest("Org beta não encontrada — rode o seed (pnpm db:seed).");
    return org.id;
  }

  return {
    /** Cifra o token e persiste a ad account sob a org beta. */
    async connectAccount(input: ConnectAccountInput): Promise<{ id: string }> {
      const orgId = await betaOrgId();
      const tokenCripto = deps.vault.encrypt(input.token);
      const [row] = await deps.db
        .insert(adAccounts)
        .values({
          orgId,
          metaBusinessId: input.metaBusinessId,
          adAccountId: input.adAccountId,
          tokenCripto,
        })
        .returning({ id: adAccounts.id });
      if (!row) throw badRequest("Falha ao persistir a conta.");
      return { id: row.id };
    },

    /** Enfileira o job de análise para a conta (org-scoped). */
    async triggerRun(accountId: string): Promise<void> {
      const orgId = await betaOrgId();
      const [account] = await deps.db
        .select({ id: adAccounts.id })
        .from(adAccounts)
        .where(and(eq(adAccounts.id, accountId), eq(adAccounts.orgId, orgId)))
        .limit(1);
      if (!account) throw notFound("Conta não encontrada.");

      const payload: AnalysisRunPayload = { accountId, orgId, trigger: "manual" };
      await deps.scheduler.enqueue({ queue: ANALYSIS_QUEUE, name: ANALYSIS_RUN_JOB, payload });
    },
  };
}

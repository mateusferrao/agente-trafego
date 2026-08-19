import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "../../middleware/auth.js";
import { requireOrgScope, orgIdOf } from "../../middleware/org-scope.js";
import { agentConfigInput, muteCampaignInput, setPausedInput } from "./schema.js";

/**
 * Slice de agentes (3a): agente por conta (zero-config) + edição da meta.
 * Account-centric: o web conhece a conta, não o agentId.
 */
export const agentsRoutes: FastifyPluginAsync = async (app) => {
  const service = app.container.services.agents;
  const guard = { preHandler: [requireAuth, requireOrgScope] };

  app.get("/accounts/:id/agent", guard, async (request) => {
    const { id } = request.params as { id: string };
    return service.getOrCreateForAccount(orgIdOf(request), id);
  });

  // Config do agente (Fatia 4 corte 1): meta+conversão de negócio + personalização por texto.
  app.put("/accounts/:id/agent/config", guard, async (request) => {
    const { id } = request.params as { id: string };
    const input = agentConfigInput.parse(request.body);
    return service.updateConfig(orgIdOf(request), id, input);
  });

  // Conversões que a conta reportou (base do select anotado da config). DB-only.
  app.get("/accounts/:id/available-conversions", guard, async (request) => {
    const { id } = request.params as { id: string };
    return service.availableConversions(orgIdOf(request), id);
  });

  app.put("/accounts/:id/agent/paused", guard, async (request) => {
    const { id } = request.params as { id: string };
    const { paused } = setPausedInput.parse(request.body);
    return service.setPaused(orgIdOf(request), id, paused);
  });

  // Silenciar campanha (opt-out da análise). Account-centric; devolve a lista atual.
  app.get("/accounts/:id/muted-campaigns", guard, async (request) => {
    const { id } = request.params as { id: string };
    const campaignIds = await service.listMutedCampaigns(orgIdOf(request), id);
    return { campaignIds };
  });

  app.post("/accounts/:id/muted-campaigns", guard, async (request) => {
    const { id } = request.params as { id: string };
    const { externalId } = muteCampaignInput.parse(request.body);
    const campaignIds = await service.muteCampaign(orgIdOf(request), id, externalId);
    return { campaignIds };
  });

  app.delete("/accounts/:id/muted-campaigns/:externalId", guard, async (request) => {
    const { id, externalId } = request.params as { id: string; externalId: string };
    const campaignIds = await service.unmuteCampaign(orgIdOf(request), id, externalId);
    return { campaignIds };
  });
};

import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "../../middleware/auth.js";
import { requireActiveAccess } from "../../middleware/access-gate.js";
import { requireOrgScope, orgIdOf } from "../../middleware/org-scope.js";

/** Slice de canal: conectar instância (QR) + status. Opt-in de contato = slice contacts. */
export const channelsRoutes: FastifyPluginAsync = async (app) => {
  const service = app.container.services.channels;
  const guard = { preHandler: [requireAuth, requireOrgScope, requireActiveAccess] };

  app.post("/channels/connect", guard, async (request) => {
    return service.connect(orgIdOf(request));
  });

  app.get("/channels/status", guard, async (request) => {
    // `?live=true` força o probe ao vivo na Evolution (fluxo de QR); o padrão lê o
    // estado persistido — instantâneo para o render da tela de integrações.
    const live = (request.query as { live?: string }).live === "true";
    return service.status(orgIdOf(request), { live });
  });

  // Desconecta (logout) o número da org — mantém a instância p/ re-parear.
  app.post("/channels/disconnect", guard, async (request) => {
    return service.disconnect(orgIdOf(request));
  });
};

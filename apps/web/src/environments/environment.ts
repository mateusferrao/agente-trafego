// Ambiente único do app web. Em produção a API é servida na MESMA origem
// (o Fastify serve o `dist/web/browser` estático — CLAUDE.md §14), então a base
// da API é sempre o prefixo relativo `/api`. Em dev, o proxy do dev-server
// (proxy.conf.json) encaminha `/api` para o backend (localhost:3333).
//
// Manter relativo é intencional: nada de host/porta hardcoded — o front nunca
// precisa saber onde a API roda, só o prefixo do contrato.
export const environment = {
  production: false,
  /** Prefixo base de todos os endpoints do contrato (ver core/api/base-api.service.ts). */
  apiBaseUrl: '/api',
} as const;

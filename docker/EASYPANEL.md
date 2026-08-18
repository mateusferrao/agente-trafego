# Deploy — Hostinger + EasyPanel

Monorepo sobe como serviços separados no EasyPanel. Postgres + Redis como serviços gerenciados do painel. Evolution = instância existente (consumida via HTTP + webhook).

## Serviços

| Serviço | Build | Porta | Notas |
|---|---|---|---|
| `web` | Angular build → estático + nginx/Caddy | 80/443 | `pnpm --filter web build` → serve `dist/` |
| `api` | Node | `API_PORT` (3333) | REST + webhook Evolution + auth |
| `worker` | Node | — | mesmo repo, entrypoint `apps/worker/src/main.ts` |
| `postgres` | template EasyPanel | 5432 | volume persistente + backup agendado |
| `redis` | template EasyPanel | 6379 | BullMQ |

## Passos

1. Criar projeto no EasyPanel apontando pro repo Git.
2. Provisionar **Postgres** e **Redis** (templates). Copiar as connection strings pras envs.
3. Criar serviço **api** (build: `pnpm install && pnpm --filter @trafego/api build`; start: `node apps/api/dist/http/server.js`). Setar envs (`.env.example`).
4. Criar serviço **worker** (mesmo build; start: `node apps/worker/dist/main.js`). Mesmas envs.
5. Criar serviço **web** (build Angular; servir estático). Env `WEB_ORIGIN`/API URL.
6. Domínios + SSL pelo painel. Webhook Evolution → `https://<api>/webhooks/evolution`.
7. Rodar migrations: `pnpm db:migrate` (job único ou no boot do api — decidir).

## SPOF / backup

Box único = ponto único de falha. Mitigar: backup agendado do Postgres + snapshots do EasyPanel. Escala futura: DB gerenciado + worker multi-nó + pool de números WhatsApp.

## Segredos

`CREDENTIAL_MASTER_KEY`, `SESSION_SECRET`, `OPENROUTER_API_KEY`, `META_APP_SECRET`, `EVOLUTION_API_KEY`, `EVOLUTION_WEBHOOK_SECRET` — **secrets do painel**, nunca no repo.

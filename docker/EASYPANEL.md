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

## Passos (Fatia 0 = api + worker + postgres + redis; **sem `web`** — web entra na 1a)

1. Criar projeto no EasyPanel apontando pro repo Git.
2. Provisionar **Postgres** e **Redis** (templates). Copiar as connection strings pras envs.
3. **Build compartilhado:** `pnpm install` (instalação **completa** — o `start` roda via `tsx`, que é devDependency; não usar `--prod`. `esbuild` compila via `pnpm.onlyBuiltDependencies` no `package.json` raiz).
4. Criar serviço **api** — start: `pnpm --filter @trafego/api start` (`tsx src/http/server.ts`), porta `API_PORT`. Setar todas as envs (`.env.example`).
5. Criar serviço **worker** — start: `pnpm --filter @trafego/worker start` (`tsx src/main.ts`). Mesmas envs.
6. **Migrations + seed** (job único, uma vez): `pnpm db:migrate && pnpm db:seed` (cria as 27 tabelas + a org beta). Rodar antes de subir api/worker.
7. Domínios + SSL pelo painel. (Webhook Evolution `https://<api>/webhooks/evolution` = fatia 5b; inbound não é usado na Fatia 0.)
8. **Fumaça:** os 2 curls admin (ver `docs/FATIA-0.md`) contra a URL pública → mensagem chega no WhatsApp de teste. Deploy verde = done.

> `web` (Angular), auth de sessão e build-para-`node dist` = fatias seguintes. Na Fatia 0 roda direto em `tsx`.

## SPOF / backup

Box único = ponto único de falha. Mitigar: backup agendado do Postgres + snapshots do EasyPanel. Escala futura: DB gerenciado + worker multi-nó + pool de números WhatsApp.

## Segredos

`CREDENTIAL_MASTER_KEY` (32 bytes base64), `SESSION_SECRET`, `OPENROUTER_API_KEY`, `META_APP_SECRET`, `EVOLUTION_API_KEY`, `EVOLUTION_WEBHOOK_SECRET`, `BETA_ADMIN_SECRET` (guard dos endpoints admin) — **secrets do painel**, nunca no repo. Fatia 0 também precisa de `EVOLUTION_INSTANCE` e `FATIA0_RECIPIENT_PHONE` (config, não secret).

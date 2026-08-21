# Deploy — Hostinger + EasyPanel

Monorepo sobe no EasyPanel. Postgres + Redis como serviços gerenciados do painel. Evolution = instância existente (consumida via HTTP + webhook).

**Topologia MVP (CLAUDE.md §14):** **api** e **worker** = serviços **separados** (worker não no processo da api — análise pesada trava o event loop + acopla crash). **web servido pela própria api** (`@fastify/static` + fallback SPA a partir da 1a): mesma origem, zero CORS, 1 serviço a menos. Serviço estático dedicado (nginx/Caddy) = fast-follow.

## Serviços

| Serviço | Build | Porta | Notas |
|---|---|---|---|
| `api` (+ web estático) | Node (tsx) | `API_PORT` (3333) | REST + webhook Evolution + auth; serve o `dist/` do Angular (a partir da 1a) |
| `worker` | Node (tsx) | — | mesmo repo, entrypoint `apps/worker/src/main.ts` |
| `postgres` | template EasyPanel | 5432 | volume persistente + backup agendado |
| `redis` | template EasyPanel | 6379 | BullMQ |

> `web` **não** é serviço próprio no MVP — o build Angular (`pnpm --filter web build`) é servido pela api. Vira serviço estático dedicado só quando o tráfego justificar.

## Passo a passo (Fatia 0 = api + worker + postgres + redis)

Pré: repo no GitHub (`mateusferrao/agente-trafego`, branch `main`) + instância Evolution rodando. Ordem: **Postgres → Redis → api → worker → migrate/seed → fumaça**. Runtime roda via `tsx` (sem build-para-`dist`); nada em produção depende de devDeps.

### 1. Projeto
**New Project** → nome (ex: `trafego`). Todos os serviços entram nele e falam pela rede privada interna do projeto.

### 2. Postgres
**New Service → Postgres** → nome `postgres`. Deixar defaults (database = nome do projeto, user `postgres`, senha auto-gerada). Create e aguardar subir. Abrir a aba **Credentials** → copiar o **Internal Connection URL** (formato `postgres://postgres:<senha>@<host-interno>:5432/<db>?sslmode=disable`). Esse valor vira `DATABASE_URL`.

### 3. Redis
**New Service → Redis** → nome `redis`. Senha auto. Create. Aba **Credentials** → copiar o Internal URL (`redis://default:<senha>@<host-interno>:6379`). Vira `REDIS_URL`.

### 4. Serviço `api` (+ web estático a partir da 1a)
**New Service → App** → nome `api`.
- **Source:** GitHub → repo `mateusferrao/agente-trafego`, Branch `main`, **Build Path** `/`. Habilitar **Auto Deploy** (deploy a cada push).
- **Build:** builder **Nixpacks** —
  - **Install Command:** `pnpm install --frozen-lockfile`
  - **Build Command:** `pnpm --filter web build` — **builda o Angular** (a api serve o `apps/web/dist/web/browser` via `@fastify/static`). O backend em si roda via `tsx` (sem build), mas o front precisa do build no build phase (onde as devDeps do Angular existem).
  - **Start Command:** `pnpm --filter @trafego/api start` — no boot: `AUTO_MIGRATE` aplica migrations, depois serve `/api` + o SPA (fallback pra `index.html`).
  - Node ≥22 vem do `engines`; pnpm do `packageManager` (corepack); `esbuild` compila via `pnpm.onlyBuiltDependencies`.
- **Environment** (aba Environment, sintaxe `.env`) — `DATABASE_URL`/`REDIS_URL` = os Internal URLs dos passos 2/3; o resto = valores reais:
```
NODE_ENV=production
LOG_LEVEL=info
API_PORT=3333
WEB_ORIGIN=https://<seu-dominio>
DATABASE_URL=<internal url do postgres>
REDIS_URL=<internal url do redis>
CREDENTIAL_MASTER_KEY=<32 bytes em base64>
CREDENTIAL_KEY_VERSION=1
OPENROUTER_API_KEY=<...>
OPENROUTER_MODEL=google/gemini-2.5-flash
OPENROUTER_VISION_MODEL=google/gemini-2.5-flash
LLM_COST_CAP_USD_PER_PERIOD=0
META_APP_ID=<...>
META_APP_SECRET=<...>
EVOLUTION_BASE_URL=<url da sua Evolution>
EVOLUTION_API_KEY=<...>
EVOLUTION_WEBHOOK_SECRET=<...>
EVOLUTION_INSTANCE=<nome da instância>
INSIGHTS_RETENTION_DAYS=90
ANALYSIS_MAX_CREATIVES_VISION=8
```
> Bloco completo/atualizado de envs = [`../.env.example`](../.env.example) (fonte da verdade, validada no boot pelo schema zod). Colar as chaves reais como **secrets do painel**.
(Gerar a chave: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.)
- **Domains:** Add Domain → host (seu domínio/subdomínio), path `/`, **Target Port `3333`** (= `API_PORT`), marcar como primary. SSL automático pelo painel.
- **Deploy**.

### 5. Serviço `worker`
**New Service → App** → nome `worker`. Igual à api, com 2 diferenças:
- **Start Command:** `pnpm --filter @trafego/worker start`
- **Sem Domain** (worker não escuta HTTP).
- **Environment:** as **mesmas** envs da api (colar o mesmo bloco; `API_PORT`/`WEB_ORIGIN` são inócuas aqui). Deploy.

### 6. Migrations (automáticas) + seed (uma vez)
**Migrations rodam sozinhas** no boot da api (`AUTO_MIGRATE=true`): a cada deploy, antes de escutar, a api aplica o SQL pendente de `packages/db/drizzle/` (migrator do `drizzle-orm`, idempotente). Não precisa de passo manual. Só a **api** migra; o worker assume o schema pronto. (Pra migrar fora do boot — CI/release — setar `AUTO_MIGRATE=false` e rodar `pnpm db:deploy` no Shell.)

**Seed** (org beta — scaffolding da Fatia 0, roda **uma vez só**, não por deploy): no Shell da api → `pnpm db:seed`. Idempotente. Some quando a 1a trouxer signup real.

### 7. Fumaça (prova do fio)
`GET https://<api>/health` responde `{status:"ok"}` (liveness) e `GET https://<api>/ready` responde
`200 {status:"ready",db:true,redis:true}` quando DB+Redis estão de pé. O app (Angular servido pela api)
abre em `https://<api>/` → signup real → onboarding (colar token Meta em Integrações).

> Os endpoints `/admin/*` da Fatia 0 (guardados por `x-admin-secret`) foram removidos — o fluxo real é
> signup + onboarding no web. Webhook Evolution (`https://<api>/webhooks/evolution/<instance>`) é
> registrado no connect (5b).

## SPOF / backup

Box único = ponto único de falha. Mitigar: backup agendado do Postgres + snapshots do EasyPanel. Escala futura: DB gerenciado + worker multi-nó + pool de números WhatsApp.

## Backup / restore do Postgres (runbook — 6b)

O dump carrega os tokens Meta (criptografados pela envelope AES) — **destino privado**, e **offsite**
(um backup no mesmo box não sobrevive à perda do box). Decisão 6b: **backup pelo painel EasyPanel**
(agendado + alvo offsite), não por script no repo.

**Agendar (painel):** serviço `postgres` → Backups → agendar (diário) → destino **S3/offsite** →
reter N dias. Confirmar que o painel suporta alvo offsite antes do go-live; se não, usar um cron
externo de `pg_dump` (fast-follow `StoragePort`).

**Restore de teste (validar antes do go-live):** baixar o último dump → subir num Postgres limpo →
`pg_restore`/`psql` → apontar uma instância de staging pra ele → conferir que o app sobe e as contas
aparecem. **Backup que nunca foi restaurado não conta.**

## Go-live (beta) — checklist pré-abrir

1. **Backup** do Postgres agendado (offsite) + **1 restore de teste** validado (acima).
2. **Migrations** aplicadas (auto no boot da api) + **backfill one-time**:
   `pnpm backfill:access -- --before=<ISO do deploy>` (ex: `--before=2026-08-21T00:00:00Z`) —
   grandfather de users/grants **anteriores ao cutoff** (senão o gate tranca o dono). O cutoff
   torna a re-execução inócua (não libera signups do beta em análise).
3. **Email**: `AUTH_EMAIL_DELIVERY_DRIVER=ses` + `AWS_*` (IAM `trafego-ses-mailer`, sa-east-1) no worker;
   smoke de envio ok (código chega de `no-reply@msg.automato.pro`).
4. **Liberar allowlist**: `pnpm access:grant <email>` para cada beta user aprovado.
5. Secrets do painel conferidos (abaixo); `/health` e `/ready` verdes.

## Segredos

`CREDENTIAL_MASTER_KEY` (32 bytes base64), `OPENROUTER_API_KEY`, `META_APP_SECRET`, `EVOLUTION_API_KEY`, `EVOLUTION_WEBHOOK_SECRET` — **secrets do painel**, nunca no repo. (6b) email transacional via SES adiciona `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` (IAM escopado a `ses:SendEmail`) — **só no serviço worker**.

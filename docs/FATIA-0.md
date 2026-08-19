# Fatia 0 — Espinha Ambulante (walking skeleton)

> **⚠️ Histórico — superado.** O slice `admin` (endpoints `/admin/*` guardados por `x-admin-secret`/`BETA_ADMIN_SECRET`) e a env `FATIA0_RECIPIENT_PHONE` foram **removidos**. O onboarding real agora é via **Integrações** (conectar sistema externo → escolher contas — slice `connections`) + WhatsApp por QR. Este doc fica como registro do primeiro fio ponta-a-ponta; os comandos `curl /admin/...` abaixo não existem mais.

Primeiro fio fino real ponta-a-ponta: **colar token (cripto) → buscar `spend` na Meta → enviar 1 mensagem no WhatsApp**. Prova integração (Meta + Evolution + Postgres + fila api→worker) + deploy. Sem LLM, sem escrita na Meta — mensagem templated. Decisões = [`../CLAUDE.md`](../CLAUDE.md) · construção = [`ROADMAP.md`](ROADMAP.md).

## O que a Fatia 0 entrega

- `CredentialVault` AES-256-GCM (`@trafego/credential-vault`) — token nunca em texto plano.
- Meta insights **síncrono** (`spend`, `date_preset=last_7d`) — sem governor/async (isso é 2a).
- Evolution `sendText` (`@trafego/channel-evolution`) — contrato v2 (ver `ROADMAP.md` Apêndice A).
- Slice **admin** (2 endpoints HTTP, guard por header) + fila BullMQ + worker mínimo.
- Migration do schema completo (27 tabelas) + seed da org beta.

## Rodar local

Pré: Docker + Node ≥22 + `pnpm`. Do diretório do repo (`C:\dev\agente-trafego`):

```bash
pnpm install
docker compose -f docker/docker-compose.yml up -d      # postgres + redis
cp .env.example .env                                    # preencher (ver abaixo)
pnpm db:generate && pnpm db:migrate && pnpm db:seed     # tabelas + org beta
pnpm dev                                                # api (:3333) + worker (+ web)
```

**`.env` — mínimo p/ a Fatia 0.** Gere a chave mestra (32 bytes base64):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Preencha ao menos: `CREDENTIAL_MASTER_KEY`, `SESSION_SECRET` (32+ chars), `BETA_ADMIN_SECRET`, `META_APP_ID`, `META_APP_SECRET`, `EVOLUTION_BASE_URL`, `EVOLUTION_API_KEY`, `EVOLUTION_INSTANCE`, `FATIA0_RECIPIENT_PHONE` (só dígitos com DDI, ex: `5511999999999`). `DATABASE_URL`/`REDIS_URL` já apontam pro compose local. (A versão do Graph é const no adapter, não env.)

## Os 2 curls (admin)

Guard por header `x-admin-secret` (= `BETA_ADMIN_SECRET`).

```bash
# 1) conecta a conta (salva token cripto) → 201 { id }
curl -X POST http://localhost:3333/admin/accounts \
  -H "x-admin-secret: SEU_BETA_ADMIN_SECRET" \
  -H "content-type: application/json" \
  -d '{"metaBusinessId":"<bm_id>","adAccountId":"<ad_account_id_sem_act_>","token":"<system_user_token>"}'

# 2) dispara a análise (enfileira o job) → 202
curl -X POST http://localhost:3333/admin/accounts/<id>/run \
  -H "x-admin-secret: SEU_BETA_ADMIN_SECRET"
```

Com **token System User válido**: o worker busca o `spend` e envia no WhatsApp de teste
(`Conta <nome>: gastou <moeda> <spend> nos últimos 7 dias.`). Com token inválido: o job
falha com `Invalid OAuth access token` (esperado — prova a chamada real à Meta).

## Status da verificação

Fiação validada e2e localmente com infra real (Postgres, Redis, BullMQ, Graph API ao vivo):
guard 401 · connect 201 (vault+DB reais) · run 202 (fila) · worker consome → decripta →
`getInsights` → chamada real à Meta. **O envio final no WhatsApp exige token System User
válido** (só então `getInsights` passa e o Evolution é chamado) — é o passo com credenciais reais.

## Dívida (fatias seguintes)

governor/rate-limit + async report jobs (2a) · `token_status`/code-190 (6b) · UI + auth real +
discovery de contas (1a/1b) · LLM + grafo real (3a) · guardrails/escrita (5a). O handler mínimo
é **descartável** ao chegar 3a (o grafo `account-analysis` assume).

## Deploy

EasyPanel: api + worker + postgres + redis (sem `web` na Fatia 0). Passos = [`../docker/EASYPANEL.md`](../docker/EASYPANEL.md).

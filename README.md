# Agente de Tráfego

SaaS de **agentes de IA que tocam tráfego pago** (MVP: Meta Ads), atuando **via WhatsApp**. Agentes personalizáveis analisam a conta, geram recomendações e — conforme config — aplicam mudanças com guardrails.

> **Fontes da verdade:** decisões [`CLAUDE.md`](./CLAUDE.md) · design/UX [`docs/DESIGN.md`](./docs/DESIGN.md) · construção [`docs/ROADMAP.md`](./docs/ROADMAP.md) · histórico [`docs/plan.md`](./docs/plan.md).

## Stack

- **Web:** Angular 21 (design system Automato vendorizado) — `apps/web`
- **API:** Node + Fastify (REST + webhook Evolution + auth sessão) — `apps/api`
- **Worker:** Node + BullMQ + LangGraph (motor do agente) — `apps/worker`
- **DB:** Postgres + Drizzle — `packages/db`
- **Core puro:** playbook, guardrails, decisão, brief — `packages/core`
- **Contratos:** portas + tipos + zod — `packages/shared`
- **Adapters:** `packages/{ads-meta, channel-evolution, llm-openrouter}`
- **LLM:** OpenRouter · **Canal:** Evolution · **Hosting:** Hostinger + EasyPanel

## Arquitetura

**VSA + portas nas bordas + functional core.** O core só conhece interfaces (`AdsPlatformPort`, `MessagingChannelPort`, `LLMProviderPort`, ...). Trocar plataforma/canal/provider = novo adapter. `api` e `worker` = mesmo código, processos separados.

## Dev local

> **Local canônico:** `C:\dev\agente-trafego` (fora do OneDrive, por causa de `node_modules`/worktrees). Não desenvolver na cópia antiga do OneDrive.

```bash
pnpm install
docker compose -f docker/docker-compose.yml up -d   # postgres + redis
cp .env.example .env                                 # preencher segredos
pnpm db:generate && pnpm db:migrate && pnpm db:seed  # tabelas + org beta
pnpm dev                                             # api + worker + web
```

> Rodar/testar a **Fatia 0** (colar token → WhatsApp) ponta-a-ponta: ver **[`docs/FATIA-0.md`](./docs/FATIA-0.md)**.

## Comandos

Ver [`CLAUDE.md` §16](./CLAUDE.md).

## Status

Esqueleto (stubs). Construção em fatias — ver **[`docs/ROADMAP.md`](./docs/ROADMAP.md)** (13 sub-fatias, paralelização em worktrees, marcos). Histórico completo em [`docs/plan.md`](./docs/plan.md).

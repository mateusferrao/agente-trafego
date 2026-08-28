# Plano de Arquitetura — SaaS de Agentes de IA para Tráfego Pago (MVP Meta Ads)

## Context

Validar rápido um **produto SaaS standalone** onde **agentes de IA personalizáveis tocam tráfego pago de forma (semi)autônoma**: de tempos em tempos analisam a conta Meta Ads (métricas + criativos), geram recomendações e — conforme configuração — aplicam mudanças, atuando **principalmente via WhatsApp**. O produto é novo e independente, mas **reusa os padrões arquiteturais da plataforma Automato existente** (não o código-fonte diretamente). Princípio norteador em toda decisão: **desacoplado, genérico, extensível e configurável** — trocar provider/canal/plataforma depois deve ser adicionar um adapter, sem tocar no core.

**ICP (MVP):** genérico, multi-segmento — quem já anuncia de verdade no Meta (conta ativa — pré-requisito do produto de otimização). Dores: (1) trabalho manual diário de tráfego; (2) **momentos críticos** (lançamento, promo, sazonalidade), intensos quando acontecem e **conta parada** entre campanhas. Valor: reduz trabalho diário + vigia forte nos momentos críticos (never miss timing) + não deixa conta morrer. **Comprador:** ambos — **B2B** agências/gestores que atendem vários anunciantes (org multi-conta) e **B2C** o próprio anunciante/empresa + consultores (org de 1-poucas contas). Quem-não-anuncia = fora do MVP (exigiria criar campanha do zero = outro produto).

MVP começa **só com Meta Ads** e **um canal WhatsApp (Evolution)**. Foco: provar que a IA dá bons conselhos e que o loop de aprovação/ação via WhatsApp funciona, com o mínimo de fricção de compliance (sem OAuth oficial, sem App Review por enquanto).

> ⚠️ Achado de exploração: a "Plataforma AI Driven" da Automato **não é Next.js**. É monorepo `automato-api` (Express 5 + LangGraph.js + BullMQ/Redis + Drizzle/Postgres, hexagonal) + `automato-web` (**Angular 21**, Tailwind 4, ng-primitives). Por isso o frontend deste produto é **Angular** (reusa o design system 1:1), não Next.

---

## Decisões travadas (com o usuário)

| Área | Decisão |
|---|---|
| Forma do produto | Standalone, reusando **padrões** da Automato (não o repo) |
| Escopo de ação Meta | Sugerir **+ aplicar**, configurável (com/sem aprovação). Guardrails 100% configuráveis |
| Integração Meta (MVP) | Cliente cola **System User token** (não expira) — **sem OAuth, sem App Review**. OAuth vira fast-follow |
| Backend | Node worker pragmático (não hexagonal completo dia 1) |
| Orquestração agente | **LangGraph.js** (checkpoints + interrupt/resume p/ HITL) |
| LLM | **OpenRouter** (1 gateway, multimodal, captura custo/token nativa) |
| Canal | **Evolution** (não-oficial), **1 instância por org** |
| Destinatário WhatsApp | O **gestor** (usuário), configurável por conta |
| Cadência | **Cron configurável por conta + on-demand** ("analisa agora" no WhatsApp) |
| Análise | Híbrida: **playbook de regras determinístico + LLM (métricas) + visão de criativo (multimodal)** |
| Billing MVP | **Allowlist manual de beta** (abstraído). Capturar custo de tokens/providers desde o dia 1 (futuro: mensalidade + custo por uso) |
| Tenant | **Org multi-conta** (agência/gestor → N contas Meta → 1 agente por conta) |
| Frontend | **Angular 21**, reusando design system Automato (**copiar/vendorizar**) |
| Auth | **Padrão Automato**: sessão custom (iron-session + argon2 + RBAC), atrás de porta |
| Hosting | **Hostinger + EasyPanel** (web, api, worker, Postgres, Redis como serviços). Evolution já rodando |
| Backend arch | **VSA + portas nas bordas + functional core** (composition manual). api/worker = mesmo código, processos separados |
| Contrato API | **zod → OpenAPI → kubb** (client Angular) |
| Agente | **2 grafos**: `account-analysis` (pipeline determinístico) + `whatsapp-conversation` (ReAct). HITL durável (checkpoint Postgres) |
| Origem das ações | **Híbrido**: playbook determinístico + LLM (structured). Autonomia **por origem**. Guardrail sobre os dois |
| Curadoria | **AccountBrief** (pipeline puro) = único input do LLM + **Governor** de rate-limit (bucket/batch/async/incremental/jitter) |
| Config | **Superfície única semeada por arquétipo** + avançado progressivo. Playbook em linguagem natural. Presets: Conservador, Otimizador |
| Aprovação | **Conversacional** (sem código) + **eco concreto + confirma antes de escrever**. Expira 24h → avisa (repropor = futuro) |
| Escrita no chat | Sempre confirma + guardrail (ignora nível de autonomia) |
| RBAC | owner/member org-wide no MVP, **extensível a granular** (ACL por conta = fast-follow) |
| Agente×conta | **1:1** no MVP |
| Retenção insights | Janela rolante **~90d, configurável por env** |
| Metering | Genérico (`type`+`payload`) atrás de `MeteringPort`; custo real + dims operacionais. **Cobrança = mensalidade + markup** sobre métricas |
| Erros | Exceções na casca + resultados **tipados no core** |
| Observabilidade | pino + trilha de auditoria + **Langfuse** (trace LLM) |
| Onboarding | **Walkthrough guiado + concierge fallback**; cola token → lista contas → escolhe |
| Grafo B | **ReAct pleno no MVP** (chat aberto + tools) — call do usuário, mais build |
| Validação | **Feedback (👍/👎) + status + outcome tracking** nas recomendações — instrumento da validação |
| Autonomia | **Auto-aplicar liberável no dia 1 por config**. No caminho autônomo NÃO há eco+confirma → **guardrails com defaults conservadores** (blast radius pequeno) são a rede. Eco+confirma vale no fluxo de aprovação e escrita no chat |
| Tools | **Catálogo-DB completo** (padrão Automato): `agent_tool_definitions` (key, riskLevel, isIdempotent, schema, requiredPermission, requiredEntitlement) → `agent_tool_bindings` (allowlist por agente) → executores. Escolha por extensibilidade máxima (editar/adicionar tool sem deploy, tools por tenant, UI admin futura) |
| Cap de custo | **Cap de custo LLM por org/período** (protege margem; guardrail cobre só gasto de anúncio) |
| Zero-config | Arquétipo + conectar = **funciona sem tocar em nada**; config é opcional |

---

## Agente — grafos (LangGraph)

**Dois grafos, não um:**
- **Grafo A `account-analysis` (pipeline determinístico):** cron/on-demand. `load_context → fetch_data → run_playbook → llm_analyze(+visão) → build_recommendations → decide_actions → guardrail_check → [precisa OK? create_approval + interrupt()] → apply_actions(snapshot) → notify → record`. LLM só em `llm_analyze` e `notify`.
- **Grafo B `whatsapp-conversation` (ReAct + tools + guardrails):** trata inbound conversacional pleno — perguntas, pedidos ad-hoc, "analisa agora".
- **HITL durável:** checkpointer LangGraph em Postgres; aprovação pode voltar horas depois; `resume` = novo job. Mutations com **idempotencyKey** (nunca aplica 2x).

**Origem das ações = híbrido com autonomia por origem:** playbook (regras determinísticas puras) gera ações-base + LLM propõe ações adicionais (structured output, mesmo tipo `Action`). Merge → dedupe → guardrail → autonomia **por origem** (ex: auto-aplica playbook, pede OK no LLM — configurável). Guardrail é rede sobre os dois.

## Curadoria (AccountBrief) + Governor de rate-limit — pilar

Camada **determinística pura** entre Meta e LLM. LLM nunca vê o firehose, vê um `AccountBrief` compacto (token-bounded): `account, goals, totals(+delta), trends, segments(top-N+flagados), anomalies(z-score), creatives(só flagados, com imagem p/ visão), playbookCandidates, memory(objetivos/tentado/recusado), aggregatesRest`. Pipeline: `normalize → computeDerived → computeTrends → detectAnomalies → rankAndSelect → summarizeRest → selectCreatives → assembleBrief`. Resolve degradação da análise **e** custo de visão. **CPA/ROAS = conversão do objetivo próprio de cada entidade** (o que ela otimiza na Meta), em vocabulário **genérico** (`ConversionGoal`) — o mapeamento específico da plataforma vive **só no adapter**; override por agente = Fatia 4.

**Governor:** token-bucket por `ad_account` (Redis, lê `X-Business-Use-Case-Usage`), Batch API (≤50/HTTP), async report jobs, snapshot histórico em Postgres (`insights_snapshots`), sync incremental (só ativas/mudadas), jitter/stagger nos crons, degradação graciosa (roda com cache/parcial, nota "análise parcial"). *(MVP 2a = subset **mínimo-correto**: observa uso + backoff full-jitter + cooldown + degradação; token-bucket Lua + Batch API = follow-up quando o volume exigir.)*

## Personalização (config)

**Superfície única semeada por arquétipo** (não wizard paralelo). Escolhe arquétipo → preenche defaults bons → edita inline em linguagem de gente → **"opções avançadas" em divulgação progressiva** (mesma página, mesmo schema). Playbook editável como **linhas de linguagem natural com lacunas** ("pausar ad que custa mais de R$ __ por venda") → `PlaybookRule`. Presets MVP: **Conservador** + **Otimizador de Performance** (refinados depois). Autonomia = slider (só avisa → sugere+OK → age no seguro → age sozinho). **Modo lançamento×manutenção = fast-follow** (MVP: cadência configurável).

---

## Arquitetura (alto nível)

```
┌─────────────┐     REST (OpenAPI→kubb)      ┌──────────────────────────────┐
│  Angular    │ ───────────────────────────▶ │  API (Node/Fastify)          │
│  Web (SPA)  │ ◀─────────────────────────── │  - auth sessão               │
│  design sys │                              │  - CRUD orgs/agentes/config   │
└─────────────┘                              │  - webhook Evolution (inbound)│
                                             │  - enfileira jobs             │
                                             └──────────┬───────────────────┘
                                                        │ BullMQ (Redis)
                                                        ▼
┌───────────────────────────────────────────────────────────────────────────┐
│  Worker (Node)                                                              │
│  - schedulers por conta (cron) → enfileira analysis run                     │
│  - LangGraph "meta-account-analysis" (execute/resume)                       │
│  - executores de tools (read/write Meta via AdsPlatformPort)                │
│  - HITL: approval + interrupt()/resume()                                    │
│  - guardrails engine + snapshot/rollback                                    │
│  - metering (usage/cost)                                                     │
└───────┬───────────────┬────────────────┬──────────────────┬────────────────┘
        ▼               ▼                ▼                  ▼
   Postgres/Drizzle  OpenRouter     Meta Graph API      Evolution API
   (multi-tenant)    (LLM+visão)    (v26, async insights) (1 instância/org)
```

**Fluxo principal (análise → recomendação → ação):**
1. Trigger (cron por conta **ou** "analisa agora" via WhatsApp) → cria `agent_run` → job.
2. Graph carrega contexto (conta, config do agente, guardrails, playbook).
3. Busca dados: insights (**async job** Meta), entidades, criativos (image/thumbnail) — com cache Redis + backoff.
4. `run_playbook` (regras determinísticas) gera ações candidatas.
5. `llm_analyze` (multimodal: métricas + imagens de criativo) gera achados + recomendações.
6. `decide_actions`: separa auto-aplicar × propor, por autonomia + riskLevel + guardrails.
7. Guardrail check (blast radius, budget cap, kill-switch). Se precisa OK: cria `approval` + `interrupt()` → manda WhatsApp com token de resposta.
8. Cliente responde no WhatsApp → router casa contato+approval → `resume()`.
9. `apply_actions`: muta na Meta (snapshot do estado anterior p/ rollback).
10. `notify`: resumo no WhatsApp. Registra run/steps/tool_calls/usage.

---

## Stack

- **Frontend:** Angular 21 standalone + signals, Tailwind 4, ng-primitives, @ng-icons, ngx-sonner. Design system **vendorizado** do Automato (`styles.css`, `DESIGN.md`, `shared/ui`, scripts `validate-design-tokens.mjs`). Cliente da API gerado via **kubb** (OpenAPI).
- **Backend API:** Node ≥22, TypeScript ESM, **Fastify** (ou Express p/ máxima aderência ao padrão) — REST + webhook Evolution.
- **Worker:** Node + **BullMQ/Redis** (jobs + job schedulers), **LangGraph.js** + LangChain via **OpenRouter**. (Langfuse opcional p/ tracing.)
- **DB:** **Postgres puro + Drizzle ORM** (portável via `pg_dump` — sem acoplar recursos proprietários). `drizzle-zod` p/ DTOs.
- **Cripto de credencial:** envelope AES-GCM (padrão Automato) p/ o System User token.
- **Deploy:** Hostinger VPS + **EasyPanel** (serviços: web, api, worker, postgres, redis). Evolution já de pé.

---

## Backend — arquitetura (decisão travada)

**Vertical Slice Architecture (VSA) + portas só nas bordas + functional core.**
- **Organiza por feature/caso-de-uso** (slice coeso: handler + lógica + acesso a dado juntos), não por camada.
- **Portas SÓ nas bordas que variam:** `AdsPlatformPort`, `MessagingChannelPort`, `LLMProviderPort`, `CredentialVaultPort`, `SchedulerPort`, `MeteringPort`. CRUD fala Drizzle direto (banco já é portável via Drizzle).
- **Functional core / imperative shell** na decisão do agente: guardrails, playbook e seleção de ação = **funções puras** (input→output, sem IO), testáveis sem mock; todo IO (Meta/WhatsApp/DB) na casca.
- **Composition root manual** (factory functions), sem DI container.
- Endurecer **localmente** onde doer (extrair porta / ligar `dependency-cruiser`) — não é porta de mão única.
- Cross-cutting (audit + metering em todo write) via **middleware/decorator na casca**, nunca copiado por slice. Duplicação entre slices: regra **3x → extrai shared kernel**.
- **Contrato API:** schemas **zod** como fonte → geram **OpenAPI** → **kubb** gera client Angular tipado (padrão Automato).

## Monorepo (pnpm workspace)

```
apps/
  web/            # Angular 21 (+ design system vendorizado)
  api/            # Node/Fastify: REST + webhook Evolution + auth
  worker/         # Node: BullMQ workers, LangGraph, executores, schedulers
packages/
  shared/         # tipos, zod schemas, PORTAS (interfaces das bordas)
  core/           # functional core: guardrails, playbook, decisão (puro)
  db/             # Drizzle schema + migrations (npm run db:generate)
  ads-meta/       # adapter Meta do AdsPlatformPort
  channel-evolution/ # adapter Evolution do MessagingChannelPort
```
`api` e `worker` = **mesmo código, processos separados** no EasyPanel (api serve HTTP+webhook; worker roda BullMQ+LangGraph). Job pesado não trava HTTP; crash isolado; escala independente.

---

## Extensibilidade — as PORTAS (core desacoplado)

O core do agente **só conhece interfaces**. Cada integração é um adapter plugável (regra: adicionar plataforma/canal/provider = novo adapter, zero mudança no core).

| Porta | Contrato (resumo) | Adapter MVP |
|---|---|---|
| `AdsPlatformPort` | `listEntities`, `getInsights` (async), `getCreatives`, `mutate` (pause/budget/status) | Meta (Graph v26) |
| `MessagingChannelPort` | `sendMessage`, `onInbound` (webhook), `instanceLifecycle` (connect/QR/status) | Evolution |
| `LLMProviderPort` | `complete` (texto + multimodal), retorna `usage`/`cost` | OpenRouter |
| `CredentialVaultPort` | `encrypt`/`decrypt` (AES-GCM), rotação | local |
| `AuthPort` | sessão, RBAC | iron-session (padrão Automato) |
| `ApprovalPort` | `create`/`resolve` (HITL) | Postgres |
| `SchedulerPort` | cron/jobs por tenant | BullMQ |
| `MeteringPort` | registra `usage_events` (tokens, custo) | Postgres |

Padrão de **catálogo de tools** (do Automato): `tool_definitions` (com `requiredPermission`, `riskLevel`, `isIdempotent`) → `tool_bindings` (allowlist por agente) → executores. Genérico: amanhã uma tool de Google Ads entra como definição nova.

---

## Data model (Postgres, tudo `org_id`-scoped)

- **Tenancy/auth:** `orgs`, `users`, `memberships` (role: owner/admin/member), `sessions`, `beta_access` (flag ativo — abstrai billing futuro).
- **Integrações:** `ad_accounts` (meta_business_id, ad_account_id, **token cripto**, token_status, last_validated_at), `channel_instances` (1 Evolution/org: instance, número conectado, status, webhook_secret), `contacts` (telefone, verified, vínculo user/conta, papel).
- **Agente (config = personalização):** `agents` (por ad_account: persona, system_prompt, **objetivos** ex. target CPA/ROAS, cadência, **autonomia** (exige aprovação? por risco), model config), `agent_tool_definitions` (catálogo em DB: key, riskLevel, isIdempotent, schema, requiredPermission, requiredEntitlement), `agent_tool_bindings` (allowlist por agente), `guardrail_configs` (max_budget_change_pct, max_entities_per_day, allowed_actions, dry_run, kill_switch, **llm_cost_cap**), `playbook_rules` (condição métrica → ação, on/off), `recommendation_feedback` (👍/👎, status aplicada/ignorada, **outcome** métrica-depois).
- **Execução/auditoria:** `agent_runs` (trigger, status, **config_snapshot**, token_usage, cost_snapshot, trace_id), `agent_run_steps`, `agent_tool_calls` (idempotencyKey, riskLevel, args, result, **before_state** p/ rollback), `approvals` (status, payload, run_id, contact_id, **reply_token**, expires_at), `recommendations` (título, racional, ação proposta, status suggested/applied/dismissed).
- **Conversa:** `conversations`, `messages` (inbound/outbound por contato).
- **Metering:** `usage_events` (org, run, provider, model, input/output tokens, custo, ts) — base p/ cobrança por uso.
- **Audit:** `audit_log`.

---

## Integração Meta (MVP)

- **Token:** System User token do BM do cliente (**não expira**). Onboarding = **walkthrough guiado** (criar System User → atribuir ad account → selecionar nosso App Meta → gerar token com escopo `ads_read`+`ads_management` → colar). Guardar cripto.
- **App Meta:** precisamos de 1 App (dev mode) selecionável no BM do cliente. Sem App Review no MVP (Standard Access em conta própria).
- **Escopos:** `ads_read` (leitura/insights/criativos), `ads_management` (mutação), `business_management` se resolver assets sob business.
- **Insights:** **async report jobs** (`report_run_id` → poll → GET), campos/período estreitos, `level` account/campaign/adset/ad.
- **Criativos p/ visão:** `image_url`/`thumbnail_url` (confiável), `body`/`title`/`call_to_action`. Vídeo `source` = incerto por conta (usar thumbnail).
- **Rate limit (crítico):** Standard Access é baixo. Mitigações **desde o dia 1**: async insights, cache Redis por janela, backoff lendo `X-Business-Use-Case-Usage`, **jitter/stagger** dos crons entre contas.
- **Token inválido:** detectar `OAuthException code 190` → `token_status=invalid` → notificar org (WhatsApp + web) p/ recolar.
- Graph API **v26**, pinar versão. HTTP cru (SDK oficial opcional).

---

## Canal WhatsApp (Evolution) — MVP

- **1 instância Evolution por org**, conectada pela org via QR (casa com "org configura WhatsApp"; número da agência = legítimo, espalha risco de ban).
- **Outbound:** proativo livre (não-oficial, sem janela 24h). **Throttle** no proativo p/ reduzir ban.
- **Inbound:** webhook → `api` → resolve contato → enfileira (on-demand run ou resolução de approval). **Desconhecido = ignora em silêncio.**
- **Verificação de contato:** onboarding envia código → cliente responde → vincula telefone ao tenant (opt-in = menos spam).
- **Aprovação conversacional (sem códigos):** no `interrupt`, o agente persiste as ações pendentes e manda mensagem em linguagem natural listando o que achou. Resposta livre do usuário → Grafo B (ReAct) com as ações pendentes como contexto + tool de resolver → mapeia fala→ações (structured output sobre conjunto pequeno). **Rede de segurança inegociável:** antes de QUALQUER escrita, o agente **ecoa concretamente** o que vai fazer e espera confirmação; ambiguidade = pergunta; nunca aplica em interpretação incerta. Guardrail sempre. **Expira em 24h** sem resposta → avisa "expirou, peça de novo" (repropor = futuro). Escrita pedida no chat: sempre confirma+guardrail, ignora nível de autonomia.
- **Ban/SPOF:** abstrair atrás de `MessagingChannelPort` → trocar por Cloud API/pool de números depois sem reescrever.

---

## Segurança & guardrails (configuráveis)

- **Blast radius:** % máx de budget por mudança, nº máx de entidades/dia.
- **Snapshot + rollback:** `before_state` em cada `agent_tool_call` de escrita → desfazer.
- **Kill-switch** global por agente/org. **Dry-run** opcional.
- **Autonomia por risco:** tool `riskLevel` + config decide auto-aplicar × pedir OK.
- Aprovação humana **não** substitui guardrail (humano erra clicando OK no chat).

---

## Deploy (EasyPanel)

Serviços: **web** (build Angular estático atrás de nginx/Caddy), **api** (Node), **worker** (Node, mesmo repo/entrypoint diferente), **postgres**, **redis**. Domínios + SSL pelo EasyPanel. Evolution = instância existente (api/worker consomem via HTTP + webhook). Backups do Postgres agendados (mitiga SPOF do box único).

---

## Entregável desta fase (o que vamos gerar AGORA)

**Não é implementar o MVP inteiro** — é gerar (1) o **esqueleto do monorepo** e (2) o **CLAUDE.md** com todas as decisões. Milestones abaixo são a construção seguinte.

### Esqueleto do monorepo (stubs, sem lógica)

```
trafego-agent/
  pnpm-workspace.yaml · tsconfig.base.json · .env.example · CLAUDE.md · docker/
  apps/
    web/            Angular 21 (design system vendorizado: styles.css, DESIGN.md, shared/ui/)
      src/app/features/{onboarding, accounts, agents, timeline, settings}/
      src/app/core/{api(kubb), auth, navigation}/ · scripts/validate-design-tokens.mjs
    api/            Fastify
      src/modules/{auth, orgs, accounts, channels, agents, approvals, runs, billing, webhooks}/
        <mod>/{routes.ts, service.ts, schema.ts, adapters/}
      src/composition.ts · src/http/server.ts · src/openapi/
    worker/         Node BullMQ
      src/graphs/{account-analysis/, whatsapp-conversation/}
      src/executors/{meta-tools, control-tools}.ts · src/schedulers/account-cron.ts
      src/workers/{agent-runs, webhook-inbound}.ts · src/main.ts
  packages/
    shared/   src/ports/{ads-platform, messaging-channel, llm-provider, credential-vault,
              scheduler, metering, approval}.port.ts · types/ · schemas/
    core/     src/{playbook, guardrails, decision, brief}/ (+ *.test.ts)   ← functional core puro
    db/       src/schema/*.ts · drizzle/ · src/client.ts
    ads-meta/ src/{client, insights, creatives, mutations, governor}.ts    ← AdsPlatformPort
    channel-evolution/  src/{client, webhook, send}.ts                     ← MessagingChannelPort
    llm-openrouter/     ← LLMProviderPort
    config/   env schema (zod), eslint, tsconfig
```

### CLAUDE.md — seções

1. Visão + ICP + proposta de valor · 2. Escopo MVP (in/out) · 3. Glossário de domínio · 4. Decisões de arquitetura (com o *porquê*) · 5. Portas & adapters · 6. Data model · 7. Agente (grafos, híbrido, autonomia por origem, curadoria+governor) · 8. Regras de negócio (autonomia, guardrails, aprovação eco+confirma, expiração 24h, ban-safety, rate-limit, retenção 90d) · 9. Integrações (Meta token/escopos/v26, WhatsApp Evolution) · 10. Personalização (arquétipos/superfície única/playbook) · 11. Metering & billing (markup) · 12. Segurança & multi-tenancy (cripto, org scoping, RBAC extensível, LGPD) · 13. Convenções (TDD, erros, obs, idempotência) · 14. Deploy EasyPanel · 15. Roadmap/fast-follows · 16. Comandos.

---

## Roadmap macro — fatias (walking-skeleton-first)

Estratégia: **esqueleto ambulante primeiro**, depois aprofunda. **Deploy no EasyPanel desde a Fatia 0.** Cada (sub)fatia é independentemente demonstrável/testável e **vira depois um `planning-trafego-feature` próprio** antes de implementar.

**Sequência (13 sub-fatias):** `0` → `1a` `1b` → `2a` `2b` → **`3a`** `3b` → `4` → `5a` `5b` `5c` → `6a` `6b`.
- **`3a` = validação da hipótese** (recomendação boa no WhatsApp, sem escrita).
- **Após `3b` = largada do beta read-only** (usuários reais, sem risco de budget) — roda em paralelo às fatias 4→6.
- Escrita na Meta só a partir de **`5a`**, atrás de guardrail; aprovação humana em **`5b`**; chat aberto ReAct em **`5c`** (reavaliar valor×custo antes).

### Fatia 0 — Espinha ambulante (+ deploy)
- **Objetivo:** provar **integração + deploy** (não qualidade de IA).
- **Escopo:** 1 beta org **hardcoded** (seed + `BETA_ORG_ID`); POST cru p/ colar token (curl, sem UI); `AdsPlatformPort.getInsights` só spend account-level **síncrono** (sem governor — dívida aceita, endurece na Fatia 2); worker job **manual/on-demand** (POST dispara) → resumo **templated (sem LLM)** → `MessagingChannelPort.sendMessage` (instância+telefone via env); migration mínima (org + ad_account).
- **Deploy:** **api + worker + postgres + redis** no EasyPanel (sem web — UI entra na Fatia 1).
- **Dependências:** nenhuma. Usa 1 método real por adapter (ads-meta, channel-evolution); resto stub.
- **Testável:** e2e manual (colo token → chega WhatsApp) + integração com Meta client e Evolution send mockados. Deploy verde = parte do done.

### Fatia 1a — Plataforma (auth/tenancy + shell)
- **Self-signup** (email+senha, argon2) + login + sessão iron-session; org/user/membership + **`beta_access` gate** (signup livre, mas agente só roda com beta ativo); **org-scoping** helper; env schema no boot; **contrato zod→OpenAPI→kubb** ligado; migrations disciplinadas; **credential vault** (AES-GCM) — migra token da Fatia 0; middleware erro/audit/metering; pino; **app-shell web** + login/signup. **Web sobe no EasyPanel** (5º serviço).
- **Valida:** signup → login → org criada; shell navega; token do skeleton agora cripto no vault.

### Fatia 1b — Onboarding real (conectar conta)
- Tela **form mínimo**: colar token → **validar** (trata erro 190) → **listar contas** (`GET /me/adaccounts`) → **escolher** → `ad_account` persistida (cripto). Substitui o POST cru da Fatia 0. Passo-a-passo do System User = doc + concierge no beta.
- **Depende:** 1a (auth/org/vault). **Valida:** usuário conecta conta pela UI, conta aparece na lista.

### Fatia 2a — Meta read + governor (IO)
- `AdsPlatformPort` completo: entidades + **insights async** (report jobs) + criativos (image/thumbnail); **governor mínimo-correto** (lê `X-Business-Use-Case-Usage`, backoff no reset, jitter, degradação graciosa — bucket-por-conta/batch tuning = depois); `insights_snapshots` + **sync incremental** (watermark derivado do snapshot + rejanela de re-fetch `INSIGHTS_REFETCH_WINDOW_DAYS`; **retenção/prune = 6b**). Normaliza `actions` → breakdown de conversão **genérico** (padrão + personalizadas resolvidas por nome, cache Redis); fixa a janela de atribuição da Meta (`use_unified_attribution_setting`) — distinta da janela de re-fetch.
- **Depende:** 1b. **Valida:** coleta de conta real → snapshots gravados; governor respeitando rate-limit.

### Fatia 2b — AccountBrief (core puro)
- Curadoria **pura**: totals(+delta) + **rank/select top-N** + agregados da cauda + **tendência simples**. (Anomalia z-score + seleção de visão rica = quando a análise pedir.) `computeDerived` calcula **CPA/ROAS pela conversão primária de cada entidade** (objetivo próprio; override do agente vence); nível-conta com objetivos mistos → sem CPA único enganoso. `selectCreatives` = vazio até a visão (3b).
- **Depende:** 2a (snapshots/insights). **Valida:** funções puras testadas sem rede → AccountBrief compacto a partir de fixtures.

### Fatia 3a — Loop de análise ⇒ **VALIDAÇÃO DA HIPÓTESE**
- Grafo A `account-analysis` **read-only**: `load_context → fetch_data (reusa 2a) → run_playbook (core) → llm_analyze (OpenRouter, **texto**, sem visão) → build_recommendations → notify (WhatsApp)`. Implementa o adapter **OpenRouter** (`LLMProviderPort`). **On-demand por botão no web** (sem inbound). `recommendations` persistidas.
- **Depende:** 2b (AccountBrief). **Valida (marco):** botão → recomendações **boas** no WhatsApp, **sem risco de escrita**.

### Fatia 3b — Cadência + visão + medição
- **Cron por conta** (BullMQ scheduler + jitter); **visão de criativo** (multimodal) no `llm_analyze`; `recommendation_feedback` (👍/👎 + status + outcome); **metering usage/cost + cap por org**.
- **Depende:** 3a. **Valida:** cron dispara sozinho; análise inclui criativo; feedback capturado; custo medido/limitado.

### Fatia 4 — Config do agente (personalização) — feature cross-stack única
- **Superfície única semeada por arquétipo** + edição inline + avançado progressivo; **playbook em linguagem natural** (templates com lacunas → `PlaybookRule`); `guardrail_configs`; `autonomy_policy`; cadência configurável; **zero-config**. Arquétipos em **tabela `agent_archetypes`** (Conservador/Otimizador seed). Backend: `agents` config API (+ schemas zod→kubb). Frontend: tela de config. *(Catálogo de tools `agent_tool_definitions`/`bindings` = Fatia 5, com as tools de escrita.)*
- **Depende:** 3 (agents com defaults). **Antes da 5** (configurar a rede antes de soltar escrita). **Valida:** escolher arquétipo, ajustar meta/regras/autonomia → run seguinte usa a config.

### Fatia 5a — Mecânica de escrita + guardrails
- **Guardrail engine** (blast radius/budget cap/kill-switch/dry-run, defaults conservadores) + `decide_actions` (autonomia por origem) — **core puro**. Tools de escrita (pause/budget/status) via `mutate` (**idempotência + `before_state` + rollback**). **Catálogo de tools** (`agent_tool_definitions`/`bindings`, vindo da 4).
- **Depende:** 4, 3, 2a. **Valida:** auto-aplicar dentro de **guardrail apertado** numa **conta de teste** (autonomia=act_full) → escrita + rollback + guardrail bloqueando, **sem gate humano ainda**.

### Fatia 5b — HITL (aprovação conversacional)
- **Inbound plumbing** (webhook → resolve contato → roteia); **aprovação conversacional** (persistir ações pendentes → mensagem natural → resposta livre mapeada → **eco+confirma antes de escrever**) + **interrupt/resume durável** (checkpoint Postgres); **expiração 24h** → avisa.
- **Depende:** 5a. **Valida:** agente propõe → aprovo no WhatsApp (conversa) → aplica → confirma; expira em 24h.

### Fatia 5c — Grafo B ReAct pleno (chat aberto) = **end-state**
- Chat conversacional ad-hoc (perguntas sobre a conta/análise, "analisa agora" via WhatsApp, pedidos ad-hoc) com allowlist de tools + guardrails + eco+confirma. Fluxo tipo Claude-com-tools, scoped à conta. **Peça mais cara** — reavaliar valor×custo antes de iniciar.
- **"Mexer em qualquer coisa" = as tools do catálogo.** MVP = **tools núcleo de escrita** (pausar/reativar, ajustar budget, mudar status) via `mutate` idempotente + guardrail. Ampliar leque (targeting/bid/schedule…) = **adicionar tool no catálogo-DB**, sem re-arquitetar. **Criar campanha = Fatia 7 (roadmap pós-MVP)** — gestor completo no WhatsApp (asset via WhatsApp/upload/reuse, copy por LLM, Creative Library + StoragePort; criativo por IA = fase mais tardia). Ver `docs/ROADMAP.md`.
- **Depende:** 5b. **Valida:** conversa livre entende e age (com confirmação) dentro dos guardrails.

### Fatia 6a — Timeline / auditoria (UI)
- **Timeline** de análises/ações/aprovações por conta (web) + trilha de auditoria visível. Feature user-facing de confiança.
- **Valida:** ver histórico de runs/ações/aprovações na dashboard.

### Fatia 6b — Endurecimento / ops
- Consolidar o que faltar: ban-safety throttle no outbound, fluxo token-inválido (code 190), degradação graciosa polida, **backups Postgres** no EasyPanel. Allowlist beta = **toggle via script/DB** (UI admin = fast-follow).
- **Valida:** operar um beta real ponta-a-ponta com resiliência.

---

### 🚩 Linha de largada do beta = **após 3b** (read-only)
Abrir beta com **usuários reais recebendo recomendações no WhatsApp (sem escrita)** logo após 3b, **em paralelo** à construção de 4/5. Feedback real cedo, risco zero de budget. Fatias 4→5→6 continuam com beta rodando.

**Dependência:** sequência majoritariamente linear (0→6). Paralelizável quando um `planning` específico confirmar: ex. config (4) começa assim que o backend de `agents` (3) existe; parte da curadoria (2) sobrepõe fundações (1); 6a/6b em paralelo às fatias de escrita.

## Paralelização — dois tracks (git worktrees)

**Pré-requisitos:** `git init` (repo ainda não é git) + **mover o repo p/ fora do OneDrive** (ex: `C:/dev/agente-trafego`) — worktree multiplica `node_modules` e OneDrive causa sync storm/long-path. (pnpm usa store global content-addressable → worktrees compartilham o store, aliviando o custo.)

**Modelo:** dois tracks fixos em worktrees/branches separados, sincronizando no **contrato kubb**:
- **Track A — Backend/Infra:** `apps/api`, `apps/worker`, `packages/*` (core, db, adapters, shared), deploy.
- **Track B — Frontend:** `apps/web` (consome o **client kubb gerado**).

**Regras de ouro (evitam conflito):**
1. **Solo primeiro:** `0` e `1a` numa sessão só — montam a espinha + contratos que os dois tracks consomem. Só forkar depois.
2. **Contract-first por fatia:** antes de forkar as 2 sessões numa fatia, **travar o schema zod** (fonte do contrato) na base compartilhada. Track B gera o client e trabalha; Track A implementa o backend. Sem isso, o frontend regenera em cima de contrato mudando.
3. **Serializar a espinha compartilhada:** `packages/shared` (tipos/ports/schemas), `packages/db/schema` + **migrations**, composition roots, `.env.example` têm **um dono por vez** (idealmente Track A, num commit-base antes do fork).
4. **Merge por branch/PR** ao fim de cada fatia; rodar `reviewing-trafego-changes` antes de integrar.

**Pares naturais por fase:** `1b` (onboarding, A+B) ∥ `2a` (adapter ads-meta, A) · Fatia `4` API (A) ∥ tela (B) · `5a`/`5b` (A) ∥ `6a` timeline (B) · `6a` ∥ `6b`.

---

## Riscos & mitigações

| Risco | Mitigação |
|---|---|
| Ban do número Evolution | Número da org, opt-in, throttle proativo, porta trocável (Cloud API depois) |
| Rate limit Meta (Standard Access baixo) | Async insights, cache, backoff por header, jitter nos crons |
| Token inválido/revogado | Detecção code 190 + fluxo de recolar |
| Custo LLM multimodal | Metering desde dia 1, limitar nº de criativos/run, cache de análise |
| Aprovação no chat apressada | Guardrails independentes da aprovação |
| Box único (SPOF) | Backups Postgres, snapshots EasyPanel; multi-node depois |
| Onboarding do token complexo | Walkthrough guiado passo-a-passo na web |

---

## Verificação (end-to-end)

- **Unit (Vitest):** portas/adapters com Meta e Evolution mockados; guardrail engine; playbook rules; metering.
- **Integração:** graph LangGraph com fixtures gravadas (insights/criativos), fluxo approval→resume.
- **Manual e2e:** conta Meta de teste + WhatsApp de teste → rodar análise → receber recomendação no WhatsApp → aprovar → confirmar mudança no Ads Manager → testar rollback → conferir `usage_events`.
- **Observabilidade:** traces LLM (Langfuse opcional), `agent_runs`/`tool_calls` como trilha de auditoria.
- **Design:** `tokens:check` verde no `web`.

---

## Skills do projeto — planejar / implementar / revisar

### Context
Criar 3 skills project-scoped que codificam o workflow de engenharia deste repo (backend VSA/Node + frontend Angular), seguindo best-practices de autoria de skills (Anthropic + superpowers:writing-skills) e os princípios já definidos. Objetivo: qualquer sessão futura planeja, implementa e revisa mudanças de forma consistente com o CLAUDE.md, sem reinventar. **Skills FINAS**: orquestram o fluxo, **referenciam o CLAUDE.md como fonte da verdade** (não duplicam regras) e **compõem superpowers**. Cobrem backend+frontend via **progressive disclosure** (`backend.md`/`frontend.md`).

### Local & nomes
Repo `.claude/skills/` (versionadas com o código). Nomes gerúndio EN; description em 3ª pessoa, "Use when...", triggers PT+EN **disjuntos**, **sem resumo de workflow** (senão Claude segue a description e pula o corpo).
- `planning-trafego-feature/` — **só SKILL.md** (holístico, raciocina cross-stack)
- `implementing-trafego-feature/` — SKILL.md + backend.md + frontend.md
- `reviewing-trafego-changes/` — SKILL.md + backend.md + frontend.md

### Substância (evitar thin-wrapper)
Invariantes/regras ficam no **CLAUDE.md (always-on)**; as skills carregam o **net-new**: sequência de workflow + **checklists acionáveis por stack** + orquestração de superpowers + máquina de veredito. Não repetem o "quê/porquê" — carregam o "como/quando".

### Regras de autoria (aplicadas às 3)
- Corpo PT-BR, keywords EN na description; body < 500 linhas; paths com `/`.
- Referenciar superpowers **por nome** (sem `@`, que força-carrega). Referenciar CLAUDE.md **por nome de seção** (âncora), nunca por número (evita "string mágica" quebrável).
- `backend.md`/`frontend.md` a **um nível** de profundidade do SKILL.md.
- **Handoff = sugestão com checkpoint** (plan→implement→review): cada skill termina sugerindo a próxima, mas **não auto-invoca**; plano aprovado antes de implementar (respeita o HARD-GATE do brainstorming). Cada uma usável isolada.

### 1. `planning-trafego-feature` (holístico, só SKILL.md)
- **Description (trigger):** planejar/planning **antes de codar** — nova feature, slice, tela, endpoint, entidade, porta no CaquiAI; "planejar feature", "nova tela", "novo endpoint".
- **Workflow:** compõe `superpowers:brainstorming` (intenção, sem assumir, perguntas críticas 1-a-1) → `superpowers:writing-plans`. Raciocina **cross-stack** (feature toca backend+frontend junto). Gates project-specific (ref CLAUDE.md por nome de seção): mapear camada(s) tocada(s) (slice VSA? nova porta na borda? função pura no core? feature Angular?); **reuso-primeiro** (buscar em `packages/{shared,core,db}` + adapters antes de propor novo); definir costura de extensibilidade.
- **Termina** sugerindo (com checkpoint) `implementing-trafego-feature`.

### 2. `implementing-trafego-feature`
- **Description (trigger):** implementar/implementing feature, slice, endpoint, componente (após plano); "implementar", "codar feature".
- **Workflow:** compõe `superpowers:test-driven-development` (RED-GREEN-REFACTOR) + `superpowers:subagent-driven-development` (subagente por slice independente). Injeta (ref CLAUDE.md §13 + princípios): core puro testado primeiro; portas só nas bordas; estrutura de slice VSA; exceções na casca / tipos no core; idempotência; org-scoping; **eco+confirma** em fluxo de escrita; ESM `.js`; zod nas bordas. Frontend: Angular standalone/signals, **tokens sem cor hardcoded**, roda `tokens:check`.
- **Termina** apontando p/ `reviewing-trafego-changes`.

### 3. `reviewing-trafego-changes`
- **Description (trigger):** revisar/reviewing diff/PR/mudança antes de mergear; "revisar", "code review".
- **Workflow:** compõe o `/code-review` existente (bugs/segurança/eficiência) e **adiciona dimensão de aderência aos princípios**. Execução: **subagentes paralelos por dimensão** (backend correctness, frontend, segurança, aderência), **escalando o esforço ao tamanho do diff** (diff pequeno = menos fan-out, como o /code-review low/medium/high). Saída: findings estruturados (severidade, arquivo:linha, dimensão) + **veredito bloqueia/passa**.
- **Checks de aderência (ref CLAUDE.md + §13):** fronteiras VSA (sem vazamento cross-slice; portas só nas bordas), pureza do core (zero IO em `packages/core`), idempotência, org-scoping (sem vazamento cross-tenant), eco+confirma antes de escrever, guardrail independente da aprovação, metering nos writes, **sem hardcode/string mágica**, design tokens (`tokens:check`, sem cor hardcoded), reuso (lógica duplicada?), funções enxutas/legíveis, desacoplamento.

### Edição no CLAUDE.md
Adicionar à **§13 (Convenções)** os princípios de engenharia como fonte da verdade referenciada pelas skills: **sem string mágica/hardcoded · modularidade · separação de interesses · funções enxutas e legíveis · desacoplamento · extensível/genérico · reuso-primeiro**.

### Arquivos a criar/editar (7 arquivos + 1 edição)
- `.claude/skills/planning-trafego-feature/SKILL.md` (só isso — holístico).
- `.claude/skills/implementing-trafego-feature/{SKILL.md, backend.md, frontend.md}`.
- `.claude/skills/reviewing-trafego-changes/{SKILL.md, backend.md, frontend.md}`.
- Editar `CLAUDE.md` seção **Convenções** (princípios de engenharia).

### Verificação
(Usuário optou por **sem teste formal** — contra a Iron Law do writing-skills, registrado.) Sanidade manual: invocar cada skill numa tarefa representativa (planejar→implementar→revisar um slice pequeno) e confirmar que (a) referencia CLAUDE.md, (b) compõe as superpowers certas, (c) carrega backend.md/frontend.md conforme o stack, (d) faz o handoff / emite veredito. Ajustar description se o trigger não disparar.

---

## Design & Layout do sistema (base pra todo o futuro)

### Context
Definir a IA, o layout e a linguagem visual do produto, **baseado nos padrões reais da plataforma Automato** (`automato-web`), pra reuso máximo e coerência. Vira **`docs/DESIGN.md`** (fonte da verdade de design), referenciado cruzado. North-star herdado: **"Operational Glass Desk"** (Stripe clareza + Attio workflow/records + Raycast glass/noise) — **Rare Accent** (emerald só p/ decisão/seleção), **No Generic AI**, product-scale type, **status = tom+texto** (nunca só cor), composição *object header → área de trabalho → rail de contexto → trace de atividade*, grain/noise em superfícies quietas, light+dark, WCAG AA.

### IA / Navegação (account-centric)
- **Shell:** reusar o `app-shell` do Automato **verbatim** (grid sidebar+painel, nav agrupada, org switcher, command palette, theme toggle, surface-noise).
- **Objeto central = Conta** (ad account); **agente é entidade aninhada na conta** (1:1 hoje via unique FK; soltar unique = N agentes/conta sem re-arquitetura).
- **Módulos de topo:** **Contas** (landing) · **Aprovações** (inbox cross-account) · **Integrações** (canal WhatsApp da org + conectar Meta + saúde) · **Configurações**. (Sem Dashboard no MVP.)

### Telas
- **Contas (landing):** `ui-page-header` ("Contas", count, [Conectar conta] primary) → `ui-filter-bar` (status/busca) → `ui-resource-grid` de **cards ricos** (nome + status agente + status token + KPIs spend/CPA/ROAS 7d + nº pendências + "analisado há X") → `ui-empty-state` ("Conecte sua primeira conta").
- **Conta (detalhe):** header (backLink, nome, badges, ações) + **router-tabs**:
  - **Visão geral:** `ui-stat` KPIs + estado (agente ativo/pausado, token, próxima análise, pendências).
  - **Agente:** **superfície única seccionada** (padrão builder Automato: eyebrow+h2+help+form-grid por seção) semeada por arquétipo → Identidade / Meta (target CPA-ROAS) / Autonomia (slider) / Segurança (guardrails) / Regras (playbook em linguagem natural) / Cadência / `<details>` avançado. **Save bar dirty** ("não salvo/salvo"). Zero-config.
  - **Timeline:** feed unificado de atividade (net-new — ver abaixo).
  - **Conexões:** status Meta token (válido/inválido + recolar via connect-dialog) + **contato WhatsApp destinatário** da conta + **modo de operação** (padrão aba Deployments Automato: status active/paused + autonomia).
- **Aprovações (inbox):** `ui-record-list` cross-account de pendências; cada = conta + ação(ões) proposta(s) + racional + **[Aprovar]/[Recusar] acionável** (mostra eco concreto + confirma → backend guardrail + interrupt/resume). Filtro por conta/status. Espelha o WhatsApp.
- **Integrações:** padrão Automato — "Conectadas" (card do canal WhatsApp da org com health + contas Meta conectadas) + "Disponíveis" (Meta Ads, WhatsApp) via **connect-dialog + connector-strategy** (reusa connector `meta-ads`; **novo connector `evolution-whatsapp`** p/ QR/status). "Meus Canais" = instância Evolution.
- **Configurações:** org, usuários (self-signup + membros), beta/assinatura, perfil, tema (reusa padrão settings Automato).

### Onboarding (first-run)
Contas vazio → CTA → **connect-dialog** (colar token → validar/erro 190 → listar contas → escolher) → prompt conectar **WhatsApp** (Integrações, QR) → agente **auto-semeado** pelo arquétipo default (zero-config).

### Timeline — componente net-new (`ui-timeline`)
Não existe no Automato (greenfield). Feed vertical **agrupado por dia**; cada evento = ícone (por tipo) + título + detalhe + **status badge (tom+texto)** + timestamp. Tipos: `analysis_started/completed`, `recommendation_created`, `approval_requested/approved/rejected/expired`, `action_applied/rolled_back`, `error`. Segue o ritmo do `ui-record-list` + guidance "compact activity trace" do DESIGN.md.

### Princípios de UX (novos — par dos de engenharia)
- **Erros sempre tratados e amigáveis:** nunca vazar exceção/stack/código técnico; toda falha vira mensagem clara.
- **Erro = o que aconteceu + o que fazer** (1 frase, sem "Error:", sem culpa técnica).
- **Foco no não-técnico:** sem jargão; traduzir termos (CPA, adset, token) quando aparecerem.
- **Sempre mostrar o que está acontecendo:** loading/progresso/vazio/sucesso claros; usuário nunca no escuro.
- **Sempre o próximo passo:** empty states e confirmações apontam a ação.
- Sentence case; "arquivo enviado" (não "enviado com sucesso!"); status = tom+texto.

### Mapa de reuso (Automato → nosso)
Vendorizar: `app-shell`, `ui-page-header`, `ui-section-header`, router-tabs, `ui-filter-bar`(+chips), `ui-resource-grid`/`card`, `ui-record-list`, `ui-data-table`, `ui-empty-state`, `ui-stat`/`ui-meter`, `ui-detail-drawer`, `ui-form-field`/`ui-select-field`/`ui-switch`/`ui-range`, **connect-dialog + connector-strategy**, padrão da **aba Deployments** (→ aba Conexões). **Net-new:** `ui-timeline`.

### Edições associadas (execução, fora do plan mode)
- **Criar `docs/DESIGN.md`** (todo o acima).
- **CLAUDE.md:** nova seção **Princípios de UX** + ref a `docs/DESIGN.md`.
- **`implementing-trafego-feature/frontend.md`:** checklist UX-copy (erro tratado/amigável, estados loading/vazio/sucesso, próximo passo, sem jargão) + ponteiros de arquétipos de página + mapa de reuso + ref `docs/DESIGN.md`.
- **`reviewing-trafego-changes/frontend.md`:** checks de aderência UX (bloqueia exceção crua vazando, copy sem próximo passo, estado ausente, status só-cor, Rare Accent, No Generic AI) + ref `docs/DESIGN.md`.
- **Referência cruzada** a `docs/DESIGN.md` em README, CLAUDE.md e `docs/ROADMAP.md` onde relevante.

### Verificação
Sanidade: telas seguem os arquétipos (page-header→filter→grid/list; detalhe=header+router-tabs); `tokens:check` verde; erros testados mostram mensagem amigável+próximo passo; Timeline renderiza os tipos de evento com tom+texto; connect-dialog reusado conecta Meta (colar token) e WhatsApp (QR).

---

## Fora do escopo (MVP) — fast-follow

OAuth oficial Meta + App Review + Advanced Access; WhatsApp Cloud API/pool de números; Stripe (mensalidade + custo por uso — metering já pronto); Google/TikTok Ads (via `AdsPlatformPort`); pacote `@automato/design-system` compartilhado; multi-agente por conta.

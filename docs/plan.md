# Plano de Arquitetura — SaaS de Agentes de IA para Tráfego Pago (MVP Meta Ads)

## Context

Validar rápido um **produto SaaS standalone** onde **agentes de IA personalizáveis tocam tráfego pago de forma (semi)autônoma**: de tempos em tempos analisam a conta Meta Ads (métricas + criativos), geram recomendações e — conforme configuração — aplicam mudanças, atuando **principalmente via WhatsApp**. O produto é novo e independente, mas **reusa os padrões arquiteturais da plataforma Automato existente** (não o código-fonte diretamente). Princípio norteador em toda decisão: **desacoplado, genérico, extensível e configurável** — trocar provider/canal/plataforma depois deve ser adicionar um adapter, sem tocar no core.

**ICP (MVP):** players de saúde no digital (cursos/infoproduto) que fazem **lançamentos**. Anunciam de verdade (conta Meta ativa — pré-requisito do produto de otimização). Dores: (1) trabalho manual diário de tráfego; (2) ciclo de lançamento (intenso no lançamento, **conta parada** entre eles). Valor: reduz trabalho diário + vigia forte no lançamento (never miss timing) + não deixa conta morrer. **Comprador:** ambos — o próprio player (org de 1-poucas contas) e gestores de tráfego que os atendem (org multi-conta). PME-que-não-anuncia = fora do MVP (exigiria criar campanha do zero = outro produto).

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

Camada **determinística pura** entre Meta e LLM. LLM nunca vê o firehose, vê um `AccountBrief` compacto (token-bounded): `account, goals, totals(+delta), trends, segments(top-N+flagados), anomalies(z-score), creatives(só flagados, com imagem p/ visão), playbookCandidates, memory(objetivos/tentado/recusado), aggregatesRest`. Pipeline: `normalize → computeDerived → computeTrends → detectAnomalies → rankAndSelect → summarizeRest → selectCreatives → assembleBrief`. Resolve degradação da análise **e** custo de visão.

**Governor:** token-bucket por `ad_account` (Redis, lê `X-Business-Use-Case-Usage`), Batch API (≤50/HTTP), async report jobs, snapshot histórico em Postgres (`insights_snapshots`), sync incremental (só ativas/mudadas), jitter/stagger nos crons, degradação graciosa (roda com cache/parcial, nota "análise parcial").

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

## Fatiamento em milestones testáveis (TDD — superpowers)

1. **Fundações:** monorepo pnpm, Angular shell + design system vendorizado (roda `tokens:check`), api/worker skeleton, Drizzle schema base, auth sessão, org/user/membership, deploy EasyPanel end-to-end.
2. **Meta read-path:** conectar ad account (walkthrough System User token) + validação/erro 190; `AdsPlatformPort` Meta (entidades + insights async + criativos) com cache/backoff.
3. **Canal WhatsApp:** conectar instância Evolution por org (QR/status), webhook inbound, send outbound, verificação de contato, roteamento.
4. **Agente (read-only primeiro):** LangGraph `meta-account-analysis` só análise, OpenRouter + visão de criativo, playbook rules engine, `recommendations`, cron por conta + on-demand, **metering usage/cost**. → **entrega valor cedo** (recomendação no WhatsApp, sem escrever na Meta).
5. **Ação + HITL + guardrails:** tools de escrita (pause/budget/status), guardrail engine, approval via WhatsApp (interrupt/resume), snapshot + rollback, kill-switch, config de autonomia.
6. **UI de config + timeline:** telas de config do agente (persona, cadência, guardrails, playbook, tools), timeline de análises/ações por conta, gate beta allowlist.

Cada milestone é independentemente demonstrável. Ordem prioriza provar o **valor da análise** (M4) antes do risco da **ação** (M5).

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

## Fora do escopo (MVP) — fast-follow

OAuth oficial Meta + App Review + Advanced Access; WhatsApp Cloud API/pool de números; Stripe (mensalidade + custo por uso — metering já pronto); Google/TikTok Ads (via `AdsPlatformPort`); pacote `@automato/design-system` compartilhado; multi-agente por conta.

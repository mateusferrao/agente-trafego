# CLAUDE.md — Agente de Tráfego (SaaS)

> Guia único de decisões de arquitetura, produto e regras de negócio. Toda decisão aqui foi batida criticamente. Antes de implementar qualquer coisa, leia a seção relevante. **Princípio-mestre:** desacoplado, genérico, extensível e configurável — trocar provider/canal/plataforma = adicionar um adapter, sem tocar no core.

---

## 1. Visão + ICP + proposta de valor

**Produto:** SaaS standalone onde **agentes de IA personalizáveis tocam tráfego pago de forma (semi)autônoma**. De tempos em tempos o agente analisa a conta Meta Ads (métricas + criativos), gera recomendações e — conforme configuração — aplica mudanças, atuando **principalmente via WhatsApp**.

**ICP (MVP):** players de saúde no digital (cursos/infoproduto) que fazem **lançamentos**. Já anunciam de verdade (conta Meta ativa = pré-requisito). Dores: (1) trabalho manual diário de tráfego; (2) ciclo de lançamento — intenso no lançamento, **conta parada** entre eles.

**Proposta de valor:** reduz o trabalho manual diário + vigia forte no lançamento (never miss timing) + não deixa a conta morrer entre lançamentos.

**Comprador:** ambos — o próprio player (org de 1-poucas contas) e gestores de tráfego que atendem players (org multi-conta).

**Fora do ICP:** PME que **não anuncia** (exigiria criar campanha do zero = outro produto).

---

## 2. Escopo do MVP (in / out)

**IN:**
- 1 plataforma de ads: **Meta**. 1 canal: **WhatsApp via Evolution**.
- Conectar conta Meta via **System User token** colado (sem OAuth/App Review).
- Análise híbrida (playbook determinístico + LLM + visão de criativo).
- Recomendações e ações (pausar / ajustar budget / status) com guardrails.
- Aprovação **conversacional** no WhatsApp + auto-aplicar liberável por config.
- Config por **arquétipo** + superfície única (zero-config funciona).
- Cadência cron por conta + on-demand.
- Metering de custo (base p/ billing por markup).
- **Feedback + outcome tracking** nas recomendações (instrumento de validação).
- Gate de acesso = **allowlist manual de beta**.

**OUT (fast-follow):** OAuth oficial Meta + App Review; WhatsApp Cloud API / pool de números; Stripe (mensalidade + custo por uso); Google/TikTok Ads; modo lançamento×manutenção como preset; ACL por conta (RBAC granular); multi-agente por conta; pacote `@automato/design-system` compartilhado.

---

## 3. Glossário de domínio

- **Org** — tenant. Agência/gestor ou player. Contém users, contas, canais, agentes.
- **AdAccount** — conta de anúncios Meta conectada (com token cripto).
- **ChannelInstance** — instância Evolution (1 por org) = número WhatsApp.
- **Contact** — telefone WhatsApp vinculado a um user/org (verificado).
- **Agent** — configuração personalizável ligada a **1 AdAccount** (1:1 no MVP).
- **Archetype** — preset que semeia a config do agente (Conservador, Otimizador).
- **PlaybookRule** — regra determinística `condição → ação` (config do usuário).
- **Guardrail** — limite de segurança configurável (blast radius, budget cap, kill-switch).
- **AccountBrief** — briefing compacto e curado (único input do LLM).
- **Run** — execução do agente (análise). Tem snapshot de config + custo.
- **Recommendation** — achado/sugestão do run (com feedback + outcome).
- **Approval** — pedido de OK humano (HITL) para uma ou mais ações.
- **Action** — mutação concreta na Meta (pause/budget/status), com `source` (playbook|llm) e `riskLevel`.

---

## 4. Decisões de arquitetura (com o porquê)

| Decisão | Escolha | Porquê |
|---|---|---|
| Forma | Produto standalone reusando **padrões** Automato | Independência de branding/billing; não acopla ao repo Automato |
| Frontend | **Angular 21** | O design system Automato (`shared/ui`, ng-primitives, `styles.css`) porta 1:1 — reuso real, não só tokens |
| Backend | **Node (Fastify) + worker separado** | Runtime de agente = jobs longos/cron/fila → worker persistente. Next serverless não serve |
| Arquitetura backend | **VSA + portas nas bordas + functional core** | Rápido nas mudanças frequentes (feature/regra/CRUD), extensível onde importa (ports), decisão testável sem mock. Menor arrependimento |
| api × worker | Mesmo código, **processos separados** | Job pesado não trava HTTP; crash isolado; escala independente |
| Orquestração | **LangGraph.js** | Checkpoints + interrupt/resume para HITL durável de graça |
| LLM | **OpenRouter** | 1 gateway multimodal; captura custo/token nativa (essencial p/ billing por markup) |
| DB | **Postgres puro + Drizzle** | Portável via `pg_dump`; não acopla em recurso proprietário |
| Contrato API | **zod → OpenAPI → kubb** | Tipos ponta-a-ponta sem drift (padrão Automato) |
| Auth | Sessão custom (**iron-session + argon2**) atrás de `AuthPort` | Padrão Automato; zero dependência externa; roda self-host |
| Hosting | **Hostinger + EasyPanel** | Self-host; casa com "banco próprio"; Evolution já roda lá |

Ver `docs/plan.md` para o histórico completo de trade-offs discutidos.

---

## 5. Portas & adapters (o core só conhece interfaces)

Portas ficam em `packages/shared/src/ports`. Regra: adicionar plataforma/canal/provider = **novo adapter**, zero mudança no core.

| Porta | Contrato (resumo) | Adapter MVP |
|---|---|---|
| `AdsPlatformPort` | `listEntities`, `getInsights` (async), `getCreatives`, `mutate` | `@trafego/ads-meta` (Graph v26) |
| `MessagingChannelPort` | `sendMessage`, `onInbound`, `instanceLifecycle` | `@trafego/channel-evolution` |
| `LLMProviderPort` | `complete` (texto+multimodal) → `{ output, usage, cost }` | `@trafego/llm-openrouter` |
| `CredentialVaultPort` | `encrypt`/`decrypt` (AES-256-GCM, keyVersion) | local |
| `SchedulerPort` | cron/jobs por tenant | BullMQ |
| `MeteringPort` | registra `usage_events` (genérico `type`+`payload`) | Postgres |
| `ApprovalPort` | `create`/`resolve` (HITL) | Postgres |

Composition root **manual** (`apps/api/src/composition.ts`, `apps/worker/src/composition.ts`) — sem DI container.

---

## 6. Data model (Postgres, tudo `org_id`-scoped)

Schema em `packages/db/src/schema`. Grupos:

- **Tenancy/auth:** `orgs`, `users`, `memberships(role: owner|member)`, `sessions`, `beta_access(status)`.
- **Integrações:** `ad_accounts(meta_business_id, ad_account_id, token_cripto, token_status, last_validated_at)`, `channel_instances(evolution_instance, phone, status, webhook_secret)`, `contacts(phone, verified, user_id, role)`.
- **Agente:** `agents(ad_account_id, archetype, persona, system_prompt, goals, cadence, autonomy_policy, tone, model_config, status)`, `agent_tool_definitions` (catálogo-DB: key, riskLevel, isIdempotent, schema, requiredPermission, requiredEntitlement), `agent_tool_bindings(agent_id, tool_key, mode)`, `guardrail_configs(max_budget_change_pct, max_entities_per_day, allowed_actions, dry_run, kill_switch, llm_cost_cap)`, `playbook_rules(scope, when_json, then_json, enabled, priority)`, `agent_memory(type, content, confidence, lifecycle)`.
- **Dados Meta:** `insights_snapshots(ad_account_id, entity_level, entity_id, date, metrics_json)` — série temporal (retenção ~90d por env).
- **Execução:** `agent_runs(trigger, status, config_snapshot, token_usage, cost_snapshot, trace_id)`, `agent_run_steps`, `agent_tool_calls(idempotency_key, risk, args, result, before_state)`, `approvals(status, payload_actions, run_id, contact_id, expires_at)`, `recommendations(title, rationale, proposed_action, status)`, `recommendation_feedback(vote, status, outcome)`.
- **Conversa:** `conversations`, `messages(direction, body, meta)`.
- **Metering:** `usage_events(type, payload_json, provider, model, input_tokens, output_tokens, cost)`.
- **Audit:** `audit_log(actor, action, target, before, after)`.

**Reprodutibilidade:** `agent_runs.config_snapshot` congela a config no momento do run.

---

## 7. Agente (grafos + híbrido + curadoria)

**Runtime:** LangGraph **Graph API (`StateGraph`)** com checkpointer Postgres. LangChain (`@langchain/core` + `@langchain/openai` via OpenRouter) fornece modelos/tools por baixo. Graph API (não Functional) por controle explícito de nós/edges e aderência ao padrão Automato.

**Dois grafos (LangGraph):**
- **`account-analysis` (pipeline determinístico)** — cron/on-demand: `load_context → fetch_data → run_playbook → llm_analyze(+visão) → build_recommendations → decide_actions → guardrail_check → [precisa OK? create_approval + interrupt()] → apply_actions(snapshot) → notify → record`. LLM só em `llm_analyze` e `notify`.
- **`whatsapp-conversation` (ReAct + tools + guardrails)** — chat aberto: perguntas, pedidos ad-hoc, "analisa agora", e resolução de aprovações.

**Origem das ações = híbrido, autonomia por origem:** `playbook` (regras puras) gera ações-base + `LLM` propõe ações adicionais (structured output, mesmo tipo `Action`). Merge → dedupe → **guardrail** → autonomia decidida **por origem** (ex: auto-aplica playbook, pede OK no LLM — configurável). Guardrail é rede sobre os dois.

**Curadoria — `AccountBrief` (pilar):** camada **determinística pura** (`packages/core/src/brief`) entre Meta e LLM. O LLM nunca vê o firehose. Pipeline: `normalize → computeDerived → computeTrends → detectAnomalies → rankAndSelect(top-N + flagados) → summarizeRest → selectCreatives(só flagados) → assembleBrief`. Resolve degradação da análise **e** custo de visão (`ANALYSIS_MAX_CREATIVES_VISION`).

**Governor de rate-limit:** token-bucket por `ad_account` (Redis, lê `X-Business-Use-Case-Usage`), Batch API (≤50/HTTP), async report jobs, `insights_snapshots` (não re-baixa histórico), sync incremental, jitter/stagger nos crons, **degradação graciosa** (roda com cache/parcial + nota "análise parcial").

**Functional core:** `playbook`, `guardrails`, `decision` (seleção de ação) e `brief` são **funções puras** em `packages/core` — testadas sem mock. Nós do grafo são finos (só IO + chamam o core).

---

## 8. Regras de negócio

- **Autonomia:** slider (só avisa → sugere+OK → age no seguro → age sozinho). **Auto-aplicar liberável no dia 1** por config. **Por origem** (playbook × LLM).
- **Guardrails (sempre, mesmo autônomo):** blast radius (% máx budget/mudança, nº máx entidades/dia), budget cap, kill-switch, dry-run. **Defaults conservadores** — no caminho autônomo NÃO há eco+confirma, então guardrail é a única rede.
- **Aprovação conversacional:** sem códigos. Agente lista o que achou em linguagem natural; resposta livre → Grafo B mapeia fala→ações. **Antes de QUALQUER escrita: eco concreto do que vai fazer + espera confirmação.** Ambiguidade = pergunta; nunca aplica em interpretação incerta.
- **Escrita pedida no chat:** sempre confirma + guardrail (ignora nível de autonomia — chat é ambíguo demais p/ auto-aplicar).
- **Expiração de aprovação:** 24h sem resposta → expira, avisa "expirou, peça de novo" (repropor no próximo run = fast-follow).
- **Idempotência:** `agent_tool_calls.idempotency_key` — nunca aplica a mesma mutação 2x.
- **Rollback:** `before_state` em cada tool_call de escrita.
- **Ban-safety WhatsApp:** número da org, opt-in (contato verificado manda 1ª msg), throttle no proativo, **inbound de desconhecido = ignora em silêncio**.
- **Rate-limit Meta:** async + cache + backoff + jitter (ver §7). Token inválido (`code 190`) → `token_status=invalid` + avisa p/ recolar.
- **Retenção de insights:** janela rolante `INSIGHTS_RETENTION_DAYS` (~90d).
- **Cap de custo LLM:** por org/período (`guardrail_configs.llm_cost_cap`) — protege margem.
- **Zero-config:** arquétipo + conectar = funciona sem tocar em nada. Config é opcional.

---

## 9. Integrações

**Meta (Graph API v26):**
- Auth MVP = **System User token** colado (não expira). Sem OAuth, sem App Review (Standard Access em conta própria do cliente).
- Onboarding: **walkthrough guiado + concierge fallback**. Cola token → validamos → **listamos ad accounts** (`GET /me/adaccounts`) → cliente escolhe.
- Escopos: `ads_read` (insights/criativos), `ads_management` (mutação), `business_management` (resolver assets).
- Criativos p/ visão: `image_url`/`thumbnail_url` confiável; vídeo `source` incerto → usar thumbnail.
- **Nosso App Meta** (dev mode) precisa ser selecionável no BM do cliente.

**WhatsApp (Evolution — não-oficial):**
- **1 instância por org**, conectada via QR pela org.
- Outbound proativo livre (sem janela 24h). Inbound via webhook (valida `EVOLUTION_WEBHOOK_SECRET`).
- **Fragilidade #1 aceita:** ToS-violating, risco de ban. Abstraído em `MessagingChannelPort` → trocar por Cloud API/pool depois sem reescrever.

---

## 10. Personalização (config)

- **Superfície única semeada por arquétipo** (NÃO wizard paralelo — evita "duas formas de fazer a mesma coisa"). Arquétipo preenche defaults bons → edita inline em linguagem de gente → **"opções avançadas" em divulgação progressiva** (mesma página, mesmo schema).
- **Playbook** editável como **linhas de linguagem natural com lacunas** ("pausar ad que custa mais de R$ __ por venda") → vira `PlaybookRule`. Técnico usa condições compostas no avançado.
- **Presets MVP:** Conservador (só sugere) + Otimizador de Performance. Refinados depois (não é foco agora).
- Config amigável para **não-técnico** é requisito: sempre haver caminho zero-config.

---

## 11. Metering & billing

- **Metering genérico:** `usage_events(type, payload_json, ...)` atrás de `MeteringPort` → novas dimensões sem migração.
- Captura: **custo real** do provider (OpenRouter retorna) + dims operacionais (runs, ações aplicadas, contas ativas).
- **Cobrança (futuro):** mensalidade + **markup** sobre as métricas escolhidas (ex: custo LLM × multiplicador). MVP = allowlist beta, sem Stripe.

---

## 12. Segurança & multi-tenancy

- **Credencial (token System User = joia da coroa):** envelope **AES-256-GCM**, `CREDENTIAL_MASTER_KEY` (secret EasyPanel), `keyVersion` p/ rotação. Nunca logar token.
- **Org scoping:** toda query filtrada por `org_id` (helper de contexto scoped p/ evitar vazamento cross-tenant).
- **RBAC:** owner/member org-wide no MVP, **extensível a granular** (ACL por conta = fast-follow).
- **Sessão:** iron-session + argon2 + cookie `SameSite`.
- **Webhook Evolution:** valida `EVOLUTION_WEBHOOK_SECRET`.
- **LGPD:** telefones + dados de anúncio; token cripto; base no Postgres self-host.

---

## 13. Convenções

### Princípios de engenharia (invariantes — as skills referenciam esta seção)
- **Sem string mágica / hardcoded:** valores em const/config/env com nome; sem número/URL/cor solta. Cor só via design token.
- **Modularidade + separação de interesses:** cada unidade um propósito; slice coeso; IO na casca, decisão no core.
- **Funções enxutas e legíveis:** função pequena, um nível de abstração, nome que explica. Função grande = sinal de que faz demais.
- **Desacoplamento:** depender de interface (porta), não de implementação. Core não importa infra.
- **Extensível / genérico:** nova plataforma/canal/provider = novo adapter atrás da porta, sem tocar no core.
- **Reuso-primeiro:** antes de escrever novo, procurar em `packages/{shared,core,db}` + adapters existentes. Duplicou 3x → extrai.

### Padrões
- **TDD (superpowers):** core funcional testado primeiro (sem mock); adapters com externos mockados; grafos com fixtures gravadas.
- **Erros:** exceções na **casca** (IO/adapters/HTTP, mapeadas p/ resposta) + resultados **tipados no core** (sucesso/erro explícito). Não usar exceção como control-flow no core.
- **Idempotência:** runs + tool_calls com `idempotency_key`.
- **Observabilidade:** log estruturado (**pino**) + trilha de auditoria (`agent_runs`/`steps`/`tool_calls`) + **Langfuse** (trace LLM).
- **Validação:** zod nas bordas. **Env:** schema zod validado no boot (`packages/config`).
- **Migrations:** Drizzle, só via `pnpm db:generate` (nunca editar SQL à mão).
- **Cross-cutting** (audit + metering em todo write): middleware/decorator na casca, nunca copiado por slice. Duplicação entre slices: regra **3x → extrai shared kernel**.
- **Naming:** slices por feature; portas em `packages/shared/ports`; core puro em `packages/core`.

---

## 14. Deploy (EasyPanel)

Serviços: **web** (Angular estático + nginx/Caddy), **api** (Node), **worker** (Node, mesmo repo/entrypoint diferente), **postgres**, **redis**. Evolution = instância existente. Domínios + SSL pelo EasyPanel. Backups Postgres agendados (mitiga SPOF do box único). Envs via secrets do painel.

---

## 15. Roadmap / fast-follows

Construção em **13 sub-fatias** (walking-skeleton-first) + estratégia de **paralelização em worktrees** → ver **[`docs/ROADMAP.md`](docs/ROADMAP.md)**. Marcos: `3a` valida a hipótese; beta read-only abre após `3b`; escrita só a partir de `5a`.

Fast-follows: ver §2 (OUT).

---

## 16. Comandos

```bash
pnpm install            # instala workspace
pnpm dev                # api + worker + web em paralelo
pnpm test               # vitest em todos os packages
pnpm typecheck          # tsc --noEmit por package
pnpm db:generate        # gera migration Drizzle a partir do schema
pnpm db:migrate         # aplica migrations
pnpm api:generate       # zod → OpenAPI → client Angular (kubb)
```

> Estrutura do monorepo em `docs/plan.md`. Este CLAUDE.md é a fonte da verdade das decisões — atualize-o quando uma decisão mudar.

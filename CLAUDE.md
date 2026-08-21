# CLAUDE.md — AutoTraffic (SaaS)

> Guia único de decisões de arquitetura, produto e regras de negócio. Toda decisão aqui foi batida criticamente. Antes de implementar qualquer coisa, leia a seção relevante. **Princípio-mestre:** desacoplado, genérico, extensível e configurável — trocar provider/canal/plataforma = adicionar um adapter, sem tocar no core.

---

## 1. Visão + ICP + proposta de valor

**Produto:** SaaS standalone onde **agentes de IA personalizáveis tocam tráfego pago de forma (semi)autônoma**. De tempos em tempos o agente analisa a conta Meta Ads (métricas + criativos), gera recomendações e — conforme configuração — aplica mudanças, atuando **principalmente via WhatsApp**.

**ICP (MVP):** players de saúde no digital (cursos/infoproduto) que fazem **lançamentos**. Já anunciam de verdade (conta Meta ativa = pré-requisito). Dores: (1) trabalho manual diário de tráfego; (2) ciclo de lançamento — intenso no lançamento, **conta parada** entre eles.

**Proposta de valor:** reduz o trabalho manual diário + vigia forte no lançamento (never miss timing) + não deixa a conta morrer entre lançamentos.

**Comprador:** ambos — o próprio player (org de 1-poucas contas) e gestores de tráfego que atendem players (org multi-conta).

**Fora do ICP (MVP):** PME que **não anuncia** — o MVP otimiza contas **ativas** (precisa de dado). Servir quem não anuncia depende de **criação de campanha**, que é capacidade de roadmap pós-MVP (ver §2 VISÃO).

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

**OUT (fast-follow):** OAuth oficial Meta + App Review; WhatsApp Cloud API / pool de números; Stripe (mensalidade + custo por uso); Google/TikTok Ads; modo lançamento×manutenção como preset; ACL por conta (RBAC granular); multi-agente por conta; **sinais externos do cliente (API/webhook) que enriquecem a análise** (ex: agendamentos do CRM — ver §15 / `docs/ROADMAP.md` Fatia 9); pacote `@automato/design-system` compartilhado.

**VISÃO (foco final, roadmap pós-MVP):** um **gestor de tráfego completo no WhatsApp** — o agente não só otimiza, mas **cria campanhas** (a pedido do usuário OU proativo, pelo que observou). MVP valida a otimização primeiro; **criação = fase de roadmap** (ver §15 e `docs/ROADMAP.md`). A arquitetura já antecipa (catálogo de tools + `AdsPlatformPort` extensíveis). Geração de criativo por IA = fase ainda mais tardia.

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
| Contrato API | **zod → OpenAPI → kubb (TYPES-ONLY)** consumido via `BaseApiService` (Angular HttpClient, `withCredentials`) | Tipos ponta-a-ponta sem drift; o client gerado seria dead-code (o stack usa HttpClient + interceptors) |
| Auth | Sessão **server-side** (tabela `sessions` token-opaco→hash, org ativa em `sessions.orgId`) + **@node-rs/argon2** | Revogável no DB; zero dependência externa; roda self-host |
| Hosting | **Hostinger + EasyPanel** | Self-host; casa com "banco próprio"; Evolution já roda lá |

Ver `docs/plan.md` para o histórico completo de trade-offs discutidos.

**Assincronismo por necessidade (não event-driven por padrão):** o sistema é request/response + **fila de jobs** (BullMQ, desde a espinha) + **cron por tenant** (cadência, 3b) + **webhook inbound + resume durável** (HITL, 5a/5b). Cada mecanismo entra quando uma necessidade concreta aparece (trabalho longo, agenda, push externo, aprovação de 24h), sempre **atrás de uma porta**. **Não há event bus interno / event sourcing / pub-sub entre slices** — e não se introduz até uma dor de escala real justificar; se justificar, entra atrás de porta (`SchedulerPort`/nova), sem tocar no core.

---

## 5. Portas & adapters (o core só conhece interfaces)

Portas ficam em `packages/shared/src/ports`. Regra: adicionar plataforma/canal/provider = **novo adapter**, zero mudança no core.

| Porta | Contrato (resumo) | Adapter MVP |
|---|---|---|
| `AdsPlatformPort` | `listEntities`, `getInsights` (async), `getCreatives`, `mutate` — *(roadmap: `createCampaign/AdSet/Ad`, `uploadCreativeAsset`→image_hash/video_id, `listPages`)* | `@trafego/ads-meta` (Graph v26) |
| `MessagingChannelPort` | `sendMessage`, `onInbound`, `instanceLifecycle` | `@trafego/channel-evolution` |
| `LLMProviderPort` | `complete` (texto+multimodal) → `{ output, usage, cost }` | `@trafego/llm-openrouter` |
| `CredentialVaultPort` | `encrypt`/`decrypt` (AES-256-GCM, keyVersion) | local |
| `SchedulerPort` | cron/jobs por tenant | BullMQ |
| `MeteringPort` | registra `usage_events` (genérico `type`+`payload`) | Postgres |
| `ApprovalPort` | `upsertPending`/`resolve`/`listPending*`/`getById`/`expireOverdue` (HITL granular, 1 linha/ação) | `@trafego/approval-postgres` |
| `StoragePort` *(roadmap)* | `put`/`get`/`signedUrl` de assets de criativo | S3-compat |
| `ExternalSignalsPort` *(roadmap)* | ingestão de sinais do cliente (API/webhook, idempotente) que enriquecem a análise | Postgres (`external_signals` genérico) |

*(Roadmap — criação de campanhas)* nova porta `StoragePort` (assets) + `AdsPlatformPort` ganha família `create*` + `uploadCreativeAsset`; tudo atrás das portas, sem tocar no core.

*(Roadmap — sinais externos, Fatia 9)* nova porta `ExternalSignalsPort` (ingestão por API/webhook) + `external_signals`/`signal_definitions` genéricos; o dado do cliente vira contexto curado no `AccountBrief` (pode virar `ConversionGoal` de origem externa). Ver `docs/ROADMAP.md`.

Composition root **manual** (`apps/api/src/composition.ts`, `apps/worker/src/composition.ts`) — sem DI container.

---

## 6. Data model (Postgres, tudo `org_id`-scoped)

Schema em `packages/db/src/schema`. Grupos:

- **Tenancy/auth:** `orgs`, `users`, `memberships(role: owner|member)`, `sessions(tokenHash, ip/ua, lastUsedAt, expiresAt, revokedAt)`, `access_grants(email, status: pending|active|revoked)` — gate de acesso keyed por email; nome durável pós-beta.
- **Integrações:** `platform_connections(platform, external_business_id, token_cripto, token_status, last_validated_at, last_synced_at)` — **conexão com sistema externo (Meta), dona do token** (recolar 1x recupera todas as contas dela; genérico p/ Google/TikTok); `ad_accounts(connection_id→platform_connections, meta_business_id, ad_account_id, status: active|unavailable|removed, ...)` — conta sob gestão, `status` = lifecycle **soft** (nunca deletar: cascata apagaria agente + histórico); `channel_instances(evolution_instance, phone, status, webhook_secret)` (canal WhatsApp da org — integração de mensagem, entidade à parte da de ads); `contacts(phone, verified, user_id, role)`. *(legado: `ad_accounts.token_cripto/token_status` migram p/ a conexão via backfill idempotente — drop da coluna = fast-follow.)*
- **Agente:** `agents(ad_account_id, archetype, persona, system_prompt, goals, cadence, autonomy_policy, tone, model_config, status)`, `agent_tool_definitions` (catálogo-DB: key, riskLevel, isIdempotent, schema, requiredPermission, requiredEntitlement), `agent_tool_bindings(agent_id, tool_key, mode)`, `guardrail_configs(max_budget_change_pct, max_entities_per_day, allowed_actions, dry_run, kill_switch, llm_cost_cap)`, `playbook_rules(scope, when_json, then_json, enabled, priority)`, `agent_memory(type, content, confidence, lifecycle)`, `agent_muted_entities(agent_id, entity_level, external_id)` — entidades silenciadas pelo usuário (opt-out da análise; genérico level+id, hoje só campanha).
- **Dados Meta:** `insights_snapshots(ad_account_id, entity_level, entity_id, date, metrics_json)` — série temporal (retenção ~90d por env).
- **Execução:** `agent_runs(trigger, status, config_snapshot, token_usage, cost_snapshot, trace_id)`, `agent_run_steps`, `agent_tool_calls(idempotency_key, risk, args, result, before_state)`, `approvals(status, payload_actions, run_id, contact_id, expires_at)`, `recommendations(title, rationale, proposed_action, status)`, `recommendation_feedback(vote, status, outcome)`.
- **Conversa:** `conversations`, `messages(direction, body, meta)`.
- **Metering:** `usage_events(type, payload_json, provider, model, input_tokens, output_tokens, cost, ad_account_id)` — `ad_account_id` (6c) atribui custo direto à conta (chat = conta em foco; runs via backfill/join).
- **Audit:** `audit_log(actor, action, target, before, after)`.
- **Criação de campanhas (roadmap):** `creative_assets` (biblioteca: origin `reuse|upload`, storage_ref, meta_image_hash/video_id, status), `campaign_drafts` (estrutura proposta: objetivo/budget/targeting/placement + criativos + copy + status `proposed|approved|created`), `ad_pages` (Page do cliente p/ `object_story_spec`). Aprovação de draft = `approvals` com payload de rascunho.

**Reprodutibilidade:** `agent_runs.config_snapshot` congela a config no momento do run.

---

## 7. Agente (grafos + híbrido + curadoria)

**Runtime:** LangGraph **Graph API (`StateGraph`)** com checkpointer Postgres. LangChain (`@langchain/core` + `@langchain/openai` via OpenRouter) fornece modelos/tools por baixo. Graph API (não Functional) por controle explícito de nós/edges e aderência ao padrão Automato.

**Dois grafos (LangGraph):**
- **`account-analysis` (pipeline determinístico)** — cron/on-demand: `load_context → fetch_data → run_playbook → llm_analyze(+visão) → review_analysis → build_recommendations → decide_actions → guardrail_check → apply_actions(snapshot) → create_approvals → notify → record`. LLM só em `llm_analyze`, `review_analysis` e `notify`. **Grafo linear, sem checkpointer:** `needApproval` não pausa o run — vira linha `approvals` pendente (`create_approvals`); ao aprovar no site, um **apply-service** (worker) relê o estado FRESCO + re-roda o guardrail + escreve (5b corte 1). O checkpointer/`interrupt` fica pro `whatsapp-conversation` (5c).
- **`whatsapp-conversation` (ReAct + tools, 5b corte 2)** — chat pelo WhatsApp com **checkpointer Postgres** (thread por conversa). Entregue: **leitura** (tools sobre nosso DB curado — status/métricas/campanha/recomendações/pendentes), **"analisa agora"** (dispara run `trigger=conversation` + push do resultado de volta) e **aprovação conversacional** (approve/reject por id; referência inequívoca aplica direto — o nudge foi o eco; ambíguo → pergunta §8; apply-service re-checa fresco e empurra o desfecho). Inbound com **debounce** (coalesce picadas) e **voz = agente em contexto** (concierge neutro se a org tem N contas). **Escrita LIVRE do zero** ("pausa a campanha X" sem pendente) = **5c**.

**Qualidade da análise = Analista→Revisor + guards determinísticos (3a-2):** o `llm_analyze` (analista) é seguido de `review_analysis` — **pré-check determinístico** (findings sem `metricRefs` / número citado ausente do brief) → **`reviewPasses`** (lista de revisores; default 1; refina/corta, **nunca inventa**) → **drop determinístico final** + `actionType→riskLevel`. Revisor falhou → cai pra saída do analista + nota parcial (§7 degradação graciosa). A **lista de passes** é a costura p/ **Fatia 8** (painéis de revisores, map-reduce por entidade, redator, validador de ação) — crescer = registrar mais passes, sem reescrever o grafo. Config do pipeline (`model`/`reviewEnabled`/`topN`/`maxOutputTokens`) é **por-agente** (`agents.model_config`, fallback env); a UI de edição = Fatia 4.

**Camada de qualidade determinística (6c, `packages/core`):** sobre o dado curado, pura e testável — **benchmarks** de cold-start (referência de plataforma só quando sem meta E sem histórico, rotulada, nunca declara sucesso), **tiers** relativos (winner/performer/underperformer/**zombie**), **sinais de saúde** (fadiga/saturação/baixo-volume) e **elegibilidade** (significância = conversões de negócio OU cliques + baseline; learning = entidade nova). Alimenta prompt (árvore de diagnóstico por padrão de métrica) + UI (tag de tier em PT) + o **guard de significância** (`guardScaleWithoutSignificance` no `review_analysis`, **antes** de `decide_actions` → vale no caminho autônomo): rebaixa escalar/reativar sem base → `investigate`. Comparador nº1 é sempre a **meta do dono**; nº2/3 histórico/relativo da conta; benchmark é nº4.

**Origem das ações = híbrido, autonomia por origem:** `playbook` (regras puras) gera ações-base + `LLM` propõe ações adicionais (structured output, mesmo tipo `Action`). Merge → dedupe → **guardrail** → autonomia decidida **por origem** (ex: auto-aplica playbook, pede OK no LLM — configurável). Guardrail é rede sobre os dois.

**Curadoria — `AccountBrief` (pilar):** camada **determinística pura** (`packages/core/src/brief`) entre Meta e LLM. O LLM nunca vê o firehose. Pipeline: `normalize → computeDerived → computeTrends → detectAnomalies → rankAndSelect(top-N + flagados) → summarizeRest → selectCreatives(só flagados) → assembleBrief`. Resolve degradação da análise **e** custo de visão (`ANALYSIS_MAX_CREATIVES_VISION`).

**Mapa por CAMPANHA (não por-anúncio):** o `map_units` roda **1 call de LLM por campanha ativa** (`buildCampaignUnits` → `CampaignUnit` = árvore curada: adsets ativos + anúncios notáveis `ANALYSIS_NOTABLE_ADS_PER_CAMPAIGN` + cauda agregada por adset; visão com teto `ANALYSIS_MAX_CREATIVES_VISION_PER_CAMPAIGN`). Cobertura ≠ profundidade: todas as ativas no escopo, mas só as **top-N + flagadas + materialmente mudadas** (`selectCampaignsToAnalyze` = `rankAndSelect` ∘ `selectUnitsToAnalyze`, cap `ANALYSIS_TOP_N` re-nivelado a campanha) recebem a call profunda; o resto entra resumido no brief. Sobe a altitude (o gestor age por campanha) e corta as chamadas de ~N_anúncios pra ~N_campanhas. Recomendação ainda pode mirar `campaign|adset|ad` (`targetEntity`). O usuário pode **silenciar** campanhas (`agent_muted_entities`, opt-out). `entity_analyses` chaveada por id de campanha (`entity_level`/`entity_name` congelam nível/rótulo p/ o recorte por campanha no site).

**Conversão (CPA/ROAS) = conversão de NEGÓCIO do agente vence o objetivo da entidade (genérico):** por padrão CPA/ROAS derivam da conversão que **a entidade otimiza**; quando o agente define uma **conversão de negócio** (`AgentGoals.conversionGoal`, ex: venda), ela **vence** via `resolveConversion` (plumbado no brief). Honestidade determinística do descasamento (`conversionBasis` por entidade): `target` = a CPA medida É a de negócio (compara com a meta); `proxy` = a de negócio não é mensurável ali (a entidade otimiza outra coisa) → mostra o custo do objetivo da entidade **rotulado como referência**, **nunca** declara meta batida, e usa o funil como qualidade; `none` = sem conversão → CPC/CPM. O `metaFlags` só aplica meta em `target`. Custo-por-negócio também no nível da conta quando mensurável. O vocabulário/mapeamento específico da plataforma (Meta `action_type`/`optimization_goal`/conversões personalizadas) vive **só no adapter**; o core e o `shared` falam uma taxonomia neutra (`ConversionGoal`, tupla `CONVERSION_GOALS` = fonte única do tipo + zod) — adicionar Google/TikTok = novo adapter mapeando pro mesmo enum, **sem tocar no core**. Nomes legíveis de conversão personalizada = tabela genérica `conversion_labels` (worker resolve no run; API/config lê do banco, sem chamar a plataforma).

**Governor de rate-limit:** token-bucket por `ad_account` (Redis, lê `X-Business-Use-Case-Usage`), Batch API (≤50/HTTP), async report jobs, `insights_snapshots` (não re-baixa histórico), sync incremental, jitter/stagger nos crons, **degradação graciosa** (roda com cache/parcial + nota "análise parcial").

**Functional core:** `playbook`, `guardrails`, `decision` (seleção de ação) e `brief` são **funções puras** em `packages/core` — testadas sem mock. Nós do grafo são finos (só IO + chamam o core).

---

## 8. Regras de negócio

- **Autonomia:** slider (só avisa → sugere+OK → age no seguro → age sozinho). **Auto-aplicar liberável no dia 1** por config. **Por origem** (playbook × LLM).
- **Guardrails (sempre, mesmo autônomo):** blast radius (% máx budget/mudança, nº máx entidades/dia), budget cap, kill-switch, dry-run. **Defaults conservadores** — no caminho autônomo NÃO há eco+confirma, então guardrail é a única rede.
- **Aprovação conversacional:** sem códigos. Agente lista o que achou em linguagem natural; resposta livre → Grafo B mapeia fala→ações. **Antes de QUALQUER escrita: eco concreto do que vai fazer + espera confirmação.** Ambiguidade = pergunta; nunca aplica em interpretação incerta.
- **Escrita pedida no chat:** sempre confirma + guardrail (ignora nível de autonomia — chat é ambíguo demais p/ auto-aplicar).
- **Aprovação via site (5b corte 1):** aprovar/rejeitar por ação (mini-surface + `/approvals` cross-conta); a fonte da verdade das pendentes é a tabela `approvals` (granular, upsert por agente+entidade+tipo). Aprovar = re-check fresco no apply (barrado → `blocked` + motivo).
- **Aprovação via WhatsApp (5b corte 2):** o contato verificado aprova/rejeita conversando (approve/reject por id de `list_pending`); referência inequívoca aplica direto (o nudge/análise foi o eco), ambíguo → o agente pergunta (§8); o apply-service re-checa fresco e **empurra o desfecho** na conversa. Mesmo apply-service da via site.
- **Expiração de aprovação:** 24h sem resposta → expira (job recorrente `approval-expiry`), some da lista (repropor no próximo run = fast-follow).
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
- **Onboarding é token-only:** valida + lista com o token colado (`GET /me/adaccounts`) — **sem `META_APP_ID`/`META_APP_SECRET`** no fluxo (a fuga é de OAuth/App Review, não de ter app; o System User token já é atrelado ao nosso app). **Fast-follow:** checagem proativa de escopos (`/debug_token`) + `appsecret_proof` — reintroduzem o app id/secret; até lá, falta de escopo aparece de forma reativa (403 na 1ª ação que precisar).
- Criativos p/ visão: imagem = `image_url`; **vídeo = frames HD** via `/{video_id}?fields=thumbnails` (1080p, N frames espaçados — não o selo 64px do `thumbnail_url`); `source` do vídeo indisponível com o token (→ transcrição = fast-follow Fatia 7). Cache de visão chaveado por **id estável do criativo** (não a URL do fbcdn, que rotaciona).
- **Nosso App Meta** (dev mode) precisa ser selecionável no BM do cliente.

**WhatsApp (Evolution — não-oficial):**
- **1 instância por org**, conectada via QR pela org.
- Outbound proativo livre (sem janela 24h). **Inbound (5b-2):** o `connect` registra o webhook na Evolution (`webhook/set`, eventos `MESSAGES_UPSERT`/`CONNECTION_UPDATE`, header do secret **por-instância** `channel_instances.webhook_secret`); a casca valida o secret da instância e enfileira o payload **cru**; o worker normaliza (`parseInbound`), resolve o contato **verificado** (desconhecido → silêncio), dedupa por `messageId`, faz **debounce** (coalesce picadas) e roda o Grafo B. `CONNECTION_UPDATE` → status do canal ao vivo.
- **Fragilidade #1 aceita:** ToS-violating, risco de ban. Abstraído em `MessagingChannelPort` → trocar por Cloud API/pool depois sem reescrever.

---

## 10. Personalização (config)

- **Superfície única semeada por arquétipo** (NÃO wizard paralelo — evita "duas formas de fazer a mesma coisa"). Arquétipo preenche defaults bons → edita inline em linguagem de gente → **"opções avançadas" em divulgação progressiva** (mesma página, mesmo schema). Vive em rota dedicada `/accounts/:id/agente` (superfície "Agente" seccionada; vira aba-filha quando o detalhe ganhar router-tabs).
- **Personalização por texto (Fatia 4 corte 1):** dois campos **aditivos** sobre o arquétipo (nunca o substituem) — **contexto do negócio** (fatos → bloco factual no prompt) e **orientações ao agente** (comportamento → bloco de prioridades), compostos via `composeAgentPrompt`. Fronteira: orientação influencia **análise/recomendação**, **nunca** o gating determinístico de guardrail/autonomia (relevante quando a escrita chegar, 5a). Documentos como contexto = fast-follow.
- **Playbook** editável como **linhas de linguagem natural com lacunas** ("pausar ad que custa mais de R$ __ por venda") → vira `PlaybookRule`. Técnico usa condições compostas no avançado.
- **Presets (6c):** Conservador (só sugere) + Otimizador de Performance (age no seguro no playbook) + Guardião de Lançamento (sugere+OK, cadência 2×/dia). Cada um com `label`/`description`/`whenToUse` (catálogo `archetypeCatalog`, servido à UI). Limiares de qualidade (significância/fadiga/learning/frames/cold-start) editáveis em "Opções avançadas" (override de `agents.model_config`).
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
- **Sessão server-side:** tabela `sessions` (cookie leva **token opaco**; DB guarda só o `tokenHash` sha256 — revogável, expiração **deslizante** throttlada, trilha `ip/ua`). A **org ativa mora em `sessions.orgId`** (não em cookie) — troca de org = UPDATE na linha (org-switcher = fast-follow). Cookie `httpOnly` + `SameSite=lax` + `secure` em prod. Senha do usuário: **`@node-rs/argon2`** (prebuilt, sem node-gyp). Login/signup com rate-limit (`@fastify/rate-limit`, Redis) + `trustProxy` (IP real atrás do EasyPanel).
- **Webhook Evolution:** valida o secret **por-instância** (`channel_instances.webhook_secret`, rotacionável; identifica a org pelo nome da instância no path).
- **LGPD:** telefones + dados de anúncio; token cripto; base no Postgres self-host.

---

## 13. Convenções

### Princípios de engenharia (invariantes — as skills referenciam esta seção)
- **Sem string mágica / hardcoded:** valores em const/config/env com nome; sem número/URL/cor solta. Cor só via design token.
- **Modularidade + separação de interesses:** cada unidade um propósito; slice coeso; IO na casca, decisão no core.
- **Funções enxutas e legíveis:** função pequena, um nível de abstração, nome que explica. Função grande = sinal de que faz demais.
- **Desacoplamento:** depender de interface (porta), não de implementação. Core não importa infra.
- **Nomenclatura no nível certo de abstração** (faz parte do desacoplamento): nome descreve o **quê/porquê** do conceito, nunca o **como/quando** temporário — não vaza fase (ex: `beta`), provider (ex: `meta`/`evolution` num conceito genérico), nem detalhe de implementação. Teste: trocar a impl ou sair da fase **não** deve obrigar a renomear o conceito. Ex: `access_grants.status` (durável) e não `beta_access` (some no fim do beta).
- **Extensível / genérico:** nova plataforma/canal/provider = novo adapter atrás da porta, sem tocar no core.
- **Reuso-primeiro:** antes de escrever novo, procurar em `packages/{shared,core,db}` + adapters existentes. Duplicou 3x → extrai.

### Princípios de UX (invariantes — design completo em `docs/DESIGN.md`)
- **Erros sempre tratados e amigáveis:** nunca vazar exceção/stack/código técnico pro usuário; toda falha vira mensagem clara.
- **Erro = o que aconteceu + o que fazer:** 1 frase, sem "Error:", sem culpa técnica.
- **Não-técnico:** sem jargão; traduzir termos (CPA, adset, token) quando aparecerem.
- **Sempre mostrar o que está acontecendo:** estados loading/progresso/vazio/sucesso claros; usuário nunca no escuro.
- **Sempre o próximo passo:** empty states e confirmações apontam a ação.
- **Voz:** sentence case; status = **tom+texto** (nunca só cor); "arquivo enviado" (não "enviado com sucesso!").
- Linguagem visual + IA + telas = **`docs/DESIGN.md`** (Operational Glass Desk, Rare Accent, No Generic AI).

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

**Topologia MVP (decidida):** **api** e **worker** = serviços **separados** (mesmo repo/entrypoint diferente) — worker NÃO no processo da api: análise pesada (LLM/visão/async Meta) trava o event loop e acopla crash; separar é quase grátis (mesmo build, start diferente). **web servido pela própria api** no MVP (Fastify `@fastify/static` + fallback SPA): 1 serviço a menos, **mesma origem = zero CORS**, SSL/domínio único. Serviços: **api (+web estático)**, **worker**, **postgres**, **redis**. Evolution = instância existente. Domínios + SSL pelo EasyPanel. Backups Postgres agendados (mitiga SPOF do box único). Envs via secrets do painel.

**Fast-follow:** web em serviço estático dedicado (nginx/Caddy) quando o tráfego justificar — troca reversível, não toca no core.

---

## 15. Roadmap / fast-follows

Construção em **13 sub-fatias** (walking-skeleton-first) + estratégia de **paralelização em worktrees** → ver **[`docs/ROADMAP.md`](docs/ROADMAP.md)**. Marcos: `3a` valida a hipótese; beta read-only abre após `3b`; escrita só a partir de `5a`. **Criação de campanhas = Fatia 7 (pós-MVP)** — o gestor completo no WhatsApp; **orquestração multi-agente / qualidade = Fatia 8 (pós-MVP)** — painéis de revisores, map-reduce por entidade, redator, validador de ação (a costura `reviewPasses` já nasce na 3a-2) — ver `docs/ROADMAP.md`.

Fast-follows / decisões adiadas: consolidadas em **[`docs/ROADMAP.md`](docs/ROADMAP.md) → "Pós-MVP — fast-follows e decisões adiadas"** (a §2 OUT é o recorte de produto; o ROADMAP é a lista viva).

---

## 16. Comandos

```bash
pnpm install            # instala workspace
pnpm dev                # api + worker + web em paralelo
pnpm test               # vitest em todos os packages
pnpm typecheck          # tsc --noEmit por package
pnpm db:generate        # gera migration Drizzle a partir do schema
pnpm db:migrate         # aplica migrations
pnpm api:generate       # zod → OpenAPI → tipos Angular (kubb types-only)
```

> Estrutura do monorepo em `docs/plan.md`. Este CLAUDE.md é a fonte da verdade das decisões — atualize-o quando uma decisão mudar.

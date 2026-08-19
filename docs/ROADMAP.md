# ROADMAP — Construção do Agente de Tráfego

Plano de construção em fatias. Decisões de arquitetura/produto = [`../CLAUDE.md`](../CLAUDE.md). Design/UX (IA, telas, componentes) = [`DESIGN.md`](DESIGN.md). Histórico completo = [`plan.md`](plan.md).

## Estratégia

**Walking-skeleton-first:** o cut mais fino e2e primeiro (prova integração + deploy), depois aprofunda. **Deploy no EasyPanel desde a Fatia 0.** Cada (sub)fatia é independentemente demonstrável/testável e **vira um `planning-trafego-feature` próprio** antes de implementar.

**Sequência (13 sub-fatias):**

```
0 → 1a 1b → 2a 2b → [3a] 3b → 4 → 5a 5b 5c → 6a 6b
```

- **`3a` = validação da hipótese** (recomendação boa no WhatsApp, sem escrita).
- **Após `3b` = largada do beta read-only** (usuários reais, risco zero de budget) — roda **em paralelo** às fatias 4→6.
- Escrita na Meta só a partir de **`5a`** (atrás de guardrail); aprovação humana em **`5b`**; chat aberto ReAct (end-state) em **`5c`**.

## Fatias

| # | Fatia | Entrega / Valida | Depende |
|---|---|---|---|
| **0** | Espinha ambulante (+deploy) | Colo token → 1 métrica → 1 msg WhatsApp; api+worker+pg+redis no EasyPanel | — |
| **1a** | Plataforma (auth/tenancy/shell) | Self-signup→login→org; vault AES-GCM; contrato kubb; web sobe | 0 |
| **1b** | Onboarding real | Form: colar token→validar(190)→listar contas→escolher | 1a |
| **2a** | Meta read + governor | Entidades + insights async + criativos; governor mín; snapshots+incremental; conversão normalizada (genérica) | 1b |
| **2b** | AccountBrief (core puro) | Curadoria pura: totals+rank/select top-N+agregados+tendência; CPA/ROAS por objetivo | 2a |
| **3a** | 🎯 Loop de análise | brief→playbook+LLM(texto)→recommendations→WhatsApp; on-demand por botão web | 2b |
| **3b** | Cadência + visão + medição | Cron/conta; visão de criativo; feedback 👍/👎; metering+cap. 🚩 **beta read-only** | 3a |
| **4** | Config do agente | Superfície única por arquétipo; playbook natural; guardrail/autonomy config | 3 |
| **5a** | Escrita + guardrails | Guardrail engine + decide (core); tools escrita idempotentes+rollback; catálogo tools | 4,3,2a |
| **5b** | HITL aprovação | Inbound; aprovação conversacional eco+confirma; interrupt/resume durável; expira 24h | 5a |
| **5c** | Chat ReAct pleno (end-state) | Conversa livre age via tools (núcleo) dentro dos guardrails | 5b |
| **6a** | Timeline / auditoria (UI) | Histórico de runs/ações/aprovações na dashboard | prévias |
| **6b** | Endurecimento / ops | Throttle, token-190, degradação, backups; allowlist via script/DB | prévias |
| **7** | Criação de campanhas (pós-MVP) | Gestor completo no WhatsApp: cria campanhas a pedido/proativo | MVP validado, 5a/5b |
| **8** | Orquestração multi-agente / qualidade (pós-MVP) | Painéis de revisores, map-reduce por entidade, redator, validador de ação | MVP validado, 5a |

**Marcos:** `3a` valida a hipótese; **beta read-only abre após `3b`** e roda em paralelo; escrita só a partir de `5a`, sempre atrás de guardrail; "mexer em qualquer coisa" (`5c`) = tools do catálogo (núcleo no MVP: pausar/budget/status; amplia por extensão; **criar campanha = Fatia 7** (pós-MVP, ver abaixo)); **mais papéis de agente / map-reduce = Fatia 8** (pós-MVP; a costura `reviewPasses` já nasce na 3a-2).

## Paralelização — dois tracks (git worktrees)

**Pré-requisitos:** repo já **fora do OneDrive** + **git** inicializado. (pnpm store global content-addressable → worktrees compartilham o store.)

**Modelo:** dois tracks fixos em worktrees/branches, sincronizando no **contrato kubb**:
- **Track A — Backend/Infra:** `apps/api`, `apps/worker`, `packages/*`, deploy.
- **Track B — Frontend:** `apps/web` (consome o client kubb gerado).

**Regras de ouro:**
1. **Solo primeiro:** `0` e `1a` numa sessão só (montam espinha + contratos). Forkar depois.
2. **Contract-first por fatia:** travar o schema zod na base antes de forkar as 2 sessões.
3. **Serializar a espinha compartilhada:** `packages/shared`, `packages/db/schema`+migrations, composition roots, `.env.example` = um dono por vez (Track A, commit-base antes do fork).
4. **Merge por branch/PR** + rodar `reviewing-trafego-changes` antes de integrar.

**Pares naturais:** `1b` ∥ `2a` · Fatia `4` API(A) ∥ tela(B) · `5a`/`5b`(A) ∥ `6a`(B) · `6a` ∥ `6b`.

## Fluxo por fatia

1. `planning-trafego-feature` (plano específico da fatia) → aprovação.
2. `implementing-trafego-feature` (TDD; subagente por slice; Track A/B se paralelo).
3. `reviewing-trafego-changes` (veredito bloqueia/passa) → merge.

## Pós-MVP — fast-follows e decisões adiadas

Consolidação de tudo que **decidimos adiar** para depois do MVP. (Deferrals que já têm
fatia MVP agendada **não** entram aqui — ficam na sua fatia: retenção/prune → `6b`;
`selectCreatives` + visão de criativo → `3b`; override de conversão por agente → `4`;
decaimento de token em runtime → `6b`; reuso do sync-service pelo `fetchData` → `3a`;
**métricas de funil/engajamento na análise** → `3a` (ver nota abaixo).)

> **Nota (Fatia 3a) — métricas de funil/engajamento.** A 2a normaliza como **conversão**
> só o objetivo real da entidade (limpo, p/ CPA/ROAS não inflar). Mas a Meta reporta
> muitos sinais **secundários** que NÃO são conversão e hoje ficam só no `rawActions`
> (preservados, não surfaçados): funil de messaging (`conversation_started → first_reply
> → user_depth_2/3/5 → replied`), engajamento (`post_net_like`, `post_net_comment`), etc.
> Na 3a, introduzir uma **categoria secundária "métricas de funil"** (distinta de
> conversão) que o brief expõe ao agente como **contexto** — o **funil de messaging é
> prioridade do ICP** (mede *qualidade* do lead, não só quantidade: 100 conversas com 4
> indo fundo × 30 conversas com 15 indo fundo). Dado já coletado → dá p/ derivar sem
> re-sync.

**Plataforma / integrações**
- **Integrações como entidade real (`platform_connections`)** — feito: conexão dona do token, `ad_accounts` referenciam, lifecycle soft (`active|unavailable|removed`), reconciliador puro (`reconcileSync`/`reconcileSelect`), conectar+multi-selecionar+sincronizar em Integrações; Contas só reflete; WhatsApp virou integração (sem aba). Fast-follows abaixo.
  - **Drop de `ad_accounts.token_cripto`/`token_status`** — hoje a conexão é a fonte da verdade; a coluna legada segue por dup transitória até o backfill ser confirmado em produção. Aí: migration de drop + remover fallbacks.
  - **Unique `(org_id, external_business_id)` em `platform_connections` + `onConflictDoUpdate` no create** — hoje o dedupe de recolar-token é app-level (find-then-update), seguro em request serial mas com TOCTOU sob duplo-clique/duas abas (pode criar 2 conexões pro mesmo BM). Fix de hardening: constraint no DB (arbitra) — **pré-requisito:** backfill agrupar por `(org, businessId)` (hoje é 1 conexão por conta; contas do mesmo BM gerariam linhas que a unique rejeitaria) + dedupe de dados existentes. Fazer os dois juntos antes do 1º deploy que rode o backfill em prod.
  - **Auto-descoberta de contas** (hoje só "sincronizar" manual) — pendurar um refresh de catálogo na cadência de `insights-sync` da conexão (sem job novo, quase de graça). Token morto já é detectado pela cadência.
  - **Remover/desabilitar conexão** (soft, com confirmação) — hoje só há conectar/gerir/sincronizar; deletar conexão nunca deve cascatear delete de conta (FK `restrict`).
  - **Remover onboarding antigo (dead code)** — connect-dialog/connector-strategy + `/api/accounts/connect|select` ficaram mortos após o slice `connections`; retirar (+ avaliar aposentar o slice `admin`). *(admin já aposentado; falta o connect-dialog/endpoints — feito parcialmente.)*
  - **N números de WhatsApp por org (destravar o canal)** — hoje o schema `channel_instances` **tolera** N (índice em `org_id`, sem unique; `evolution_instance`+`phone` por linha), mas o código assume 1: `instanceName(orgId) = org-${orgId}` + queries `limit(1)` (§9 MVP = 1 número/org). Ir pra N = mudança contida no adapter/serviço de canal (nome de instância próprio por número, tirar o `limit 1`, conceito de "qual número", `unique` em `evolution_instance`) — **sem re-arquitetura**. Aí o card WhatsApp fica re-conectável em "Disponíveis" (simétrico ao Meta); a UI já tem a costura (`availableProviders`). Casa com o pool de números / Cloud API.
- OAuth oficial Meta + App Review (sai do System User token colado).
- Checagem proativa de escopos (`/debug_token`) + `appsecret_proof` — reintroduz `META_APP_ID`/`META_APP_SECRET` (removidos no onboarding token-only da 1b).
- WhatsApp **Cloud API** / pool de números (sai do Evolution não-oficial).
- Google / TikTok Ads = **novo adapter** atrás de `AdsPlatformPort` (core intocado).

**Billing**
- Stripe: mensalidade + custo por uso (markup sobre `usage_events`).

**Governor / escala (Fatia 2)**
- Token-bucket Lua (EVALSHA) no `acquire` (controle proativo) + Batch API (≤50/HTTP) — quando o volume exigir (hoje = mínimo-correto reativo).
- **Backoff + retry no rate-limit da Meta (code 17 "User request limit reached")** no `MetaGraphClient` — hoje o erro só degrada o nível pra `partial` (visto em validação: rodar várias análises seguidas numa conta grande estoura o orçamento de request e `listEntities(adset/ad)` cai). Retry com espera respeitando `X-Business-Use-Case-Usage` antes de degradar. Casa com o token-bucket acima.
- **Aliviar o `fetch_data`** (o mais pesado por run numa conta grande: lista os 3 níveis, `ad` = centenas paginado, todo run) — listar só entidades **ativas** e/ou cachear o catálogo de entidades entre runs (invalidar por sync). Reduz a pressão de rate-limit na raiz.
- Tuning do `CUSTOM_CONVERSIONS_CACHE_TTL_SEC` conforme a cadência de cron real.

**Dados / análise (Fatia 2)**
- **Mapa por campanha (feito)** — `map_units` roda 1 call/campanha ativa (`CampaignUnit` = árvore curada); seleção `selectCampaignsToAnalyze` (top-N `ANALYSIS_TOP_N` + flagadas + incremental); silenciar via `agent_muted_entities`; recorte por campanha no detalhe da conta. Fast-follows:
  - **Cap de nº de campanhas profundas** vira problema só com muitas ativas — hoje `ANALYSIS_TOP_N` (=10) cobre + flagadas sempre entram; revisar se surgir conta com dezenas de ativas simultâneas.
  - **Limpeza das linhas legado nível-anúncio em `entity_analyses`** — pós-migração, ids de anúncio ficam órfãos (nunca mais casados; `entity_level='ad'`); um prune pontual por agente no 1º run novo evita lixo acumulado.
  - **Silenciar adset/ad** — `agent_muted_entities` já é genérico (level+id); expor na UI quando fizer sentido.
  - **Router-tabs do detalhe da conta** (Visão geral | Agente | Timeline | Conexões, `docs/DESIGN.md`) — hoje o detalhe da conta é plano (resultado + cartões por campanha + controles do agente) e a config vive em **rota irmã dedicada** (`/accounts/:id/agente`, superfície "Agente" seccionada); vira aba-filha quando a Timeline (6a) e Conexões pedirem — a rota migra sem retrabalho.
- Tabela `ad_entities` (histórico de nome/status/budget) — quando a UI (3/4) pedir timeline; hoje entidades são transientes.
- Backfill histórico sob demanda (range explícito, isento da retenção) — analisar lançamento antigo.
- Score composto no `rankAndSelect` (gasto + delta vs baseline + severidade da flag).
- `currency_offset` exato no budget (moedas sem decimais; hoje ÷100, correto p/ BRL/USD).
- Revisar o cap AEM (8 eventos/domínio) se a análise passar a depender de eventos priorizados.
- Expandir o `meta-conversion-map` conforme novas contas reais surgirem (o whitelist só conta conversões reconhecidas; `rawActions` guarda o cru como rede de segurança p/ re-derivar).

**Produto / config**
- **Objetivo de negócio × otimização da plataforma — feito (Fatia 4, corte 1).** O bug de validação (agente com meta de **venda** R$150 numa conta que otimiza **conversas** dizia *"custo por conversa excelente (R$2,19 vs meta R$150)"*) foi corrigido: **conversão de negócio por-agente** (`AgentGoals.conversionGoal`, plumbada no brief via `resolveConversion`), **basis determinístico** por entidade (`conversionBasis: target|proxy|none`) — em `proxy` mostra o custo do objetivo da entidade **rotulado** e nunca declara meta batida —, **CPA-da-conta quando mensurável**, e **personalização por texto** (contexto do negócio + orientações, camada aditiva no prompt via `composeAgentPrompt`). Costuras novas: tabela genérica `conversion_labels` (worker resolve nome de conversão personalizada no run; API lê do banco, sem chamar a plataforma) + `agents.config_changed_at` (salvar config força 1 deep no próximo run, pois a herança incremental só olha métricas/flags). **Resto da Fatia 4 (logo em sequência):** slider de autonomia, UI de guardrails, editor de playbook em linguagem natural, persona/tone/system-prompt-override, cadência/model-config — tudo na MESMA superfície "Agente" (`/accounts/:id/agente`).
- **Documentos como contexto do agente (upload/RAG)** — o dono anexa material (PDF/planilha/brief) que enriquece a análise; storage + extração + recuperação atrás de porta. Fast-follow da personalização (estende os campos de texto do corte 1).
- Modo **lançamento × manutenção** como preset de arquétipo.
- ACL por conta (RBAC granular) — hoje owner/member org-wide.
- Multi-agente por `ad_account` (hoje 1:1).
- **Multi-conta na seleção do onboarding (multi-select) — feito** (checkbox no connect-dialog + `selectAccounts` já aceitava array). Resta possível `meta_connections` normalizado se o volume pedir.

**Infra / DX**
- Pacote `@automato/design-system` compartilhado.
- Web em serviço estático dedicado (nginx/Caddy) quando o tráfego justificar.

**Dados / análise (sinais externos)**
- **Sinais externos do cliente (API/webhook)** — o cliente define um dado próprio (ex: agendamentos vindos do CRM) que enriquece a análise; ingestão atrás de `ExternalSignalsPort`, curado no brief. Detalhado abaixo (**Fatia 9**).

**Controle conversacional total pelo WhatsApp (pós-MVP)**
- **O agente se auto-configura e ajusta qualquer coisa na plataforma só conversando.** Estende o Grafo B (chat ReAct, `5c`) + o catálogo de tools: além de otimizar a conta, o usuário pede em linguagem natural e o agente **executa na plataforma** — ex: "muda sua meta pra custo por venda de R$120", "passa a autonomia pra agir no seguro", "silencia a campanha X", "aprova aquela ação pendente", "ativa o modo lançamento". Cada capacidade de config/ação vira uma **tool** (mesma taxonomia da escrita: `riskLevel`, idempotência, **eco+confirma antes de aplicar**, guardrail independente); mudar a config do próprio agente é uma tool como as outras. Depende de: `5a`/`5b` (write path + HITL) + catálogo de tools + as superfícies de config já existirem como operações servíveis (a superfície "Agente" da Fatia 4 já expõe os campos; aqui eles ganham uma tool equivalente). Fronteira de segurança: nada de auto-aplicar em interpretação incerta (§8 — chat sempre confirma), e ações sensíveis (billing, remover conexão) ficam fora até terem gate próprio.

**Flagship pós-MVP:** criação de campanhas no WhatsApp — detalhada abaixo (Fatia 7).

## Fatia 7 — Criação de campanhas (roadmap pós-MVP)

**Visão "gestor completo no WhatsApp":** o agente também **cria** campanhas — a pedido ou proativo. Só depois do MVP de otimização validar. Arquitetura já antecipa (catálogo de tools + `AdsPlatformPort` + porta nova de storage). **Depende:** MVP validado (pós-beta) + `5a`/`5b` (write path + HITL) + catálogo de tools.

- **7a — Biblioteca de criativos + intake:** `StoragePort` (S3-compat) + Creative Library (upload web + **mídia inbound no WhatsApp** + reuse de vencedores da conta) + upload pra Meta (`image_hash`/`video_id`) + capturar **Page** do cliente (`listPages`, escopo `pages_show_list`).
- **7b — Rascunho de campanha + criação:** tools `createCampaign/AdSet/Ad`; agente monta **draft** (objetivo + budget + targeting + placement + criativo + **copy gerada pelo LLM**, configurável); **aprovação obrigatória do draft** (default — cria gasto novo; eco completo) + **guardrail de budget novo**; criação idempotente.
- **7c — Criação proativa + conversacional:** agente **propõe** nova campanha pelo que observou (ex: criativo saturado → testar novo ângulo); "cria uma campanha…" no chat (Grafo B). Gate **personalizável** (default = aprovação).
- **Fora até da 7 inicial:** **geração de criativo por IA** (imagem/vídeo) = fase mais tardia. Copy por LLM já entra.

**Design das telas/fluxos** (Creative Library, card de aprovação de rascunho, intake de mídia WhatsApp) = ver `DESIGN.md`.

## Fatia 8 — Orquestração multi-agente / qualidade (roadmap pós-MVP)

**Visão:** elevar a qualidade e a escala da análise com **mais papéis de agente** e **map-reduce por entidade** — sem reescrever o grafo. **Depende:** MVP validado (hipótese confirmada na 3a) + `5a` (write path, p/ o validador de segurança de ação). A costura já existe desde a 3a-2: o par **Analista→Revisor** é modelado como uma **lista de passes** (`reviewPasses`, default 1) — crescer = **registrar mais passes/papéis**, não reescrever nós.

- **8a — Painéis de revisores/perspectivas:** vários revisores com lentes distintas (correção, evidência, tom, risco) em vez de 1; síntese entre eles. Cada lente = mais um passe na lista.
- **8b — Map-reduce por entidade:** ✅ **antecipado na 3b-2** (análise por-anúncio → síntese da conta, com política de execução por-agente e cache de visão). Resta pós-MVP: paralelismo bounded do mapa (hoje sequencial) + guard dinâmico de tamanho de brief + downsample de trends para contas muito grandes.
- **8c — Redator de mensagem (WhatsApp):** ✅ **antecipado na 3b-1** (papel `write_message` dedicado, voz do arquétipo, fallback determinístico).
- **8d — Validador de segurança de ação:** papel que revisa cada ação **antes de aplicar** (redundância sobre os guardrails determinísticos da 5a) — rede extra no caminho de escrita.

**Fora até a 8:** paralelismo bounded do map-reduce + downsample dinâmico de trends + guard dinâmico de tamanho de brief (na 3b o mapa é sequencial e o top-N limita o contexto da síntese).

## Fatia 9 — Sinais externos do cliente (API/webhook) (roadmap pós-MVP)

**Visão:** deixar o cliente **alimentar a análise com dados próprios** que a Meta não conhece — o sinal que de fato importa pro negócio dele. Ex: o CRM dispara, por API, a **quantidade de agendamentos** por campanha; o agente passa a raciocinar sobre *custo por agendamento real*, não só sobre a conversão que a plataforma otimiza. Genérico por construção: o cliente **define e personaliza** o sinal (nome, unidade, a que entidade se liga, semântica) — nada hardcoded a "agendamento". **Depende:** MVP validado + `4` (UI de config, p/ definir os sinais). Fora do MVP porque otimiza contas **com dado da plataforma** primeiro; o sinal externo enriquece, não substitui.

- **9a — Definição do sinal + ingestão desacoplada:** `signal_definitions` (org-scoped: `key`, label amigável, unidade, escopo/nível de entidade `account|campaign|adset|ad`, agregação, mapeamento pra taxonomia neutra) + **borda de ingestão atrás de porta** (`ExternalSignalsPort`): endpoint de **API + webhook** autenticado por-org (token/API-key rotacionável, **idempotente por chave**), gravando em `external_signals` genérico (`type`+`payload`, estilo `usage_events`) — org-scoped, entity-ref, valor, timestamp. Trocar a origem (CRM/Zapier/planilha) = nova integração sobre a mesma porta, core intocado.
- **9b — Curadoria no brief + uso pelo agente:** camada **determinística pura** (estende o `AccountBrief`, como o funil de messaging) que normaliza e anexa os sinais externos como **contexto** por entidade — o LLM nunca vê o firehose. O sinal pode virar um `ConversionGoal` **de origem externa** (reusa a taxonomia neutra: custo/retorno por agendamento derivam como CPA/ROAS de qualquer conversão) **ou** ficar como métrica secundária. **Por-agente** (config, Fatia 4): quais sinais pesam e como.
- **9c — Correlação + confiabilidade:** casar o sinal externo com a janela/entidade certa (atribuição simples por período), lidar com atraso/lacuna do envio (degradação graciosa — sem dado recente = não usa, com nota), e sinalizar frescor na UI.
- **Fora até a 9:** atribuição multi-touch / modelagem estatística do sinal (aqui = correlação simples, honesta sobre a incerteza).

**Portas novas:** `ExternalSignalsPort` (ingestão) — na tabela de portas do `CLAUDE.md §5` como *(roadmap)*.

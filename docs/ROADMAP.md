# ROADMAP — Construção do AutoTraffic

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
| **5a** | Escrita + guardrails ✅ (auto-apply only) | Adapter de escrita (4 mutações idempotentes+dry-run), executor+audit+metering, decide/guardrail cross-run+conflito, undo last-run, UI autonomia/guardrails, mini-surface. HITL = 5b | 4,3,2a |
| **5b-1** ✅ | HITL via **site** | Aprovar/rejeitar por ação (mini-surface + `/approvals` cross-conta); `approvals` granular (fonte da verdade); apply-service com **re-check fresco** (sem checkpointer); guardrail de no-op + `allowedActions` nas sugeridas + barradas visíveis; expira 24h; **revert endurecido** (drift + TTL) | 5a |
| **5b-2** ✅ | HITL + operação via **WhatsApp** | Inbound real (webhook/set + `parseInbound` + debounce); Grafo B ReAct (leitura sobre nosso DB + "analisa agora" com push); aprovação conversacional (approve/reject, desfecho de volta); checkpointer Postgres | 5b-1 |
| **5c** ✅ | Chat ReAct pleno (end-state) | **Escrita LIVRE por chat** (propor do zero, eco+confirma + guardrail, inline) + budget set-absoluto + revert por chat + leitura mais rica + foco multi-conta. Enforcement via `allowedActions` (não `agent_tool_bindings`) | 5b |
| **6a** ✅ | Observabilidade + Painel gerencial + Frescura | Timeline por conta (auditoria, inclui ações por chat) + **Painel** home cross-conta (pendências/atenção/atividade/panorama) + **frescura** (sync-only sob demanda + sweep periódico + lazy on-view + as-of, split ao-vivo×datado) + migração do detalhe p/ router-tabs (Visão geral·Agente·Timeline) | prévias |
| **6b** ✅ | Prontidão pra beta real (recortada) | Gate de beta (enforcement API+cron + CLI + backfill) + auth self-service com email (verificação + reset, SES) + billing owner (COGS por conta) + ops (shutdown/readiness/higiene). Throttle/token-190-proativo/backups-por-script = fast-follow | prévias |
| **6c** ✅ | Qualidade do agente + verificações (Bloco 1) | Core determinístico (benchmarks de cold-start, tiers Winner/Zombie, sinais de fadiga/saturação/baixo-volume, elegibilidade) + prompts (árvore de diagnóstico) + guard de significância (rebaixa escalar sem base) + visão HD/multi-frame/decomposição (cache por id estável) + arquétipos Otimizador/Vigia Intensivo + UI avançada (knobs+tooltips) + custo por conta (chat atribuído). Visão verificada; custo do chat calculado | prévias |
| **7** | Criação de campanhas + auto-config por chat (pós-MVP, Bloco 2) | Gestor completo no WhatsApp: cria campanhas a pedido/proativo; auto-configurar o agente conversando (metas/playbook/guardrails/cadência) | MVP validado, 5a/5b, 6c |
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

### Fast-follows do pivô B2B/B2C (referência de mercado configurável + multi-moeda + contas zeradas)
- **[MÉDIO] Editar a referência de mercado via chat.** Hoje a tabela (custo/CTR/freq/zumbi/baseline) é editável só na UI (org + override por agente). O **alerta de reativação** já é configurável por chat (`set_notifications`); a tabela em si fica p/ depois (parsing conversacional de faixas + eco+confirma).
- **[MÉDIO] Sub-unidade de moeda (moedas sem 2 casas: JPY/KWD…).** `MINOR_UNIT_DIVISOR=100`, `toFixed(2)`, `ZERO_SPEND_EPS`, `MIN_BUDGET_MINOR` assumem 2 casas. Ler `currency_offset` da Meta e generalizar a sub-unidade. ICP majoritário é BRL/USD (2 casas).
- **[BAIXO] Câmbio/conversão de moeda.** As agregações cross-conta agrupam POR MOEDA (nunca somam moedas diferentes); não há conversão FX. Se algum dia fizer sentido um total único multi-moeda, exigiria um provider de câmbio (fonte + cache + data-de-referência).
- **[BAIXO] Distinguir "nunca teve movimento" de "parou agora"** via `created_time`/`updated_time` da Meta (hoje `hasBaseline`/`last_activity_at` são proxies; a dormância por tempo já cobre o backoff sem isso).
- **[BAIXO] Estado dormante no detalhe da conta.** A visibilidade de dormância ("conta parada — vigiando o retorno") está no card de panorama (dashboard + Contas); o empty-state do detalhe da conta (`account-overview`) ainda mostra o texto genérico.
- **[BAIXO] Repropor reativação por-conta.** O alerta de reativação é por-agente (1:1 conta); escopo por-grupo/por-participante segue o fast-follow de N integrações.

### Resolvido pelo pivô (era dívida): faixa de custo cold-start sensível a ticket/vertical
A dívida **"[MÉDIO] Faixa de custo cold-start sensível a ticket/vertical"** (era `sale = R$40–120` hardcoded p/ saúde) foi **resolvida**: as faixas de custo (+ CTR/frequência + zumbi/baseline) agora são **configuráveis** (org-default + override por agente, currency-aware, match-or-drop de moeda). Vazio = não usa como contexto.

### Fast-follows da fatia "Postura de comunicação + narrativa no site + pulso resumo-do-dia"

Postura configurável (diretividade/volume/profundidade + preset de experiência), voz única
no push/chat/pulso/site, rótulo de CPA honesto e pulso P2 ("resumo do dia" voiceado).
Diferidos:
- **Backfill de `agents.posture` por-arquétipo** nos agentes já existentes (hoje ficam no
  `DEFAULT_POSTURE` de coluna = conservador; novos semeiam do arquétipo). Mesmo precedente do
  `notify_policy`.
- **Read-tool de criativo/anúncio por nome/id no chat** — hoje `get_top_creatives` só devolve
  o top-5 ranqueado e não há lookup de um criativo específico nem nível adset/ad; casa com o
  workstream "aumentar leque de recomendações". Tratado à parte (não é postura).
- **Slider mais fino (>3 níveis) por eixo** de postura; **escrita PROATIVA de config** mais
  rica (hoje o agente OFERECE o ajuste ao sinal do dono, mas não muda sozinho).
- **Pulso: tuning de rate-limit/cadência** — o P2 lê a Meta a cada disparo (`getFreshMetricsData`),
  somando ao pull do cron; revisar cadência/token-bucket sob escala. Refino do **dedupe/janela**
  do pulso conforme uso real.
- **Atribuição de custo do pulso à conta** — hoje o `usage_events` do redator do pulso é
  org-level (LLMCallMeta não carrega `adAccountId`); casa com o rollup de custo por conta.
- **Narrativa voiceada no HISTÓRICO de runs** + toggle "ver resumo neutro" pro gestor técnico
  (hoje a narrativa substitui o summary neutro no topo, com fallback).
- **Postura no registro estruturado do analista** — DESCARTADO por decisão (protege o
  substrato: feedback/dedupe/reprodutibilidade); registrado como fronteira, não como TODO.

### Fast-follows da fatia "Recomendações extensíveis + copy + auto-config"

Diferidos ao implementar a fatia de recomendações extensíveis por tools (copy + 3 kinds +
auto-config + reply-context). **Nenhuma escrita nova na Meta** entrou nesta fatia.

- **Aplicar duplicar/escalar na Meta** (hoje só recomendação em texto) — **junto da criação de
  campanha do zero**: porta `AdsPlatformPort.duplicateEntity` (`/copies`, `status_option=PAUSED`,
  `deep_copy`, `parameter_overrides`, retorno `copied_*`/`ad_object_ids`) + `listCustomAudiences`
  (`/customaudiences`) + `searchInterests` (`/search?type=adinterest`) + `updateTargeting`;
  guardrail de gasto novo (teto R$/dia por entidade + nº máx/dia); executor/apply-service
  `apply-duplicate` (mini-saga idempotente, P2 = cópia pausada + report, read-after-write anti-2ª-cópia);
  tool `duplicate_scale` (proposeOnly, gate CREATE); extensão de `approvals` com `actionType='duplicate'`
  chaveado pela entidade-origem (aprovação simétrica site+WhatsApp); `recommendations.draftSeed` +
  `pendingDuplicate` (pré-carrega o rascunho); premissas P1 (sempre aprovação) / P2 (PAUSED).
- **Criar campanha do zero** (saga de 5 POSTs, `StoragePort` S3-compat, Creative Library, upload de
  mídia via WhatsApp, captura de Page/Pixel no onboarding, `object_story_spec`, copy por LLM) = Fatia 7.
- **Catálogo de tools no caminho quente — convergência total:** hoje em `shadow` (loga divergência,
  não muda comportamento); virar fonte da verdade da allowlist e remover o mapa hardcoded
  `WRITE_TOOL_TO_ACTION`/`WRITE_TOOL_NAMES` quando billing/entitlement justificar.
- **Laço de aprendizado do `agent_memory`** (hoje só grava `rejected`): passar a escrever/curar
  vencedores/padrões aprendidos da conta e lê-los no fluxo de recomendação/criação.
- **Historização de copy** (`ad_creatives` hoje = 1 linha viva por anúncio) — série de copy×desempenho.
- Edição de targeting de conjunto **ao vivo**; tools `bid`/`CBO`/Advantage+; Creative Library **web**;
  orçamento **vitalício** (lifetime + end_time); escopo de público **por-grupo**.

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

**Fast-follows da 6c (qualidade + verificações) — registrados:**

- **Transcrição de áudio de criativo** — decompor o vídeo pela FALA (script/gancho), sinal mais rico p/ VSL/vídeo longo. **Bloqueado hoje:** a Meta não expõe o `source` do vídeo com System User token (confirmado). Destrava com a **biblioteca de criativos da Fatia 7** (cliente sobe o vídeo → aí há áudio p/ STT).
- **"Never miss timing" por gatilho de evento** (monitoramento intra-cadência) — o Vigia Intensivo hoje é cadência curta (2×/dia) + limiares apertados + alerta proativo, **sem** gatilho em tempo real. Gatilho por evento (ex: pico de CPA dispara run) = **Fatia 8 / monitoramento**.
- ✅ **Editor das FAIXAS de cold-start na UI — ENTREGUE (pivô).** As faixas de custo-por-resultado (conversa/lead/venda) + CTR/frequência + zumbi/baseline agora são editáveis na UI (Configurações = padrão da org; config do agente = override por conta), currency-aware. Vazio = não usa como contexto.
- **Rollup de custo por conversa** — o custo do chat já é atribuído à conta + carrega `conversationId` no payload; falta a agregação/relatório **por conversa** (metering).
- **Bloco 2 (Fatia 7):** criação de campanhas + **auto-configurar o agente por chat** (mudar metas/playbook/guardrails/cadência conversando) — estende o Grafo B do 5c.

**Fast-follows do recebimento de áudio no chat (WhatsApp) — registrados:**
- **Entender/processar mídia não-texto** (imagem/vídeo/documento) no chat — hoje o agente só **avisa** que ainda não lê; reusar a visão (`CreativeVisionPort`) e/ou OCR atrás de porta pra ler o conteúdo. A união `InboundMessage` (`kind:"unsupported"`) já nasce pronta pra virar tratamento.
- **Áudio de saída (TTS)** — o agente responder por voz (hoje só recebe + transcreve).
- **`StoragePort` p/ o áudio** — guardar o blob e passar ref no job (evita o base64 ~20MB trafegar no Redis/BullMQ na fila de inbound **e** na de transcrição).
- **Cap de custo/duração de transcrição** (proteção de margem, §11) + eventual gate por-org (desligar áudio).
- **Adapter alternativo de mídia via `getBase64FromMediaMessage`** — se o `base64:true` do webhook se mostrar frágil (nota de voz iOS/ephemeral), buscar os bytes sob demanda atrás da mesma `MessagingChannelPort`, sem tocar o core.
- **Dedupe atômico de `messageId`** — hoje `alreadyProcessed` é read-then-write sem índice único (seguro só com o worker single-réplica/concorrência 1). Sob >1 réplica, redelivery do mesmo áudio poderia transcrever/cobrar em dobro. Fix real: coluna `messageId` dedicada + índice único (ou `SET NX` no Redis antes de enfileirar) — casa com a escala do worker (§14).

**Melhorias de valor da 6c (review squad + Steticos):**
- ✅ **[ALTO] Detector de tracking/atribuição furado — ENTREGUE (Bloco 2, S1.3).** `detectTrackingHealth` (nota de conta) + `guardTrackingCaveat` (caveat nas pausas por CPA-de-venda em base `target`; não rebaixa; proxy não recebe) + nota no prompt. Limiares `ANALYSIS_QUALITY_TRACKING_BROKEN_{RATIO,MIN_FUNNEL}`.
- ✅ **[ALTO] Quantificar desperdício + 80/20 — ENTREGUE (Bloco 2, S1.5/S1.8).** `computeWasteReport` (`wastedSpend` = só zumbis + Pareto por base de conversão + `annotateFreedSpend` na pausa), no brief/`metrics_snapshot`, card na UI + widget cross-conta no Painel; o redator lidera pelo money-shot.
- **[ALTO] Transcrição de áudio de criativo** — segue **bloqueada**: criativos da Steticos são vídeo antes/depois **+ fala**; frames HD não capturam o gancho FALADO. Depende da biblioteca de criativos da Fatia 7 (cliente sobe o vídeo).
- ✅ **[MÉDIO] Faixa de custo cold-start sensível a ticket/vertical — RESOLVIDO (pivô).** Deixou de ser hardcoded: as faixas vêm da referência de mercado configurável (org + override por agente, currency-aware). Vazio = não injeta faixa.
- ✅ **[MÉDIO] Frequência por estágio — ENTREGUE (Bloco 2, S1.1/S1.2).** `AudienceProfile` (sync `targeting`, sem chamadas extras) → `frequencyCapByStage` (prospecção ~2,5 / remarketing ~8). Classificação frio×quente por custom-audience de inclusão + nome do público. *Fast-follow: resolver `subtype` de cada audience + tamanho via `delivery_estimate` p/ lookalike×retarget cirúrgico.*
- ✅ **[MÉDIO] Não matar em learning — ENTREGUE (Bloco 2, S1.4).** `guardKillWithoutMaturity` (pausar→investigar em learning, LLM-origin; playbook/guardrail/kill-switch passam — não cega o Vigia Intensivo).
- ✅ **[MÉDIO] Decomposição de criativo `body` + `proof_strength` — ENTREGUE (Bloco 2, S1.6).** Visão decompõe corpo + força de prova (weak/medium/strong); descritivo, não altera tier/score. Bump `CREATIVE_VISION_ANALYZER_VERSION`→3.
- **[BAIXO] Plano sequenciado + "monitorar no próximo período"** no prompt (squad analyze-performance).

**Fast-follows do Bloco 2 (qualidade) — registrados:**
- **Resolver público (subtype + tamanho via `delivery_estimate`)** — hoje frio×quente sai do nome do público (sem chamadas extras); resolver o `subtype` de cada custom audience + o tamanho estimado dá precisão cirúrgica de lookalike×retargeting. Evolução do `AudienceProfile` (S1.1).
- **Superfície de criativo no web (body/proofStrength/decomposição)** — a visão já decompõe (hook/angle/format/cta/body/proofStrength), mas não há tela de criativo hoje; quando houver (casa com a biblioteca da Fatia 7), renderizar a decomposição.
- **Estágio de público na visão AO VIVO da conta** — hoje o `stage` só aparece nos cartões congelados do run (`RunCampaignCard`); a visão ao vivo lê `entity_analyses`, que não congela público → exige migração p/ persistir o estágio por entidade.
- **Desperdício cross-conta multi-moeda** — o total do widget do Painel soma valores em BRL (MVP BR-only); por moeda quando entrar conta não-BRL. (Mesma raiz: o `annotateFreedSpend`/mensagem hardcodam `R$`; derivar da moeda da conta.)

**Estratégia (review squad `traffic-masters` + Steticos, Bloco 2) — registrados:**
- **[ALTO] Guard de tracking mais forte no caminho AUTÔNOMO (decisão a rever com o dono).** Hoje o tracking é "guarda suave" (só caveat, não rebaixa) — decisão batida na fatia. O squad aponta a assimetria: numa conta **purchase-optimized que fecha off-Meta** (base `target` + tracking suspeito), o CPA-de-venda vem catastrófico e uma pausa/corte de origem LLM em autonomia alta **não é barrada**, só comentada — diferente dos guards de significância/learning que rebaixam. Sugestão do squad: quando `tracking.suspect`, rebaixar `pause`/`decrease_budget` em base `target` → `investigate` (igualar o rigor). **Contraria a decisão "avisa + guarda suave"** — reabrir com o dono antes de mudar. (No caso Steticos puro as campanhas são `proxy`, então nem julga por venda; a exposição é o vertical purchase-optimized.)
- **[ALTO] Significância cega a `conversation_started`.** `computeEligibility` usa só `conversions≥20` OU `clicks≥100`. Pro ICP (poucas vendas rastreadas), a significância depende só de cliques — a conta de mensagem nunca vira "winner" e tem escala rebaixada. Deixar `conversation_started` contar como volume quando `basis=proxy`/objetivo de mensagem (o dado já está no `funnel`). Consistente com o `hasSignOfLife`.
- **[MÉDIO] Teto de frequência × janela.** O cap 2,5/8 é fixo mas a janela vai a 30d (`ANALYSIS_WINDOW_MAX_DAYS`); em janela longa a frequência cumulativa estoura o cap → `audience_saturation` falso-positivo. Normalizar a frequência p/ base semanal OU escalar o cap com `windowDays`. (Default 7d está ok.)
- **[MÉDIO] Plano ranqueado por R$ + realocação explícita.** O money-shot para no "libera R$X" na pausa; o squad (`audit-ad-account` Fase 4) ranqueia recomendações por impacto em R$ + emite realocação ("mova R$ de A p/ B"). Ordenar por impacto quantificado e sugerir realocação zumbi/mal-alocado → top performer.
- **[MÉDIO] Medir o hook (thumb-stop), não só inferir.** O resolver amostra frames espaçados e o LLM infere o gancho; o squad mede `3s-views/impressões`. Adensar a amostragem nos frames iniciais e/ou ingerir 3s-view/thruplay p/ medir hook-rate. (Áudio/voz já é fast-follow da Fatia 7.)
- **[MÉDIO] Tracking em zero-config.** `detectTrackingHealth` só dispara se a meta é off-platform declarada; conta sem meta (zero-config) → detector mudo justamente onde mais precisa. Inferir meta off-platform provável do mix (muita campanha de mensagem) OU nudge de onboarding "você fecha a venda no atendimento?".
- **[BAIXO] `zombieMinSpend=50` deixa campanha morta de baixo orçamento escapar do "queimado"** (o Pareto de share ainda pega). Revisar por moeda/porte.
- **[BAIXO] Nota no prompt: ratio de tracking alto também pode ser oferta/atendimento ruim**, não só pixel — o detector conflaciona "furado" com "conversão genuinamente ruim" (aceitável, é hipótese; vale a linha de consciência).
- **[nit] Fallback de frequência sem estágio (3) menos conservador que prospecção (2,5)** — um adset sem sinal de público (raro) fica menos rígido que um de prospecção; alinhar ao teto conservador.

**Loop de feedback de recomendação (mais robusto) — registrado:**
- Hoje só o **👎** fecha o loop (grava `agent_memory` type=`rejected` → o brief não repete o vetado); o **👍** e o `outcome`/`outcomeMetrics` são só medição, sem realimentar a análise. Evoluir: (a) aprender com o 👍 (reforço leve do que funciona — cuidando de não virar viés); (b) **decaimento/expiração** da memória "rejeitado" (contexto muda; um veto de meses atrás não deve calar pra sempre); (c) ponderar recomendações por `outcome` observado (fechou o loop de validação → prioriza o que historicamente deu certo naquela conta). Atrás da estrutura `agent_memory`/`recommendation_feedback` já existente.
- **[BAIXO] Limpar override avançado na UI** — hoje o merge de `model_config` só seta (não remove); reverter um knob avançado ao padrão do sistema exige semântica de replace-subset. Setar/alterar funciona; limpar o último campo é no-op.
- **[MÉDIO] "Opções avançadas técnicas" na UI** — os knobs técnicos (modelos/IA principal/unit/mensagem/visão, top-N de campanhas, tokens de saída, revisão on/off) foram **removidos da UI** na 6c (a seção mostra só "Qualidade e limiares"). Seguem **overridáveis por env + `agents.model_config`** (contrato mantém os campos); a UI deles volta quando fizer sentido para o gestor técnico (provável seção "Técnico/avançado" separada, atrás de permissão).

**Revisão de custo-benefício de modelos (análise 6c — preços OpenRouter verificados):**
- **[ALTO] Modelo do chat (`CONVERSATION_MODEL`)** — hoje `google/gemini-2.5-flash` ($0,30/$2,50 por 1M): geração **mais antiga E mais cara** que o `gemini-3.1-flash-lite` ($0,25/$1,50) já usado na visão/mensagem, e com tool-calling não-determinístico (falhou em chamar `trigger_analysis` num teste ao vivo). Custo do chat é irrisório (~$0,0004/turno) → **otimizar CONFIABILIDADE de tool-calling, não preço**. Trocar por um **flash 3.x** (idealmente `gemini-3.1-flash` não-lite, se existir; senão `gemini-3.1-flash-lite` testando a escrita; plano B `deepseek-v4-pro` p/ tool-calling firme). Troca = 1 linha no `.env`.
- **[MÉDIO] Override por-agente do modelo do chat** — `CONVERSATION_MODEL` é só **env-global** hoje (os modelos de análise já têm override em `agents.model_config`). Permitir chat mais forte só nos agentes com escrita habilitada.
- **[MÉDIO] Modelo do mapa por-campanha (`unitModel`)** — `deepseek-v4-pro` ($1,188/$3,564) roda **1×/campanha** = maior vetor de custo do run. Avaliar (A/B) rebaixar p/ um **flash-tier** (~5–14× mais barato): o brief curado carrega o peso e grok(síntese)+revisor pegam o resto. Manter só se a profundidade por-campanha se mostrar crítica.
- **[BAIXO] Modelo do revisor** — hoje `grok-4.5` (forte). Como o revisor mais corrige/corta do que cria, um modelo um degrau abaixo pode bastar; manter grok enquanto a revisão for a rede de segurança principal.
- **[BAIXO] Faixas/`zombieMinSpend` por moeda** — hoje constantes BRL aplicadas a qualquer conta (MVP BR-only); escalar por moeda quando entrar conta não-BRL.

> **Nota (guard × playbook):** o veto de significância cobre recomendações de **origem LLM**; ações de **playbook** (regra explícita do usuário) não passam pelo veto — o guardrail de blast-radius é a rede lá. Intencional.

**Plataforma / integrações**
- **Integrações como entidade real (`platform_connections`)** — feito: conexão dona do token, `ad_accounts` referenciam, lifecycle soft (`active|unavailable|removed`), reconciliador puro (`reconcileSync`/`reconcileSelect`), conectar+multi-selecionar+sincronizar em Integrações; Contas só reflete; WhatsApp virou integração (sem aba). Fast-follows abaixo.
  - **Drop de `ad_accounts.token_cripto`/`token_status`** — hoje a conexão é a fonte da verdade; a coluna legada segue por dup transitória até o backfill ser confirmado em produção. Aí: migration de drop + remover fallbacks.
  - **Unique `(org_id, external_business_id)` em `platform_connections` + `onConflictDoUpdate` no create** — hoje o dedupe de recolar-token é app-level (find-then-update), seguro em request serial mas com TOCTOU sob duplo-clique/duas abas (pode criar 2 conexões pro mesmo BM). Fix de hardening: constraint no DB (arbitra) — **pré-requisito:** backfill agrupar por `(org, businessId)` (hoje é 1 conexão por conta; contas do mesmo BM gerariam linhas que a unique rejeitaria) + dedupe de dados existentes. Fazer os dois juntos antes do 1º deploy que rode o backfill em prod.
  - **Auto-descoberta de contas** (hoje só "sincronizar" manual) — pendurar um refresh de catálogo na cadência de `insights-sync` da conexão (sem job novo, quase de graça). Token morto já é detectado pela cadência.
  - **Remover/desabilitar conexão** (soft, com confirmação) — hoje só há conectar/gerir/sincronizar; deletar conexão nunca deve cascatear delete de conta (FK `restrict`).
  - **Remover onboarding antigo (dead code)** — connect-dialog/connector-strategy + `/api/accounts/connect|select` ficaram mortos após o slice `connections`; retirar (+ avaliar aposentar o slice `admin`). *(admin já aposentado; falta o connect-dialog/endpoints — feito parcialmente.)*
  - **N números de WhatsApp por org (destravar o canal)** — hoje o schema `channel_instances` **tolera** N (índice em `org_id`, sem unique; `evolution_instance`+`phone` por linha), mas o código assume 1: `instanceName(orgId) = org-${orgId}` + queries `limit(1)` (§9 MVP = 1 número/org). Ir pra N é mudança contida no adapter/serviço de canal (nome de instância próprio por número, tirar o `limit 1`, conceito de "qual número", `unique` em `evolution_instance`) — **sem re-arquitetura**. Aí o card WhatsApp fica re-conectável em "Disponíveis" (simétrico ao Meta); a UI já tem a costura (`availableProviders`). Casa com o pool de números / Cloud API.
- OAuth oficial Meta + App Review (sai do System User token colado).
- Checagem proativa de escopos (`/debug_token`) + `appsecret_proof` — reintroduz `META_APP_ID`/`META_APP_SECRET` (removidos no onboarding token-only da 1b).
- WhatsApp **Cloud API** / pool de números (sai do Evolution não-oficial).
- Google / TikTok Ads = **novo adapter** atrás de `AdsPlatformPort` (core intocado).

**Billing**
- Stripe: mensalidade + custo por uso (markup sobre `usage_events`).

**Governor / escala (Fatia 2)**
- Token-bucket Lua (EVALSHA) no `acquire` (controle proativo) + Batch API (≤50/HTTP) — quando o volume exigir (hoje = mínimo-correto reativo).
- **Backoff + retry no rate-limit da Meta — read-path FEITO.** `callWithGovernor` (ads-meta) envolve `listEntities`/`getCreatives` com `acquire`+`observeUsage`+backoff (`shouldDegrade`/`MAX_INLINE_WAIT_MS`): rate-limit transitório retria inline curto; cooldown longo (minutos) degrada gracioso (parcial-rápido — nunca segura o run); toda leitura alimenta o governor (antes só o path de insights). Resta: **token-bucket Lua proativo** (acima) + estender o wrapper ao `mutate` (write path = 5a; o TODO em `meta-ads.adapter.mutate` já aponta pra cá).
- **Cache do catálogo de entidades entre runs — FEITO.** `MetaEntityCache` (Redis, TTL `META_ENTITY_CACHE_TTL_SEC`, default 1h) reusa o resultado de `listEntities` (os 3 níveis, `ad` = centenas paginado = a maior fonte de rate-limit) entre runs. **Invalidação:** TTL + **DEL na escrita REAL** (`mutate`/`restoreEntityState` derrubam o catálogo da conta; dry-run não invalida). `ttl=0` desliga. Segurança: o cache só influencia *quais entidades a análise considera* + a dica do pré-check de budget; a **escrita é sempre computada/barrada contra o estado FRESCO** lido no apply (`readEntityState`), então stale nunca vira escrita errada — no máximo no-op (já no alvo), % sobre a base fresca, falha graciosa (entidade sumiu / budget mudou de nível) ou ação adiada ao próximo run.
  - *"invalidar por sync" (ideia original) trocada por TTL + escrita:* amarrar ao `insightsSync` invalidaria quase todo run (o sync grava snapshots sempre) → cache inútil. Refinamento futuro: detectar id novo no sync p/ refrescar antes do TTL.
  - **Ainda adiado:** listar só entidades **ativas** — some com a visibilidade de pausados (atrito com o resume do 5a). O cache já corta a raiz sem mudar o que a análise enxerga.
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
- **Objetivo de negócio × otimização da plataforma — feito (Fatia 4, corte 1).** O bug de validação (agente com meta de **venda** R$150 numa conta que otimiza **conversas** dizia *"custo por conversa excelente (R$2,19 vs meta R$150)"*) foi corrigido: **conversão de negócio por-agente** (`AgentGoals.conversionGoal`, plumbada no brief via `resolveConversion`), **basis determinístico** por entidade (`conversionBasis: target|proxy|none`) — em `proxy` mostra o custo do objetivo da entidade **rotulado** e nunca declara meta batida —, **CPA-da-conta quando mensurável**, e **personalização por texto** (contexto do negócio + orientações, camada aditiva no prompt via `composeAgentPrompt`). Costuras novas: tabela genérica `conversion_labels` (worker resolve nome de conversão personalizada no run; API lê do banco, sem chamar a plataforma) + `agents.config_changed_at` (salvar config força 1 deep no próximo run, pois a herança incremental só olha métricas/flags). **Resto da Fatia 4 = corte 2** (autonomia, guardrails, playbook NL, identidade/voz, cadência) — detalhado abaixo (**Fatia 4 — corte 2**).
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
- ✅ **Auto-config do agente por chat — ENTREGUE (Bloco 2, S2.1–S2.7).** O usuário muda a config do próprio agente conversando (meta, autonomia, guardrails, cadência, arquétipo, playbook, identidade), sob **eco+confirma** (eco reforçado no afrouxamento de segurança). Camada compartilhada `@trafego/agent-config` (fonte única com o site) + `resolveAgentConfigChange` puro; kill-switch por-agente (`autonomy_policy.autoConfigViaChat`, default ON); `describe_capabilities` (autoconhecimento contextual). Ainda **fora** (têm gate próprio / fase própria): criar campanhas (Fatia 7), billing, remover conexão. Fast-follows registrados:
  - **Role-gating de auto-config** (só contato de owner) — hoje qualquer contato verificado (RBAC org-wide no MVP).
  - **Playbook por chat: reordenar prioridade + janela por-regra** — hoje add/toggle/remove; prioridade nova = fim da fila; o engine ainda ignora `cond.window`.
  - **Extrair o playbook CRUD p/ camada compartilhada** — hoje a escrita de playbook por chat (`apps/worker/.../config-writes.ts`) duplica o shape do site (`apps/api/.../agents/service.ts`); 3º consumidor → extrair (§13 3x→extrai).
  - **Override por-agente do modelo do chat** (já registrado) + **escrita proativa de config** (o agente sugerir mudança sozinho — hoje reativo).

**Fast-follows da 5c (escrita/leitura por chat)**
- **[MÉDIO] Resiliência do envio no `runConversationTurn`** (achado na validação ao vivo do Bloco 2) — o
  `sendToContact` roda FORA do try/catch: se a Evolution está fora do ar, o job de flush **lança e
  reenfileira**, re-rodando o turno (re-gasta LLM) e sem gravar o outbound nem sinalizar a falha. Envolver
  o envio em try/catch (log + não relançar, ou marcar o canal `disconnected` + parar de retentar), e
  gravar o outbound **antes/independente** do sucesso do envio (a resposta existe mesmo se a entrega falha).
- **`agent_tool_bindings` completo** — adiado; redundante com `allowedActions` p/ liga/desliga (que já
  vale no chat). Só se justifica por **shadow por-tool** (hoje `dry_run` é agente-wide) + entitlements/
  billing (o catálogo `agent_tool_definitions` já está semeado).
- **Shadow só-do-chat** (`agents.chat_shadow`) — isolar chat (simula) × pipeline (real); hoje `dry_run`
  afeta os dois caminhos.
- **Set-absoluto de budget na UI de config** — hoje o `mode:'set'` existe só via chat (5c-2).
- ✅ **Observabilidade de ações de chat no site — ENTREGUE na 6a.** A Timeline por conta + o widget de
  atividade recente do Painel leem `agent_tool_calls` com `coalesce(agent_id, run.agent_id)` + LEFT JOIN
  → ações por chat (`run_id` null) aparecem na web.
- **Agir sobre entidade viva FORA de análise (chat)** — hoje o agente só age sobre o que está em
  `entity_analyses` (resolve nome→id via `get_campaign_analysis`/`get_entity_detail`/`find_recent_actions`,
  todos lendo o DB curado); campanha nunca analisada (ex: recém-criada) não é resolvível → o agente não
  age (precisa "analisa agora" antes). Fast-follow: **read-tool que lista entidades direto da Meta e
  resolve nome→id ao vivo** (reusa `listEntities` + `MetaEntityCache`, sem reintroduzir pressão de
  rate-limit), inclusive **nível adset/anúncio** (hoje o chat age só em campanha — nenhum read-tool
  expõe adset/ad por nome). Passo real rumo ao "gestor completo" (§ controle conversacional total).
- **Sumarização rolante do histórico da conversa** (a janela por-turno cresce sem bound em thread longo).
- **Resolução de aprovações em lote por contrato** (hoje 1 a 1).
- **Escrita proativa por chat** — o agente sugerir uma mudança sozinho (hoje só reativo, sob pedido
  explícito). Casa com o "controle conversacional total" acima.
- **Revert de ação feita fora do sistema** (Ads Manager) — sem `before_state` nosso; hoje o agente recusa
  com honestidade.

**Flagship pós-MVP:** criação de campanhas no WhatsApp — detalhada abaixo (Fatia 7).

## Fatia 4 — corte 2 (MVP): config do agente (autonomia · guardrails · playbook · identidade · cadência)

Completa a superfície **"Agente"** (`/accounts/:id/agente`) com o resto da config do §10 do CLAUDE.md — tudo **por-agente, semeado por arquétipo, superfície ÚNICA** (não wizard paralelo) com **divulgação progressiva** ("avançado"). O corte 1 entregou correção da análise + conversão de negócio + personalização por texto + período; o corte 2 entrega o **como o agente age**.

**Chave:** o schema já existe (`agents.autonomy_policy/persona/tone/system_prompt/cadence/model_config`, `guardrail_configs`, `playbook_rules`, `agent_tool_bindings`) e o core já consome parte dele (`decideActions` lê `autonomyPolicy`; `applyGuardrails` lê `guardrail_configs`; `evaluatePlaybook` lê `playbook_rules`; o cron lê `agents.cadence`). Então o corte 2 é **majoritariamente contrato (zod→OpenAPI→kubb) + UI + serviço de leitura/escrita** — pouco core novo.

**Efetividade (produto):** autonomia e guardrails só **mordem quando a escrita existir (5a)** — no read-only a UI configura/persiste mas o agente não age; o `llm_cost_cap` já vale hoje. **Playbook** e **cadência** já têm efeito hoje (playbook gera candidatas na análise; cadência dirige o cron). Ordem sugerida: 4b-3 e 4b-5 primeiro (úteis já), 4b-1/4b-2 podem ir junto e ganham efeito pleno na 5a.

Sub-slices:
- **4b-1 — Autonomia (por origem).** Slider *"só avisa → sugere+OK → age no seguro → age sozinho"* (`AutonomyLevel`) decidido **por origem** (playbook × LLM) → `agents.autonomy_policy.bySource`. Default do arquétipo = `suggest` nas duas. `decideActions` já consome; efeito pleno na 5a.
- **4b-2 — Guardrails (rede independente).** UI de `guardrail_configs`: blast radius (`max_budget_change_pct`), nº máx de entidades/dia (`max_entities_per_day`), ações permitidas (`allowed_actions`), `dry_run`, `kill_switch`, cap de custo LLM (`llm_cost_cap` — já checado no pré-run hoje). Linguagem de gente + **defaults conservadores**; independente da autonomia (rede sobre os dois caminhos). Efeito de escrita na 5a.
- **4b-3 — Playbook em linguagem natural.** Editor de **linhas com lacunas** ("pausar anúncio que custa mais de R$ __ por venda"; "aumentar budget __% quando ROAS > __") → `PlaybookRule` (`when_json`/`then_json`/`scope`/`priority`/`enabled`). CRUD + reordenar prioridade + ligar/desligar; condições compostas no avançado. **Já alimenta a análise hoje** (candidatas → recomendações); a aplicação das ações vem na 5a. Slice CRUD próprio (é lista, não campo).
- **4b-4 — Identidade e voz (avançado).** `persona`, `tone` e **override do `system_prompt`** em divulgação progressiva (substitui a metodologia do arquétipo — poder pro técnico, escondido do não-técnico); + `model_config` (modelo/`reviewEnabled`/`topN`/`reasoningEffort`/`maxOutputTokens`) no avançado — o resolver já lê tudo isso. Zero-config intacto.
- **4b-5 — Cadência por conta.** Editar `agents.cadence` com **presets amigáveis** (diário 8h / 2× dia / semanal) + avançado (cron 5-campos) + timezone; hoje é `ANALYSIS_CRON_DEFAULT` global. `upsertAccountSchedule` já usa `agents.cadence` (fallback env) → o encanamento existe; falta a **UI + re-sincronizar o schedule no save** (`SchedulerPort.upsertSchedule`).

**Costuras/decisões:**
- **Contrato:** cada bloco = schema zod (fonte) → OpenAPI → kubb; blocos escalares estendem o `PUT /agent/config` do corte 1, playbook = CRUD à parte (lista). Sem tipo duplicado.
- **UI:** mesma superfície seccionada + `<details>` avançado; save-bar dirty já existe. Router-tabs (Visão geral | Agente | Timeline | Conexões) quando a Timeline (6a)/Conexões pedirem.
- **Invalidação:** mudanças relevantes à análise (playbook, `model_config`) continuam bumpando `config_changed_at` (força 1 deep); cadência não muda a análise (não bumpa).
- **Fonte única** dos limites/defaults da janela (hoje duplicados em 4 lugares — nit do review do corte 1) pode ser consolidada aqui.
- **Depende:** 4b-1/4b-2 plenos com **5a** (write path + guardrail engine); casa com o **controle conversacional total** (pós-MVP) — cada bloco vira uma tool equivalente.

**Entregue (corte 2):** playbook NL (CRUD + basis-honesto no core), identidade/voz (persona/tone/override + "ver metodologia"), cadência (`CadenceSpec` fonte única + `cadenceToCron` + job de resync, worker = dono do scheduler), seletor de arquétipo (re-seed preservando meta+textos), fuso org-level (Configurações), consolidação das constantes de janela, e o wiring do worker lendo autonomy/guardrail. Fast-follows deste corte:
- **Autonomia (4b-1) + guardrails (4b-2) — UI movida p/ a Fatia 5a** (só mordem na escrita; a leitura no worker já foi ligada aqui). A 5a entrega a superfície de edição + o write path juntos.
- **Janela por-regra do playbook** (3d/7d/14d) — o engine ainda ignora `cond.window` (usa a janela do agente); implementar fatiando os `insights_snapshots` diários por janela.
- **model_config na UI** (topN/reasoning/**escolha de modelo por-agente**) = **evolução do produto** — footgun p/ o não-técnico; expor primeiro em contexto admin/interno (o backend já resolve por `agents.model_config`). **Reviewer desacoplado do synthesis** (`OPENROUTER_REVIEW_MODEL`, default `google/gemini-3.7-flash`; synthesis segue no forte `x-ai/grok-4.5`) — E2E real validou paridade de qualidade (corta alucinação, schema íntegro) a **−76% de custo e ~2× mais rápido** que o grok no review. Override por-agente `model_config.reviewModel` já resolve; UI pendente. **A/B do synthesis** p/ modelo mais barato (ex: gemini-3.7-flash / claude-haiku-4.5) = medir qualidade antes, pois é a autoridade da análise.
- **Componentização das seções + Reactive Forms** na superfície Agente (hoje signals + nativos, consistente com o corte 1) + vendorizar `UiConfirmDialog` (o re-seed usa `window.confirm`).

## Fatia 5a — Escrita na Meta (entregue, auto-apply only)

Write path autônomo atrás de guardrails, **sem HITL** (aprovação conversacional = 5b). O que entrou:
- **Adapter de escrita** (`MetaMutationsService`): pause/resume/set_status/adjust_budget (±% daily|lifetime, minor units, piso), idempotente por leitura (no-op se já no alvo), gateado por governor. **dry-run** simula (lê+computa after sem escrever). **restoreEntityState** (undo, valores absolutos).
- **Core**: `riskForAction` params-aware (fonte única — cortar budget = low, auto-aplicável no act_safe); `applyGuardrails` ganha contexto **cross-run** (cap de entidades/dia + anti-compounding de budget) + **pré-check de nível de budget**; `resolveActionConflicts` (pausar domina, dedupe playbook>llm).
- **Executor** (`meta-tools`): idempotência (`${runId}:${action.id}`, replay), grava `agent_tool_calls` + `audit_log(before/after)` + `usage_events(action_applied)`; catálogo de tools semeado.
- **Grafo**: `decide_actions → guardrail_check → apply_actions` (best-effort, para no rate_limited); needApproval **não executa** (vira "sugerida" no `metrics_snapshot`).
- **Undo**: fila `action-undo` + `executor.revert` (reaplica before_state absoluto, idempotente `${id}:undo`, ignora simulados).
- **UI**: seções **Autonomia** (toggle-group 4 níveis × 2 origens) + **Guardrails** (switches/números/checkboxes) componentizadas; **mini-surface** de aplicadas (com reverter) + sugeridas no detalhe da conta.

**Fast-follows deste corte:**
- ✅ **Entregues no 5b-1** (ver `## Fatia 5b — corte 1` abaixo): HITL via site (aprovar/rejeitar por ação); guardrail de no-op (`ctx.statusByEntity`); `allowedActions` valendo nas sugeridas (guardrail sobre `needApproval`); ações barradas visíveis (`metrics_snapshot.droppedActions` → mini-surface); expira 24h; revert endurecido (drift + TTL). **Sem checkpointer** (approval + re-check fresco; checkpointer → 5c).
- ✅ **HITL + operação via WhatsApp = 5b-2** (entregue — ver `## Fatia 5b — corte 2` abaixo): inbound real + Grafo B (leitura + "analisa agora") + aprovação conversacional.
- **Teto ABSOLUTO de budget** no guardrail (hoje só clamp de %) — nova coluna + UI.
- **Enforcement de `agent_tool_bindings`** (enable/disable/shadow por-agente) = 5c (hoje o auto-apply usa `Action.riskLevel`, não os bindings; catálogo já semeado).
- **Undo por WhatsApp + histórico completo de ações** (a mini-surface é só do último run) = 5c / 6a (Timeline).
- **`config_changed_at` "janela por-regra"** e demais fast-follows de config seguem valendo.

## Fatia 5b — corte 1: aprovação via SITE (entregue)

HITL sem WhatsApp: o usuário aprova/rejeita cada escrita pelo site. **Mecanismo = approval
+ re-check fresco (sem checkpointer LangGraph)** — o grafo A segue linear, cria `approvals`
pendentes e fecha o run; ao aprovar, um apply-service (worker) relê o estado fresco, re-roda
o guardrail e escreve. O checkpointer fica reservado ao **5c** (chat ReAct). Entregue em 5
sub-fatias testáveis:
- **5b-1.1** — guardrail de **no-op** (`ctx.statusByEntity`) + ações **barradas** visíveis
  (`metrics_snapshot.droppedActions` → mini-surface "Barradas").
- **5b-1.2** — `approvals` **granular** (1 linha/ação, upsert por agente+entidade+tipo, enum
  `blocked`); `ApprovalPort` + adapter `@trafego/approval-postgres`; nó `create_approvals` no
  grafo + guardrail sobre `needApproval`; mini-surface e `/approvals` (cross-conta) listando
  as pendentes com **prazo** (`expiresAt`).
- **5b-1.3** — **aprovar/rejeitar** por ação (mini-surface + `/approvals`) + **apply-service**
  (`approval-apply` worker) com re-check fresco; barrado no re-check → `blocked` + motivo;
  idempotente por `${approvalId}:apply`.
- **5b-1.4** — expiração 24h (`approval-expiry` worker recorrente, `APPROVAL_EXPIRY_CRON`);
  bridge do cron (a msg de WhatsApp menciona "N ações aguardando seu OK" + link do site).
- **5b-1.5** — **revert endurecido**: re-check de drift no undo (avisa/`force`) + TTL por
  tempo (`REVERT_TTL_DAYS`).

**Repropor expiradas** = fast-follow.

## Fatia 5b — corte 2: HITL + operação via WhatsApp (entregue)

Operar o agente pelo WhatsApp — conversa livre (linguagem natural), capacidades de LEITURA +
"analisa agora" + resolver aprovações. **Escrita LIVRE do zero = 5c.** Entregue em 4 sub-fatias:
- **5b-2.1** — cano do inbound ponta a ponta: `parseInbound`/`jidToE164`/`parseConnectionUpdate`
  puros; `ensureWebhook` idempotente no `connect` (eventos + header do secret **por-instância**);
  casca valida o secret da instância e enfileira o payload **cru**; worker resolve contato
  verificado (desconhecido → silêncio), grava inbound (idempotente por `messageId`) e trata
  `CONNECTION_UPDATE` (status ao vivo). `sendToContact` unificado (resolve instância + splitter[chat]
  + envia + grava).
- **5b-2.2** — Grafo B leitura (ReAct): `ChatOpenAI`/OpenRouter + `bindTools` + voz do agente em
  contexto (`composeAgentPrompt`; concierge se N contas) + regras fixas de formato + anti-alucinação/
  as-of; **janela por turno** (nunca quebra par tool_call/result) + teto de tokens; custo **metrado**
  (`usage_events` type `conversation`). Read-tools sobre nosso DB curado (status/métricas/campanha/
  recomendações/pendentes). **"analisa agora"** dispara run `trigger=conversation` (reusa o
  run-dispatcher com guards) e o resultado **volta na conversa**. Checkpointer **PostgresSaver** (thread
  por conversa).
- **5b-2.3** — aprovação conversacional: tools `approve`/`reject` (por id de `list_pending`);
  referência inequívoca aplica direto (o nudge foi o eco), ambíguo → pergunta (§8); `approve`
  enfileira o **apply-service** (re-check fresco + guardrail já existentes) carimbando o contato; o
  apply-service **empurra o desfecho** (aplicado ✅ / barrado / dry-run) na conversa.
- **5b-2.4** — endurecimento: **debounce** (fila `whatsapp-flush` + buffer Redis; coalesce mensagens
  picadas num turno; jobId=conversationId serializa) + bridge do cron ("responda por aqui pra
  aprovar") + docs.

**Sem migration** (enum `run_trigger` já tinha `conversation`; `approvals.contact_id`, `messages.meta`
e `channel_instances.webhook_secret` já existiam). **Entregue na 5c** (antes "adiado ao 5c"): escrita
livre do zero, **tool `revert`/desfazer por WhatsApp**, leitura mais rica, `focusedAccountId` por-thread.
**Corrigido:** o **enforcement usa `allowedActions`** (não `agent_tool_bindings` — este virou fast-follow,
ver abaixo); o **checkpointer Postgres já estava ativo desde a 5b-2** (a nota do corte 1 que o dava como
"reservado ao 5c" está desatualizada). **Ainda adiado:** sumarização rolante do histórico, resolução em
lote por contrato. **Meta MCP embrulhado** = Fatia 7.

**Fix ao vivo (pós-entrega):** o no-op da 5b-1.1 lê `state.entities` — o catálogo **cacheado**
(`MetaEntityCache`, TTL). O cache só invalida na escrita REAL pelo nosso sistema; uma mudança
feita direto no Ads Manager (ex: reativar uma campanha) não invalida nada, então o no-op podia
confiar num status velho e barrar (silenciosamente) uma ação hoje válida — descoberto ao vivo
numa campanha reativada manualmente que continuava sendo barrada como "já pausada". Fix:
**releitura pontual** — `guardrail_check` identifica só as entidades cujo status cacheado
bateria com um no-op (`entitiesAtRiskOfStaleNoOp`) e faz 1 `readEntityState` fresco SÓ pra
essas (normalmente 0-1/run; não reintroduz a pressão de rate-limit que o cache existe pra
evitar) antes de rodar `applyGuardrails` (que continua puro — a releitura é IO na casca,
`refreshStatusByEntity`). `mapStatus` (Meta `effective_status`/`status` → `EntityStatus`)
passou a ser exportado por `@trafego/ads-meta` p/ o worker reusar (evita duplicar o
mapeamento). TTL padrão também reduzido de 3600s → 1800s (`META_ENTITY_CACHE_TTL_SEC`),
estreitando a janela de staleness em geral.

## Fatia 5c — Escrita livre por chat + leitura rica + foco (entregue)

O agente vira gestor conversacional: o usuário pede em linguagem natural e o agente **propõe →
ecoa concreto → confirma → aplica**, sob os guardrails existentes. Entregue em 7 sub-slices:
- **5c-1 — Núcleo de apply/revert compartilhado (refactor puro).** `applyCheckedAction`/
  `applyConfirmedAction` + `revertActionById` (`apps/worker/src/modules/apply`), reusados pelos
  workers `approval-apply`/`action-undo` (sem mudança de comportamento) e pela escrita por chat.
- **5c-2 — Budget set-absoluto.** `adjust_budget mode:'set'` (valor exato) no adapter; o guardrail
  clampa o set ao teto de blast-radius via `GuardrailContext.budgetAmountByEntity` (dropa se o budget
  atual não for verificável).
- **5c-3 — Loop de escrita livre.** Write-tools no Grafo B (pause/resume/set_status/adjust_budget) →
  nó `confirm` roda guardrail + dry-run **sem persistir** e monta o **eco determinístico** →
  `echoRelay` (LLM sem tools) dá voz leve → `confirm_write` → nó `applyWrite` re-checa fresco e aplica
  **inline na mesma msg** (lote + falha parcial + shadow via `dry_run`). **Enforcement por
  `allowedActions`** (allowlist filtrada em `turn.ts` → recusa honesta na hora). `agent_tool_calls`
  ganha `agent_id` + `run_id` nullable (escrita por chat não nasce de análise; `loadDailyToolContext`
  usa `coalesce(agentId, run.agentId)` sem backfill). Eco puro em `@trafego/core`.
- **5c-4 — Desfazer por chat.** `find_recent_actions` (ações reais recentes não-revertidas) +
  `revert_action` por id, com o mesmo eco+confirma (`pendingRevert`) → revert inline (drift + TTL da
  5b). Honesto: só desfaz ações nossas.
- **5c-5 — Leitura rica.** `compare_periods`, `get_entity_detail` (tendência), `get_agent_config`
  (só leitura), `explain_recommendation`.
- **5c-6 — Foco multi-conta.** `conversations.focused_account_id` + `set_focus`: em org com >1 conta,
  o usuário foca ("foca na Loja X") e leitura/escrita passam a operar nela; `turn.ts` resolve o
  agente em contexto (única conta ativa OU conta focada); o eco nomeia a conta; cross-conta → pergunta.
- **5c-7 — Prompt + endurecimento + validação.** System-prompt reescrito (escreve/desfaz/foca; não
  cria campanhas = Fatia 7; regra de não-volunteer; revert honesto); TTL do `pendingWrite` (~30 min);
  `docs/validacao-manual-5c.md`.

**Migrations:** `0015` (agent_tool_calls: run_id nullable + agent_id) e `0016`
(conversations.focused_account_id). **Segurança:** todo write por chat passa por eco+confirma (§8) +
guardrail (rede independente) + org-scoping (inclusive `set_focus`); a ação confirmada é a **congelada**
no gate (o "sim" não re-especifica nada — sem drift). Ações por chat gravam em
`agent_tool_calls`/`audit_log`/`usage_events` (trilha completa), **não** em `approvals`.

## Fatia 6a — Observabilidade + Painel gerencial + Frescura (entregue)

O gestor abre uma **home gerencial** com números frescos e decisões à mão; cada conta tem **Timeline**
de auditoria (inclui ações por chat); os números ficam frescos **sem pagar LLM**. Entregue em 9 sub-slices:

- **6a-1 — Frescura: porta de staleness + produtor do sync-only.** `shouldSync` (core puro) +
  `buildInsightsSyncJob` (shared, jobId por conta + `removeOn*`) reusando o worker morto `insights-sync`;
  env `INSIGHTS_FRESH_THRESHOLD_MIN` (120). `JobSpec` ganhou `removeOnComplete/removeOnFail/delayMs`.
- **6a-2 — Sweep periódico singleton.** Tick recorrente (= threshold) varre contas **ativas** (agente
  ativo), aplica `shouldSync` e enfileira sync-only só p/ as velhas (stagger). `repo.latestSyncedAtByAccounts`
  (max `updated_at`, sem N+1).
- **6a-3 — KPIs ao vivo + "atualizar agora".** `computeLiveTotals` (core, mesma cadeia do brief) +
  `GET /accounts/:id/live-metrics` (totais + as-of + janela) + `POST /accounts/:id/refresh-data` (força
  sync-only). `resolveWindows` movido p/ `@trafego/core` (reuso api+worker).
- **6a-4 — Painel cross-conta.** `GET /dashboard`: pendências + atenção (token/sem-análise-recente/grade
  C-D/pendência) + atividade recente (tool_calls cross-conta via coalesce+LEFT JOIN → inclui chat) +
  panorama (grade datada via DISTINCT ON + KPIs ao vivo em lote + as-of).
- **6a-5 — Timeline por conta.** `GET /accounts/:id/timeline`: união discriminada ABERTA (extensível p/
  Fatia 7) + paginada + filtros; híbrido expansível (run carrega recomendações aninhadas); runs+ações+
  aprovações; blocked→rejected.
- **6a-6 — `ui-timeline` + router-tabs.** Diretivas de route-tabs vendorizadas (só as de rota, puras) +
  `ui-timeline` presentacional (agrupa por dia, expansível), VM próprio (desacoplado da API).
- **6a-7 — Detalhe da conta em abas.** `AccountShell` (cabeçalho + tabs + outlet) + `AccountContextStore`
  (scoped à rota) + `AccountOverview` (análise + mini-surface + faixa ao vivo) + `AccountTimeline`. Config
  do agente vira aba; barra sticky some; Analisar/Pausar sobem pro cabeçalho.
- **6a-8 — Painel (home).** `/` → Painel; nav "Painel"; 4 widgets; refresh por-conta + lazy on-view;
  estados positivos/quietos; 0 contas → onboarding.
- **6a-9 — Docs + ROADMAP.** `docs/validacao-manual-6a.md` + este registro.

**Sem migration** (Timeline/Painel = read-only; frescura = env). **as-of** = `max(updated_at)` dos
snapshots. **4 gatilhos, 1 caminho de sync, 1 porta de staleness** (análise inline + sweep + lazy + botão).

**Fast-follows da 6a:**
- **Aba "Conexões"** do detalhe (token/recolar + contato WhatsApp + modo) — o shell de abas já suporta.
- **Cadência de sync por-conta** (hoje global via env) + sweep cobrir agente **pausado** (hoje lazy cobre).
- **"> 2× cadência" no `no_recent_run`** (hoje 48h fixo) + tuning dos thresholds de atenção.
- **Bust do `MetaEntityCache` no "atualizar agora"** — adiado: nenhuma superfície ao vivo mostra status/
  budget de entidade na 6a (só insights); reintroduzir quando exibir estado de entidade ao vivo.
- **Frescura no TEXTO da análise** (recomendação pode citar estado de até ~30min; a escrita já é protegida).
- **Widget "próxima análise agendada"** (hoje "última análise há Xh"; falta getter de next-fire/parse cron).
- **`audit_log` na Timeline** (v1 = runs+tool_calls+approvals) + **Timeline cross-conta** (v1 = per-conta
  + atividade compacta no Painel) + **paginação real por UNION** (v1 = cap por fonte + merge em memória).
- **Botão global "atualizar tudo"** no Painel (v1 = refresh só por-conta).
- **Trimar o header próprio da config** dentro da aba Agente (hoje ainda renderiza o seu).
- **Conta ativa sem atividade re-enfileira sync todo threshold** — sync que grava 0 linhas não bumpa
  `updated_at` → `shouldSync` fica sempre `true` (deduped/governado, mas gasta 1 chamada Meta/threshold em
  conta morta). Marcar "última tentativa" p/ evitar.
- **Piso no stagger do sweep quando `ANALYSIS_CRON_JITTER_MS=0`** (hoje `step=0` = todas de uma vez; o
  governor mitiga, mas vale um piso) + `BadgeTone` exportado (hoje o tom do badge empresta `TimelineTone`)
  + not-found consistente na Timeline (retorna vazio vs 404 nas outras).

## Fatia 6b — Prontidão pra beta real (recortada — entregue)

O que destrava **colocar gente real** com responsabilidade: quem entra, o que veem, e não cair/
perder dado. Espelha o padrão de email+auth do `automato-api` (SES). Entregue em 8 sub-slices:

- **6b-1 — Ops safety + higiene.** Shutdown gracioso da API (SIGTERM → `app.close` + fecha pool/Redis);
  `/health` = liveness estático (probe de restart) + **`/ready`** novo checa DB/Redis (503 sem loop);
  API respeita `LOG_LEVEL`; `.env.example` sem mojibake; `EASYPANEL.md` sem vars mortas
  (`BETA_ADMIN_SECRET`/`FATIA0_*`); CI ganha `build` do web.
- **6b-2 — Infra de email.** `MailerPort` (entrega) + `MailQueuePort` (enfileira) + fila `core.mail`
  (retry 5x) + worker consumidor. Adapter **`@trafego/mailer`** (drivers `ses`/`console`/`misconfigured`).
  **Split**: API só enfileira (sem SDK SES no bundle); só o worker entrega. `JobSpec` ganhou
  `attempts`/`backoffMs`.
- **6b-3 — Verificação de email.** `one_time_tokens` (OTP 6-díg, hash `email:code`, uso único) +
  `users.email_verified_at`. Signup **não autentica** (`pendingVerification`); `email-code/request|verify`;
  login não-verificado → 403 `auth_email_not_verified` + reenvia; força de senha (core puro); anti-enum.
- **6b-4 — Reset de senha.** `forgot-password` (204 anti-enum) + `reset-password` (token-link, revoga
  todas as outras sessões; valida força antes de consumir).
- **6b-5 — Gate de beta.** `requireActiveAccess` (API, por usuário/email) + `skipped_access` no cron
  (por owner da org) + CLI `access:grant|revoke|list` (grant → email de liberação) + `backfill:access`
  one-time (grandfather pré-6b — não trancar o dono).
- **6b-6 — Billing owner.** `GET /billing/costs`: total + byType + **por conta** (rollup
  usage_events→agent_runs→agents→ad_accounts; chat/`run_id null` = não-atribuído) + gasto vs cap.
  Índice `usage_events.created_at`.
- **6b-7 — Frontend auth.** Telas de código, forgot/reset, **muro `/acesso-pendente`** + `activeAccessGuard`
  no shell; login trata 403 (não-verificado → código; pendente → muro); interceptor 403 `access_pending`.
- **6b-8 — Frontend billing.** Tela **Custos** (owner-only): custo por conta/período + gasto vs cap;
  deixa claro que é COGS, não preço.

**Provider de email = AWS SES (SESv2)**, produção em `sa-east-1` (domínios verificados `msg.automato.pro`);
IAM `trafego-ses-mailer` escopado a `ses:SendEmail`. **Migrations:** `0017` (one_time_tokens +
email_verified_at) · `0018` (índice created_at). **Backfill = script one-time** (não migration, não boot).

**Fast-follows da 6b (registrados):**
- **Backup Postgres = ops no painel EasyPanel** (agendado + alvo offsite/S3) + restore documentado
  (runbook em `docker/EASYPANEL.md`) — **checklist pré-go-live obrigatório** (não é código).
- Prune de insights (DELETE > retenção); token-190 proativo (`/debug_token` + `appsecret_proof`) +
  aviso de token inválido por WhatsApp; governor na escrita (retry/backoff) + token-bucket Lua + Batch API;
  Langfuse (tracing LLM).
- **eslint + `lint` no CI** — hoje `eslint` não está instalado (todo pacote tem `lint: eslint src` mas sem
  a dep); `pnpm lint` quebra → instalar eslint + flat config + corrigir violações + ligar no CI.
- **Endurecer OTP de verificação** (nits do reviewer 6b): cap de tentativas por código/conta (hoje só
  rate-limit por-IP 10/min + TTL 15min); tratar colisão de `token_hash` de OTP (prob ~1e-6 → hoje pode dar
  500 no reenvio) com `onConflictDoNothing`/regenerar; `CREATE INDEX CONCURRENTLY` em `usage_events` quando
  a tabela crescer; fechar pool `pg` nos scripts CLI; `access:grant` re-rodado re-enfileira email (tornar
  o email não-fatal).
- Login passwordless; perfil editável + trocar senha logado + "revogar todas as sessões" explícito;
  org-switcher; convite/adicionar membro (N:N — `membership_invitations`); split entitlement-org × acesso-usuário.
- Billing pro cliente (uso sem COGS) + markup/BRL/Stripe + custo por série temporal + visão super-admin;
  billing owner-only enforçado no backend (hoje só nav esconde); backup via script + `StoragePort`;
  domínio de email próprio do produto + IAM não-root; health endpoint do worker; prune de orgs órfãs.

## Comunicação WhatsApp — fluidez + percepção de valor + proatividade (entregue)

Melhoria da comunicação do agente no WhatsApp: parecer conversa humana no padrão do canal e liderar pela percepção de valor. Fatiado (F1→F4) — **entregue por completo**.

**Entregue:**
- **F1 — fluidez de entrega (determinística, independe do modelo):** `sanitizeWhatsappText` (core: `**`→`*`, títulos, bullets estritos, links, tachado; idempotente) + split por **fronteira natural** (parágrafo→frase, nunca corta frase; `WHATSAPP_SOFT_MAX_CHARS`~600; cap 5) + porta neutra `typingHintMs` traduzida a `presence:composing`+`delay` **só no adapter** Evolution + orquestração em `send-to-contact` (sanitiza→split→"digitando…" proporcional por balão).
- **F2 — robustez:** `deliverReply` isola o envio do chat — queda da Evolution não relança o grafo (não re-gasta LLM).
- **F3 — valor no chat:** `get_account_status` expõe o `waste`/tier (já persistidos no `metrics_snapshot`); `chatRules` lidera pelo dinheiro/veredito.
- **F4a — config:** `NotifyPolicy` (pulse/alerts/runPush) + coluna `agents.notify_policy` (default conservador) + defaults semeados por arquétipo.
- **F4b — pulso:** scheduler `pulse:{id}` (cadência própria) + worker que resume do último run (`composePulseOverview`, sem rerun) com **dedupe** (não cola no push).
- **F4c — alerta:** `detectMaterialChange` (core, D-1 fechado vs baseline; temporal, complementa o cross-sectional `detectAnomalies`) + gate barato no `insights-sync` (throttle + política) → dispara run `trigger=signal` **dirigido** (o `SignalFinding` injeta no prompt do analista via `describeSignal`); a análise é a autoridade (falso positivo → silêncio).
- **F4d — controle por chat + site.** `resolveAgentConfigChange` (core) ganha `notifyPolicy` (leaf-merge via `NotifyPolicyPatch` flat, mesmo padrão de `GuardrailConfigPatch`); eco determinístico em PT. Chat: tool `set_notifications` no Grafo B (eco+confirma, gated pelo kill-switch `autoConfigViaChat`), traduzida pra `configPatchFromToolCall` — flui pelo pipeline genérico de config, sem tocar em `nodes.ts`. Site: `agentConfigInput`/`agentSummary` ganham `notifyPolicy` (DTO por sub-objeto pulse/alerts/runPush), novo componente `AgentNotifications` (Angular, mesmo padrão self-contained de `AgentAutonomy`/`AgentGuardrails`) na superfície `/accounts/:id/agente`, logo após a cadência da análise. De quebra, fechou uma lacuna real da F4a: `defaultNotifyPolicy` do arquétipo nunca era aplicado (nem na criação do agente nem no reseed) — agora a criação semeia e o `reseedArchetypeChange` reseta `notifyPolicy` pro arquétipo escolhido (mesma semântica incondicional da autonomia).

**Fast-follows registrados:**
- **Reenvio idempotente/outbox do chat** — F2 só isola o envio; persistir a resposta e reenviar quando a Evolution volta fica adiado.
- **Outbound em fila dedicada** — o `delay` nativo da Evolution bloqueia a request; mover envio p/ worker/fila própria se o volume crescer.
- **Alerta intradiário** — a detecção é D-1 (atribuição do Meta incompleta no dia corrente); checagem no mesmo dia (granularidade hora) fica adiada. Intradiário de lançamento é coberto pelo cron 2×/dia + "analisa agora".
- **Modo silencioso / teto global de proatividade** — controle único p/ conter pulso+push+alerta por conta/dia.
- **Editor de cadência compartilhado (web)** — o editor de `CadenceSpec` (kind/hour/weekday/cron) hoje existe 2× (cadência da análise em `agent-config-page.ts`, cadência do pulso em `agent-notifications.ts`), cada um com sua cópia de `HOUR_OPTIONS`/`WEEKDAY_OPTIONS`. Extrair um componente `app-cadence-editor` reusável em `shared/ui` quando aparecer o 3º uso (§13 reuso-primeiro).
- **Dedupe do alerta no fuso da org** — o piso de "≤1/dia" do throttle é em UTC (alinhado ao módulo); na virada de meia-noite UTC pode escapar 1 alerta extra. Ancorar no fuso da org.
- **Pulso: disparar run quando o último é velho** — hoje o pulso cala (`skipped_stale`) se o último run `succeeded` passa de 48h; alternativa é disparar um run leve p/ ter dado fresco.
- **Backfill do `notify_policy` por arquétipo** nos agentes já criados (hoje ficam no default de coluna).
- **Troca do modelo do chat** (`CONVERSATION_MODEL`) por custo-benefício, com validação de tool-calling; **tetos de fluidez via env** (hoje const nomeadas: `WHATSAPP_SOFT_MAX_CHARS`, `TYPING_*`).

## Agente em grupo do WhatsApp (entregue)

**Segunda superfície simétrica à DM:** a org configura **um grupo** (espelho do número —
`channel_groups`, 1 por org) onde o agente atua **por completo** (proativo + leitura +
escrita + aprovação + config), reusando ao máximo a máquina já existente do chat 1:1 em
vez de duplicar lógica. Fatiado (G0→G4) — **entregue por completo**.

**Entregue:**
- **G0 — schema + parse:** `channel_groups` (espelho de `channel_instances`, `unique(org_id)`)
  + `conversations.{group_id, participant_phone}`. `parseInbound` processa mensagem de
  grupo (`@g.us`): `from` = telefone do `participant` (não mais descartado), envelope
  `group?` neutro (`groupJid`, `senderPhone`, `mentionedPhones`, `quotedAuthorPhone`) em
  `InboundMessageBase`, ortogonal ao `kind` (texto/áudio).
- **G1 — reativo (leitura/escrita/aprovação/config):** `ConversationRef` (`{kind:"contact"}`
  ou `{kind:"group", groupId, participantPhone}`) substitui `contactId` em todo o pipeline
  de conversa (`webhook-inbound` → `turn` → `tools`/`nodes` → outbound). Grupo precisa
  estar registrado+ativo; **sem verificação de membro** (a adesão ao grupo é a fronteira
  de confiança — diferente do DM). Só processa se **dirigido** (`isAddressedToBot`, puro:
  @menção OU reply à msg do bot, comparado ao telefone da instância); não-dirigido ignora
  e **não persistia** por padrão (`TRAFEGO_GROUP_INGEST_CONTEXT` — no **G7** virou default ON
  + kill-switch de plataforma; ver G7 abaixo). Thread **por-(grupo,participante)** — reuso *verbatim* do
  concierge/`set_focus`/foco da DM (todas as contas da org) dá "só o iniciador confirma" e
  foco por participante **de graça**, sem lógica nova. Áudio em grupo funciona igual (a
  Evolution exige `participant` na key de mídia de grupo — `MediaMessageKey.participant`).
- **G4 — registro:** porta `listGroups` (Evolution `group/fetchAllGroups?getParticipants=false`)
  + slice `groups` na API (`GET/PUT/DELETE /channels/group(s)`, upsert por org) + passo 3
  na tela de WhatsApp (lista buscável, gated por número conectado, avisos de consentimento
  — "qualquer pessoa no grupo poderá pedir análise/aprovar/mudar config", "avisos migram
  pro grupo", recomendado pra time interno/1 cliente por ora).
- **G2 — proatividade org-level:** `NotifyRepo.loadTarget` resolve o grupo **ativo** da org
  primeiro (thread de **broadcast**, `participantPhone: null` — `isNull()` no lookup, já
  que `eq()` nunca casa NULL); sem grupo, cai no contato DM verificado (mesmo método,
  reusado por cron/signal/pulso). Configurar o grupo **migra** a proatividade do DM pro
  grupo (roteamento único, sem vínculo conta↔grupo — o grupo varre todas as contas, igual
  à DM). `send-to-contact.ts` generaliza p/ `createSendToConversation(ref)` (dispatch
  DM×grupo); `createSendToContact` vira atalho fino p/ os últimos callers DM-only.
- **G3 — hardening:** invariantes confirmadas **por construção** (thread isolada por
  participante) + testadas explicitamente: cross-participante não confirma escrita alheia;
  eco nomeia a conta (`ctx.multiAccount`/`accountName`, org-level, já reusado); foco por
  participante (`set_focus` grava em `conversations.focused_account_id` chaveado por
  `conversationId`); aprovação por id / guardrail / kill-switch `autoConfigViaChat` não
  gateiam por contato — já corretos sem mudança.
- **G6 — endereçamento por LID (grupo migrado, `addressingMode: "lid"`):** confirmado em
  produção que a Evolution manda `contextInfo` (menção/reply) como irmão de `message` em
  `data`, não aninhado (`parseInbound` corrigido); em grupo LID, `key.participant` é um id
  opaco (não telefone) — `senderPhone` passa a preferir `key.participantAlt` (telefone real
  do remetente, revelado só de quem manda). Terceiro mencionado/citado só por LID (sem alt
  no payload) resolve via `resolveGroupParticipants` (`group/fetchAllGroups?getParticipants=true`
  expõe `{id: lid, phoneNumber}` por participante), cacheado (Redis, `GROUP_PARTICIPANTS_CACHE_TTL_SEC`)
  e chamado só quando há LID não resolvido (maioria das mensagens de grupo não menciona
  ninguém — não bate na Evolution à toa).

- **G7 — Contexto de grupo (transcript ambiente) + foco endurecido:** mensagens NÃO-dirigidas
  do grupo passam a ser ingeridas como CONTEXTO (tabela dedicada `group_messages`, sem fabricar
  conversa) e injetadas read-only no system prompt do turno dirigido (função pura
  `buildGroupTranscript`: mescla ambiente + dirigidas, janela por contagem/tempo/tokens,
  atribuição por pushName, datas UTC), group-only (DM intocada). `GROUP_RULES` adiciona
  grounding da conta, resolução por ambiente sob confirm, honestidade de mídia e integração
  suave (anti-vigilância). **Fix do footgun `set_focus`** (muta o `ctx` no mesmo turno →
  troca de conta seamless). **Staleness do foco** (último uso > `CONVERSATION_FOCUS_TTL_HOURS`
  perde precedência; DM + grupo). **Always-bind de leitura** em grupo multi-conta (a 1ª
  pergunta resolve num turno; self-guard sem foco). **Retenção/LGPD:** on-by-default silencioso
  (decisão do dono), retenção `GROUP_CONTEXT_RETENTION_DAYS` (~90d) + purge diário;
  `TRAFEGO_GROUP_INGEST_CONTEXT` vira kill-switch de plataforma.

**Fast-follows registrados:**
- **N integrações WhatsApp / número-por-agente (isolamento de ban) + escopo/granularidade
  de contas por-grupo + multi-grupo por org** — bundle único: só com N números faz sentido
  cada grupo escopar suas próprias contas (hoje, com 1 número, o grupo varre todas as
  contas da org — seguro pra time interno/1 cliente, não pra agência multi-cliente com
  gente de fora no grupo).
- **Permissão granular por-pessoa no grupo** (limitar quem faz escrita/config — hoje
  qualquer membro pode).
- **Rate-limit por-participante** no grupo (conter abuso/custo LLM de um membro).
- **Config fina de destino de proatividade** (dm/grupo/ambos por-tipo — pulso/alerta/push
  cada um, em vez do move org-level atual).
- **Auto-registro de grupo na 1ª menção**; **convite/entrada automática** no grupo (hoje a
  org adiciona o bot manualmente).
- **`OutboundTarget` união** (refinar `toIsGroup: boolean`) se surgir um 3º tipo de destino.
- Taggear pessoas no outbound; janela temporal de conversa (alternativa ao reply p/ manter
  o "dirigido" ativo por alguns minutos).

**Fast-follows do contexto de grupo (G7):**
- **Bot outbound no transcript** (hoje o transcript = ambiente + dirigidas inbound; as respostas
  do bot ficam de fora p/ evitar ruído de avisos de cortesia — incluir com filtro de `meta.kind`).
- **Dedup "excluir as próprias linhas"** do transcript (hoje o 1º corte aceita a leve
  sobreposição com o `state.messages` do participante).
- **Tool `get_group_context`** p/ lookback profundo sob demanda (complementa a janela sempre-injetada).
- **Bind de ESCRITA com enforcement call-time** em grupo multi-conta → escrita no 1º turno sem
  foco prévio também num turno só (hoje a leitura já resolve; escrita-1º-turno segue barra-e-repete).
- **Controle org-facing do ingest** (ligar/desligar pela org — hoje só kill-switch de plataforma).
- **Aviso de transparência** no grupo (opt-in futuro — hoje on-by-default silencioso, decisão do dono).
- **Timezone-aware** no display do transcript — **ENTREGUE** junto do fix geral de fuso: datas de
  "hoje"/janela passam a usar `orgs.timezone` (não UTC) em `get_fresh_metrics`/`get_metrics`/`compare`/
  `entity`, análise, sync, alerts e dashboard, via `packages/core/src/time` (`todayInTz`/`daysAgoInTz`/
  `startOfDayInTz`) + `loadOrgTimezone` (`packages/db`). Raiz: à noite BRT o "hoje" em UTC virava o dia
  seguinte e a janela errava o snapshot. **Follow-up:** fuso da CONTA Meta (quando ≠ org); **billing**
  (day-bucketing de `usage_events` ainda em UTC).
- **Semântica de foco por "setagem"** foi descartada em favor de "último uso" (entregue no G7).
- **Corrida de tool-calls paralelos** (`set_focus` + read no mesmo passo → a read pega o foco
  velho): hoje mitigado por orientação na descrição da tool (chamar isolada). Fix robusto =
  `set_focus` retornar um `Command` que atualize o estado antes das reads concorrentes.
- **Metering ignora staleness do foco** (`contextAdAccountId` lê `focusedAccountId` cru): um
  foco stale (que o turno já tratou como concierge) ainda atribui custo à conta stale.
- **Retenção assimétrica**: o purge cobre só `group_messages` (ambiente); as mensagens de grupo
  DIRIGIDAS ao bot (em `messages`, com pushName de terceiro no meta) não têm retenção dedicada.
- **`configViaChat` fica stale** após `set_focus` mutar de conta (só afeta a precisão do
  `describe_capabilities` no mesmo turno; sem brecha de config).
- **"foca na B e pausa a X" no mesmo passo**: o batch é roteado ao `confirm` e o `set_focus` não
  executa (o foco não muda) — money-safe (age no foco vigente), mas o "foca na B" some sem ack.

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

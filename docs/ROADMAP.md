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

**Marcos:** `3a` valida a hipótese; **beta read-only abre após `3b`** e roda em paralelo; escrita só a partir de `5a`, sempre atrás de guardrail; "mexer em qualquer coisa" (`5c`) = tools do catálogo (núcleo no MVP: pausar/budget/status; amplia por extensão; **criar campanha = Fatia 7** (pós-MVP, ver abaixo)).

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
- OAuth oficial Meta + App Review (sai do System User token colado).
- Checagem proativa de escopos (`/debug_token`) + `appsecret_proof` — reintroduz `META_APP_ID`/`META_APP_SECRET` (removidos no onboarding token-only da 1b).
- WhatsApp **Cloud API** / pool de números (sai do Evolution não-oficial).
- Google / TikTok Ads = **novo adapter** atrás de `AdsPlatformPort` (core intocado).

**Billing**
- Stripe: mensalidade + custo por uso (markup sobre `usage_events`).

**Governor / escala (Fatia 2)**
- Token-bucket Lua (EVALSHA) no `acquire` (controle proativo) + Batch API (≤50/HTTP) — quando o volume exigir (hoje = mínimo-correto reativo).
- Tuning do `CUSTOM_CONVERSIONS_CACHE_TTL_SEC` conforme a cadência de cron real.

**Dados / análise (Fatia 2)**
- Tabela `ad_entities` (histórico de nome/status/budget) — quando a UI (3/4) pedir timeline; hoje entidades são transientes.
- Backfill histórico sob demanda (range explícito, isento da retenção) — analisar lançamento antigo.
- Score composto no `rankAndSelect` (gasto + delta vs baseline + severidade da flag).
- `currency_offset` exato no budget (moedas sem decimais; hoje ÷100, correto p/ BRL/USD).
- Revisar o cap AEM (8 eventos/domínio) se a análise passar a depender de eventos priorizados.
- Expandir o `meta-conversion-map` conforme novas contas reais surgirem (o whitelist só conta conversões reconhecidas; `rawActions` guarda o cru como rede de segurança p/ re-derivar).

**Produto / config**
- Modo **lançamento × manutenção** como preset de arquétipo.
- ACL por conta (RBAC granular) — hoje owner/member org-wide.
- Multi-agente por `ad_account` (hoje 1:1).
- Multi-conta na seleção do onboarding (multi-select) + possível `meta_connections` normalizado.

**Infra / DX**
- Pacote `@automato/design-system` compartilhado.
- Web em serviço estático dedicado (nginx/Caddy) quando o tráfego justificar.

**Flagship pós-MVP:** criação de campanhas no WhatsApp — detalhada abaixo (Fatia 7).

## Fatia 7 — Criação de campanhas (roadmap pós-MVP)

**Visão "gestor completo no WhatsApp":** o agente também **cria** campanhas — a pedido ou proativo. Só depois do MVP de otimização validar. Arquitetura já antecipa (catálogo de tools + `AdsPlatformPort` + porta nova de storage). **Depende:** MVP validado (pós-beta) + `5a`/`5b` (write path + HITL) + catálogo de tools.

- **7a — Biblioteca de criativos + intake:** `StoragePort` (S3-compat) + Creative Library (upload web + **mídia inbound no WhatsApp** + reuse de vencedores da conta) + upload pra Meta (`image_hash`/`video_id`) + capturar **Page** do cliente (`listPages`, escopo `pages_show_list`).
- **7b — Rascunho de campanha + criação:** tools `createCampaign/AdSet/Ad`; agente monta **draft** (objetivo + budget + targeting + placement + criativo + **copy gerada pelo LLM**, configurável); **aprovação obrigatória do draft** (default — cria gasto novo; eco completo) + **guardrail de budget novo**; criação idempotente.
- **7c — Criação proativa + conversacional:** agente **propõe** nova campanha pelo que observou (ex: criativo saturado → testar novo ângulo); "cria uma campanha…" no chat (Grafo B). Gate **personalizável** (default = aprovação).
- **Fora até da 7 inicial:** **geração de criativo por IA** (imagem/vídeo) = fase mais tardia. Copy por LLM já entra.

**Design das telas/fluxos** (Creative Library, card de aprovação de rascunho, intake de mídia WhatsApp) = ver `DESIGN.md`.

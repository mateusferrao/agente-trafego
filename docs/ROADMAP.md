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
| **2a** | Meta read + governor | Entidades + insights async + criativos; governor mín; snapshots+incremental | 1b |
| **2b** | AccountBrief (core puro) | Curadoria pura: totals+rank/select top-N+agregados+tendência | 2a |
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

## Fatia 7 — Criação de campanhas (roadmap pós-MVP)

**Visão "gestor completo no WhatsApp":** o agente também **cria** campanhas — a pedido ou proativo. Só depois do MVP de otimização validar. Arquitetura já antecipa (catálogo de tools + `AdsPlatformPort` + porta nova de storage). **Depende:** MVP validado (pós-beta) + `5a`/`5b` (write path + HITL) + catálogo de tools.

- **7a — Biblioteca de criativos + intake:** `StoragePort` (S3-compat) + Creative Library (upload web + **mídia inbound no WhatsApp** + reuse de vencedores da conta) + upload pra Meta (`image_hash`/`video_id`) + capturar **Page** do cliente (`listPages`, escopo `pages_show_list`).
- **7b — Rascunho de campanha + criação:** tools `createCampaign/AdSet/Ad`; agente monta **draft** (objetivo + budget + targeting + placement + criativo + **copy gerada pelo LLM**, configurável); **aprovação obrigatória do draft** (default — cria gasto novo; eco completo) + **guardrail de budget novo**; criação idempotente.
- **7c — Criação proativa + conversacional:** agente **propõe** nova campanha pelo que observou (ex: criativo saturado → testar novo ângulo); "cria uma campanha…" no chat (Grafo B). Gate **personalizável** (default = aprovação).
- **Fora até da 7 inicial:** **geração de criativo por IA** (imagem/vídeo) = fase mais tardia. Copy por LLM já entra.

**Design das telas/fluxos** (Creative Library, card de aprovação de rascunho, intake de mídia WhatsApp) = ver `DESIGN.md`.

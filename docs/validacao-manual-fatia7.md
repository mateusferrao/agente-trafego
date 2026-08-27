# Validação manual — Fatia 7 (criação de campanhas, escala/duplicação, copy IA, proativo)

Roteiro completo (caminhos felizes + estressando os tristes) das capacidades de **gasto novo**
do Roi: escalar vencedores, criar campanhas do zero e gerar copy — via **WhatsApp**, **site** e
**proativo**. Sempre sob **eco+confirma + guardrail de gasto novo**; criação nunca auto-aplica
(default aprovação; afrouxável com alerta).

## Pré-requisitos

- Stack local de pé: `docker compose -f docker/docker-compose.yml up -d` (postgres+redis) + `pnpm dev` (api+worker+web).
- Migrations aplicadas: `pnpm db:migrate` (0036/0037 — `campaign_drafts`, `creative_assets`, `approvals.draft_id`, colunas de gasto novo).
- 1 org beta + 1 conta Meta conectada. Para os **caminhos felizes reais**: **BM Automato** com **1 estrutura PAUSADA** (campanha→adset→anúncio + criativo + Page + Pixel) como fonte — "nenhuma campanha ativa" continua válido.
- **Modo ensaio (dry-run) LIGADO** por default (guardrail) — a saga simula sem tocar a Meta. Desligue só para o smoke real (abaixo).

---

## 1. Escalar vencedor — CHAT (WhatsApp)

### 1.1 Caminho feliz — passo pequeno (ABO, ≤ teto) → sobe budget
1. Rode uma análise (`analisa agora`) na conta com a fonte pausada — garante um `winner` em `entity_analyses`.
2. No WhatsApp: **"escala meu vencedor"**.
3. **Esperado:** eco determinístico "Vou escalar subindo o budget: … +X%. Confirma?" (X ≤ teto de mudança de budget). Responda **"sim"**.
4. **Esperado:** aplica inline (é `adjust_budget`, caminho existente) → confirma na conversa. Em dry-run: "🧪 Simulei".

### 1.2 Caminho feliz — passo agressivo (ABO, > teto) → duplica
1. Config: suba o **passo de escala** (Limites de criação) para 50% e o teto de mudança de budget para 20%.
2. WhatsApp: **"escala meu vencedor"**.
3. **Esperado:** eco "Vou duplicar o vencedor '…' com mais budget … R$Y/dia · entra ativa. Confirma?". **"sim"**.
4. **Esperado:** "Beleza, tô criando — te aviso quando ficar pronto 🚀". Em seguida push do desfecho ("✅ Criado" / "🧪 Simulei"). No **site**, o rascunho aparece em Aprovações → some após aprovar; Timeline registra `campaign_draft_proposed` + `campaign_created`.

### 1.3 CBO → sobe budget da campanha
- Fonte com budget na **campanha** (CBO). "escala meu vencedor" → eco explica que sobe o budget da campanha (não duplica). Confirma → aplica.

### 1.4 Caminhos tristes
- **Sem vencedor** (conta nova, sem análise): "escala meu vencedor" → "não achei um vencedor claro na última análise — roda a análise primeiro". Nada criado.
- **Recusar:** responda "não" ao eco → "Ok, não mexi em nada." Rascunho não vira criação (expira em 24h).
- **Guardrail de gasto novo:** baixe `maxNewDailyBudget` abaixo do budget escalado → ao aprovar, a saga barra → "Não criei: … teto de gasto novo". Rascunho `failed`.
- **Kill-switch ligado:** aprovar → barrado.

---

## 2. Criar do zero — CHAT (WhatsApp)

### 2.1 Caminho feliz (reusa criativo + Page/Pixel inferidos + copy IA)
1. WhatsApp: **"cria uma campanha de venda"**.
2. **Esperado:** eco "Vou criar uma campanha de purchase reusando seu criativo campeão e 2 variações de copy novas. Gasto novo: R$Z/dia · Página: <id> · Pixel: <id> · entra ativa. Confirma?". **"sim"**.
3. **Esperado:** "tô criando…" → push do desfecho. Site: rascunho no inbox (card Brand com estrutura + copy + budget + Página/Pixel) + Timeline `campaign_created`. Em conta de teste real: campanha `PENDING_REVIEW` PAUSED/ACTIVE.

### 2.2 Caminhos tristes
- **Conta sem anúncio** (nada pra inferir Page/criativo): "cria uma campanha" → "essa conta ainda não tem um anúncio de onde eu reusar a página e o criativo — me manda um criativo…". Bloqueado (empty-state claro), nada criado.
- **Objetivo ambíguo:** "cria uma campanha" (sem objetivo) → usa o objetivo inferido/da meta; o eco declara qual (confirme antes).

---

## 3. Escalar / rascunho — SITE

1. Aprovações (`/approvals`): rascunhos propostos (chat/proativo) aparecem na seção **"Rascunhos de campanha"** (card Brand): kind, objetivo, **gasto novo destacado**, Página/Pixel, copy, origem.
2. **Aprovar** → "Enviado para criação…" → some da lista; worker cria (saga) → Timeline `campaign_created`.
3. **Recusar** → "Rascunho descartado"; nada criado.
4. Mesma verdade nos dois canais (invariante 12): um rascunho proposto no chat aparece igual no site.

---

## 4. Proativo (criação por conta própria)

1. Config → Notificações → ligue **"propor campanhas por conta própria"** (ou use arquétipo Otimizador/Vigia, já ON).
2. Rode uma análise numa conta com `winner` no teto (ou sem campanha ativa → cold_start).
3. **Esperado:** o run cria um rascunho **proativo** → aparece como **recomendação** (kind platform_action, "Escalar seu vencedor"/"Criar uma campanha nova") na análise **e** no inbox de rascunhos, **rotulado "proposta do Roi" + o porquê** (rationale honesto). Nudge no WhatsApp.
4. **Throttle:** no máx **1 rascunho proativo pendente/conta** — um 2º run não cria outro enquanto houver pendente.
5. **Nunca auto-aplica:** o rascunho fica pendente até você aprovar (mesmo com autonomia alta).

---

## 5. Config (controles)

- **Limites de criação** (Segurança/guardrails): budget novo/dia, máx. campanhas novas/dia, passo de escala — salvar reflete no guardrail (teste barrando em §1.4).
- **Proativo** (Notificações): toggle liga/desliga o §4.
- **Modo ensaio (dry-run):** com ON, toda criação SIMULA (não toca a Meta) — valide todos os fluxos acima em dry-run primeiro.

---

## 6. Smoke REAL no BM Automato (validar contrato Meta — as 3 pendências)

> ⚠️ Cria entidades REAIS na Meta. Fazer **só** no BM Automato, **PAUSED**, e **reverter logo em seguida**.

1. Desligue o **dry-run** no agente da conta BM Automato.
2. Garanta a fonte pausada (campanha→adset→anúncio + criativo + Page + Pixel).
3. **Duplicar:** "escala o vencedor" (passo > teto) → aprovar → confere na Meta: adset copiado com budget +X%, **PAUSED**, `ad_object_ids` criados.
4. **Criar do zero:** "cria uma campanha de venda reusando o criativo X" → aprovar → confere: `/campaigns`→`/adsets`(promoted_object+optimization_goal+billing_event)→`/adcreatives`(object_story_spec.page_id)→`/ads`, todos **PENDING_REVIEW**.
5. **Reverter tudo:** `find_recent_actions` + desfazer no chat (pausa as criadas) **e/ou** pausar+deletar manualmente no Ads Manager as entidades criadas (via `created_ids` na timeline/audit).
6. Validar no **Graph API Explorer v26** as pendências: matriz objective↔optimization_goal↔billing_event; `custom_conversion_id`; polling do job async de `/copies` (deep_copy >3 filhos).

---

## 7. Checklist de transparência (invariante 12)

- [ ] Eco descreve tudo antes de criar: o quê (campanha/adset/N anúncios), quanto (budget/dia), por qual Página, qual Pixel/evento, ativa ou pausada — jargão traduzido.
- [ ] Proposta proativa vem rotulada como sugestão + o porquê (nunca comando disfarçado).
- [ ] Bloqueio de guardrail explica o limite que bateu + o que fazer.
- [ ] Estados visíveis e iguais nos dois canais: proposto → criando → criada (ou falhou com motivo).
- [ ] `describe_capabilities` declara honesto: cria/escala/gera copy (sempre com aprovação) e o que ainda não faz (editar criativo, gerar imagem/vídeo).
- [ ] Zona sóbria (dinheiro/gasto novo): sem tom lúdico; copy encaminhável (guardrail B2B).

# Exemplos funcionais — Aprendizado contínuo v3 (um por caminho)

Cada exemplo mostra: **métricas da conta ao longo do tempo → função executada → o que foi
identificado → a lição/efeito gerado (com a confiança calculada de verdade) → onde aparece → o que
o usuário faz**. Os números de confiança seguem exatamente `computeConfidence`
(`packages/core/src/learning/index.ts`) e `temporalConfidence`
(`packages/core/src/learning/temporal.ts`).

> **A tese da v3:** o agente aprende só o **não-derivável**, destilado a **nível de conta**. Não
> há mais aprendizado observacional por-entidade (zumbi/fadiga por campanha) — isso era redundante
> com a análise, que já recalcula e recomenda a cada run. O aprendizado de conta que vale vem de
> **outcome MEDIDO** repetido em **≥ K entidades distintas**, de **padrão temporal** do histórico,
> ou da **ressalva de tracking** recorrente.

## Régua de confiança (vale para todos os exemplos)

`computeConfidence` aproxima a confiança de um teto, com ganho decrescente:
`nova = base + (teto − base) × 0,5 × força`.

- **Teto observacional** = `0,60` · **teto medido (ação nossa)** = `0,85` · **confirmação humana** = `0,90`.
- **Selo (tier):** `< 0,5` → **explorando** · `0,5–0,85` → **provável** · `≥ 0,85` ou confirmado por humano → **confirmado**.
- **Entra no texto do analista (prompt)** só com `≥ 0,70` **ou** confirmado; abaixo disso influencia em silêncio pelo *guard*.
- **Prior de conta MEDIDO** (destilado do ledger): a confiança é dobrada uma vez **por entidade distinta** de suporte (força 1, teto 0,85). Com **3** entidades → `0,744` (entra no prompt); com **5** → `0,823` (cruza `THRESHOLD_PROPOSAL_CONFIDENCE = 0,80` e dispara a proposta de limiar).
- **Prior TEMPORAL** (`temporalConfidence`, teto `0,85`, ganho `0,6`): pontuado pela **força estatística** — um padrão apertado em 3 campanhas alcança `~0,80`; disperso fica baixo (só guard/explorando).

O ciclo roda no job `agent-learning` (`runTick`, default 06:00 diário) sobre cada conta ativa,
não-dormante e com o kill-switch de aprendizado ligado. Ordem por agente: **medir** (ações nossas +
mudanças manuais → ledger `learning_evidence`) → **destilar** (prior de conta do ledger + prior de
tracking do histórico + priors temporais da série) → **curadoria** (decaimento).

---

## Caminho 1 — Prior de CONTA a partir de cortes NOSSOS que deram certo (`account_cut_pays`)

**Métricas + ações ao longo do tempo.** Em três campanhas DIFERENTES, o agente recomendou reduzir
o orçamento; o usuário aprovou; a redução foi aplicada de verdade (`agent_tool_calls` com
`before_state`, não dry-run). Passada a janela, cada uma melhorou o custo por resultado da própria
entidade:

| Campanha | Ação nossa | CPA antes | CPA depois | Outcome medido |
|---|---|---|---|---|
| `Prospecção A` (id `44120`) | reduzir orçamento (10/08) | R$ 100 | R$ 40 | `positive` |
| `Prospecção B` (id `44121`) | reduzir orçamento (10/08) | R$ 120 | R$ 45 | `positive` |
| `Institucional C` (id `44122`) | reduzir orçamento (10/08) | R$ 90 | R$ 38 | `positive` |

**Função executada.** Para cada rec madura e não medida, `measureOutcomes → measureOne` chama
`computeOutcome` (efeito `budget_down` → mede a **entidade**, tolerância `0,15`): variação de CPA
< 0 → `positive`. Em vez de criar uma lição por-entidade (cortado na v3), `classifyOutcomeEvidence`
grava linhas de **evidência** no ledger: corte + positivo → `{ dimension: budget, direction: lower,
supports: true }`, uma por entidade (`source='our_action'`, dedupe por `rec:<id>:budget:lower`).

**O que identificou.** No mesmo tick, `distillAccount` lê o ledger e roda `distillAccountPriors`:
por `(budget, lower)` há **3 entidades distintas** de suporte (S=3), zero contra (O=0) → S ≥ K e
S > O → nasce o prior de conta.

**Lição gerada.** `agent_memory`: `scope='account'`, `dimension='budget'`, `direction='lower'`,
`origin='our_action'`, `semantic_key='account:budget:lower'`,
confiança = `dobra 3×(0 → 0,85, força 1)` = **0,744** → selo **provável**, **entra no prompt**.
Frase (ex.): *"Nesta conta, cortar desperdício cedo tende a compensar — foi o que aconteceu em 3
campanhas diferentes."*

**Onde aparece / o usuário.** Zona **"O que o agente já sabe"** (origem "a partir de uma ação
aplicada"). Confirmar imuniza do decaimento; esquecer arquiva. Se um alerta estiver ligado, o dono
recebe no WhatsApp: *"Aprendi algo novo sobre a conta: …"*.

**Contraste:** com só **2** entidades distintas, `distillAccountPriors` retorna vazio — **nada**
nasce (a barra de ≥ K é o que separa um padrão de conta de uma coincidência).

---

## Caminho 2 — Prior de CONTA a partir de MUDANÇA MANUAL do gestor (conta só-análise)

**Métricas + mudanças.** O gestor, **na mão dentro da Meta**, cortou o orçamento de três campanhas
distintas. O sync diário gravou dois `entity_config_snapshots` por campanha (queda ≥ 15%), e os
insights melhoraram depois. **Nenhuma ação nossa** nessas janelas.

**Função executada.** `measureManualChanges` pareia os snapshots (`loadMaturedConfigChanges`);
`manualChangeToAction` vê a queda ≥ 15% → ação sintética `adjust_budget/decrease`; antes,
`hasAppliedActionInRange` confirma que **não houve ação nossa** (senão seria do agente).
`computeOutcome` mede a entidade → `positive`; `classifyOutcomeEvidence` grava evidência
`{ budget, lower, supports:true }` com `source='human_manual'`.

**O que identificou / lição.** Com 3 entidades distintas no ledger, `distillAccount` materializa o
**mesmo** prior `account:budget:lower`. É assim que a conta que **só usa análise** aprende — o
gestor age, nós medimos. (O prior nasce `origin='our_action'` — é evidência medida; o `source` da
evidência no ledger é que registra que veio do gestor.)

**Onde aparece / o usuário.** Igual ao Caminho 1. Vale mesmo em conta que nunca aplicou uma ação
nossa.

---

## Caminho 3 — Prior AGRESSIVO de conta (`account_scale_pays`) — influencia o prompt, mas NUNCA propõe limiar

**Métricas + ações.** Em três adsets distintos com base sólida, o agente **aumentou** o orçamento e
o custo por resultado **se manteve/melhorou** (escalar compensou).

**Função executada.** `computeOutcome` (efeito `budget_up`) → `positive`; `classifyOutcomeEvidence`
para escala positiva grava **duas** linhas por entidade: sustenta `(pacing, raise)` e contradiz
`(pacing, lower)`. `distillAccountPriors` por `(pacing, raise)`: S=3 → nasce `account:pacing:raise`
(`account_scale_pays`).

**Efeito.** O prior entra no **texto do prompt** ("Nesta conta, escalar o que já tem base tende a
compensar…"), sempre **limitado pelo guardrail** (que o aprendizado nunca toca). **Garantia:**
`proposalForCalibration` recusa `direction != lower` → um prior de escala **nunca** vira proposta de
limiar. A agressividade influencia o conselho; o teto de segurança continua sendo exógeno.

---

## Caminho 4 — Proposta de LIMIAR: aprovar (aperta só `model_config.quality`)

**Contexto.** O prior `account:budget:lower` do Caminho 1 foi reforçado por **mais** medições
positivas em entidades novas:

| Entidades distintas de suporte | Confiança | Selo |
|---|---|---|
| 3 (nascimento) | 0,744 | provável — entra no prompt |
| 4 | 0,797 | provável |
| 5 | **0,823** | provável — **≥ 0,80 dispara proposta** |

**Função executada.** No `distillAccount`, quando a confiança cruza `0,80` **e** a lição não foi
confirmada nem resolvida, anexa `proposalForCalibration("calibration", "budget", "lower")` =
`{ threshold: "zombieMinSpend", stepPct: 0,25, minValue: 1, behaviorLabel: "passar a cortar
desperdício mais cedo nesta conta" }`.

**O que aparece.** Zona **"Precisam de você"**: **"O agente pode passar a cortar desperdício mais
cedo nesta conta?"** com **Sim, ajustar** / **Agora não**.

**Aprovar.** `POST /learnings/:id/accept-threshold` (casca `@trafego/agent-config`): `nextThresholdValue`
reduz o limiar atual em 25% (piso `minValue`) — ex.: `zombieMinSpend` R$ 50 → `50 × 0,75 = R$ 37,50`
— e `applyAgentConfigChange` grava **só** em `agents.model_config.quality.zombieMinSpend` (auditado,
`source = learning_threshold_accept`). Guarda o valor anterior em `applied_threshold_patch` para o
Reverter. **Hard-wall:** `guardrail_configs` e `autonomy_policy` **intactos**. A lição vira
confirmada; o card passa a **"Ajuste aplicado · Reverter"**.

---

## Caminho 5 — Proposta de LIMIAR: rejeitar / reverter

**Rejeitar.** `POST /learnings/:id/reject-proposal`: descarta o `proposed_threshold_patch` **sem
tocar em config** e carimba `threshold_resolved_at`. O prior continua valendo (segue afiando o
prompt/guard) — só o ajuste automático foi recusado. A re-oferta só volta com evidência
substancialmente nova.

**Reverter** (um ajuste já aplicado no Caminho 4). `POST /learnings/:id/revert-threshold`: lê
`applied_threshold_patch`, restaura o valor anterior (`zombieMinSpend` volta a R$ 50) via
`applyAgentConfigChange` (auditado, `source = learning_threshold_revert`), limpa o patch aplicado e
carimba `threshold_resolved_at`. **Hard-wall** de novo. A mesma lógica roda pelo **chat**
(`reject_proposal`), reusando a casca compartilhada.

---

## Caminho 6 — Padrão TEMPORAL: timing de fadiga de criativo

**Métricas.** Três campanhas com CTR alto na largada que **despenca** por volta do mesmo dia:

| Campanha | CTR dias 1–5 | CTR a partir do dia | 1º dia de fadiga |
|---|---|---|---|
| `Vídeo A` | ~5% | dia 6 | 6 |
| `Vídeo B` | ~5% | dia 6 | 6 |
| `Vídeo C` | ~5% | dia 7 | 7 |

**Função executada.** `distillTemporal` lê a série de CTR por campanha
(`loadCampaignCtrSeries`, lookback `LEARNING_TEMPORAL_LOOKBACK_DAYS`). `detectFatigueTimingPrior`
acha o 1º dia de fadiga por campanha (CTR cai ≥ 30% vs o pico da largada), exige **≥ 3** campanhas e
**variância baixa** (coeficiente de variação ≤ 0,35) entre os dias — média ≈ 6 dias, dispersão
baixa → nasce.

**Lição gerada.** `scope='account'`, `dimension='creative'`, `direction='neutral'`,
`origin='observational'`, `evidence.days ≈ 6`, confiança por força estatística (`temporalConfidence`,
padrão apertado → ~0,80 → entra no prompt). Frase (ex.): *"Nesta conta, os criativos tendem a cansar
por volta de 6 dias após o lançamento — vale preparar renovação antes disso."*

**Contraste:** dias-de-fadiga dispersos (ex.: 4, 10, 16) → variância alta → **não nasce** (barra
anti-ruído).

---

## Caminho 7 — Padrão TEMPORAL: lag de conversão

**Métricas.** O gasto diário da conta varia; a conversão **espelha o gasto ~3 dias depois** (a venda
fecha fora da Meta, com atraso).

**Função executada.** `detectConversionLagPrior` (sobre a série diária de conta,
`loadAccountConversionSeries`) testa a correlação de Pearson entre `gasto(t)` e `conversão(t+D)` para
`D` de 1 a `maxLagDays`; escolhe o melhor lag quando a correlação ≥ mínimo **e** supera a do lag 0
(o atraso REALMENTE ajuda). Aqui `D = 3`.

**Lição gerada.** `scope='account'`, `dimension='conversion'`, `direction='neutral'`,
`evidence.days = 3`, confiança por força da correlação. Frase (ex.): *"Nesta conta, a conversão
costuma aparecer com ~3 dias de atraso em relação ao gasto — não trate uma campanha nova como sem
resultado cedo demais."*

**Efeito.** Ressalva no prompt: o analista fica **mais paciente** — o efeito de "estender a janela
de maturidade" acontece pelo próprio conselho (não há um limiar em dias a mover hoje, então uma
proposta mecânica seria inerte).

---

## Caminho 8 — Prior de TRACKING recorrente (o único fact observacional)

**Métricas.** A conta fecha venda no WhatsApp, mas a Meta quase não registra conversão:

| Run | Conversas iniciadas | Vendas rastreadas | `trackingHealth.suspect` |
|---|---|---|---|
| #1 | 240 | 2 | `true` |
| #2 | 275 | 1 | `true` |
| #3 | 310 | 3 | `true` |

**Função executada.** `detectFactCandidates` (a única sobrevivente da v1) conta os runs com
`trackingSuspect=true`: 3/3 ≥ 0,6. **Não** há mais padrão por-entidade aqui — só este, de conta.

**Lição gerada.** `scope='account'`, `dimension='tracking'`, `direction='neutral'`,
`origin='observational'`, confiança **0,30** (explorando, teto 0,60). Frase (ex.): *"A medição de
conversão desta conta aparece suspeita de forma recorrente — trate os números de conversão com
cautela."* Por ser `neutral`, **não** aciona o guard de escala; serve de contexto e, confirmada,
informa o analista.

---

## Caminho 9 — Aviso de OPORTUNIDADE de guardrail ("sinal vivo")

**Contexto.** Existe o prior medido `account:pacing:raise` (Caminho 3: escalar compensa). Numa
análise, o analista quis aumentar o orçamento da campanha `Winner X` (budget diário R$ 100) em
**50%**, mas o guardrail tem teto `maxBudgetChangePct = 20%` → clampou para 20% (registra
`clampedFrom = 50`).

**Função executada.** No `guardrail_check`, `extractClampedRaises` monta
`{ wantedPct: 50, cappedPct: 20, currentBudgetMinor: 10000 }`; `detectGuardrailOpportunity` checa as
**3 condições**: (a) `hasScalePaysPrior` (do `load_context`, das chaves das lições ativas) → sim;
(b) clamp real (50 > 20) → sim; (c) R$ bloqueado = `100 × (50−20)% = R$ 30/dia` ≥ material → sim.
Emite `guardrailOpportunity` e o `record` grava em `metrics_snapshot.guardrailOpportunity`.

**O que aparece / o usuário.** Zona **"Oportunidades"**: *"Seu teto de aumento é 20%, mas a análise
quis 50% numa campanha que a conta indica que compensaria — cerca de R$ 30 por dia segurados."*
**Ajustar nas configurações →** (deep-link, você muda o teto na mão) ou **Dispensar** (grava
`advisory_dismissals` com cooldown de 14 dias → some da zona; só volta depois do cooldown ou se
piorar). **Hard-wall:** o aviso **só aponta** — nunca muta o guardrail. E **não emite** sem o prior
de escala medido (a agressividade não empurra o teto sozinha).

---

## Caminho 10 — Curadoria: reforço/dedup + decaimento (e a exceção do confirmado)

**Reforço/dedup.** Um prior de conta é recomputado do ledger inteiro a cada tick; só atualiza quando
o **suporte cresce** (uma entidade nova) — `refreshAccountPrior` fixa `reinforce_count = nº de
entidades distintas`. Um re-tick com a mesma evidência é **no-op** (não infla). O prior de tracking
(Caminho 8) dedupa por evidência (não reforça sem run novo).

**Decaimento.** `applyDecaySweep` (fim de cada tick, um degrau por sweep) sobre linhas de
aprendizado com chave e `confirmed_by_human = false`:

| Tempo sem reforço | Faz | Selo |
|---|---|---|
| > `DECAY_STALE_DAYS` (30d prod) | `active → stale` | **desbotando** |
| > `DECAY_ARCHIVE_DAYS` (60d prod), já stale | `stale → archived` | some da aba (Arquivados) |

**Exceção.** Lição **confirmada** pelo humano **nunca decai** — o dono endossou.

---

## Caminho 11 — Bloco forte no prompt + guard assimétrico de conta

**Bloco de prompt.** Na síntese, `lessonsBlock` monta **"O QUE APRENDEMOS DESTA CONTA"** separando
**evidência medida** (Caminhos 1–3) de **ressalva observada** (Caminho 8), com a hierarquia
explícita *orientação do dono > aprendizado medido > dado atual*. É bem mais forte que o antigo
"confie no dado atual se contradisser": a evidência medida cross-seccional é levada a sério.

**Guard assimétrico de conta.** Um prior `account:...:lower` **não-confirmado** (confiança < 0,70 →
vai para o lote de *guards*, não para o prompt) rebaixa **TODA** escala da conta:
- `guardUnconfirmedHypothesis` rebaixa `increase_budget`/`resume` → `investigate` (título com
  prefixo; rationale "[guard] escalar → investigar: … cautela ao escalar por aqui").
- **Assimetria:** só rebaixa; `raise`/`neutral` **nunca** agem; **pausar/cortar** não é tocado.
- Priors **confirmados / ≥ 0,70** saem do guard → influenciam pelo **texto** (não duplicam efeito).

---

## Caminho 12 — Controle por chat + alertas + kill-switch

**Chat (WhatsApp).** Com conta em foco e `autoConfigViaChat` ligado, o Roy expõe (eco+confirma,
reusando a casca do site): `list_learnings` (sempre), `confirm_learning`, `forget_learning`,
`approve_proposal`, `reject_proposal`, `dismiss_advisory`. Ex.:
> "Aprendi que cortar desperdício cedo compensa nesta conta (visto em 3 campanhas). Quer que eu
> passe a cortar mais cedo? Posso ajustar."

O dono diz "pode ajustar" → o Roy **ecoa** e, no "sim", chama `approve_proposal`. Desligado o
kill-switch, o Roy responde "é pelo site" (mas `list_learnings` continua). `describe_capabilities`
declara tudo com honestidade.

**Alertas.** Ao nascer um prior/proposta novo, o agente manda um aviso no WhatsApp — gated por
`notify_policy.learning` (default ON; org-level, grupo→DM via `loadTarget`). Best-effort.

**Kill-switch do aprendizado.** `agents.model_config.learning.enabled = false` tira o agente do
`listLearnableAgents` (o loop não roda). Ausência = ligado (default ON).

---

## Caminho 13 — Segurança: hard-wall + isolamento por org

**Hard-wall.** Nenhum caminho de aprendizado escreve `guardrail_configs` nem `autonomy_policy`. Os
patches de limiar (Caminhos 4–5) tocam **só** `model_config.quality`; o aviso de oportunidade
(Caminho 9) só aponta pra config. O E2E captura os dois snapshots (guardrail + autonomia)
antes/depois de aprovar uma proposta e compara byte-a-byte.

**Ortogonalidade.** O aprendizado afia o **conselho** em qualquer nível de autonomia; a autonomia
decide se o conselho afiado toca a conta. O aprendizado **nunca** propõe mudar a autonomia.

**Isolamento por org.** Com 2 orgs e a mesma evidência medida, cada org destila seu **próprio**
prior (`agent_memory` filtrado por `org_id`+`agent_id`); a leitura org-scoped de uma **não** enxerga
a linha da outra.

---

### Resumo dos gatilhos por caminho

| Caminho | Gatilho | Função-chave | Destino | Confiança inicial |
|---|---|---|---|---|
| 1 Corte nosso (conta) | ação nossa medida em ≥K entidades | `classifyOutcomeEvidence`→`distillAccountPriors` | prompt (`account:budget:lower`) | 0,744 (3 ent.) |
| 2 Mudança manual (conta) | config-snapshot medido em ≥K | `measureManualChanges`→`distillAccountPriors` | prompt | 0,744 (3 ent.) |
| 3 Escala compensa | escala nossa positiva em ≥K | `distillAccountPriors` (`raise`) | prompt (nunca proposta) | 0,744 (3 ent.) |
| 4 Proposta: aprovar | prior ≥ 0,80 + direção `lower` | `proposalForCalibration`→`acceptThreshold` | `model_config.quality` | aplica (hard-wall) |
| 5 Proposta: rejeitar/reverter | clique/chat | `rejectProposal`/`revertThreshold` | descarta/restaura | — |
| 6 Timing de fadiga | ≥K campanhas, variância baixa | `detectFatigueTimingPrior` | prompt (`account:creative:neutral`) | ~0,80 (apertado) |
| 7 Lag de conversão | cross-correlação gasto×conversão | `detectConversionLagPrior` | prompt (`account:conversion:neutral`) | por força da correlação |
| 8 Tracking recorrente | `suspect` em ≥60% dos runs | `detectFactCandidates` | prompt/contexto (`account:tracking:neutral`) | 0,30 |
| 9 Oportunidade de teto | clamp + prior `raise` + R$ material | `detectGuardrailOpportunity` | zona Oportunidades (aponta config) | — |
| 10 Curadoria | suporte cresce / sem reforço | `refreshAccountPrior`/`applyDecaySweep` | — | — |
| 11 Prompt + guard | prior ativo na análise | `lessonsBlock`/`guardUnconfirmedHypothesis` | prompt / rebaixa escala | — |
| 12 Chat + alertas | mensagem / prior novo | `list/confirm/forget/approve/reject/dismiss` + `onNewLearning` | site+chat / WhatsApp | 0,90 (confirm) |
| 13 Segurança | qualquer caminho | hard-wall + org-scoping | — | — |

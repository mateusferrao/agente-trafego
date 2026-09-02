# Exemplos funcionais — Aprendizado contínuo (um por caminho)

Cada exemplo mostra: **métricas da conta ao longo do tempo → função executada → o que foi
identificado → a lição gerada (com a confiança calculada de verdade) → onde aparece → o que o
usuário faz**. Os números de confiança seguem exatamente `computeConfidence`
(`packages/core/src/learning/index.ts`).

## Régua de confiança (vale para todos os exemplos)

`computeConfidence` aproxima a confiança de um teto, com ganho decrescente:
`nova = base + (teto − base) × 0,5 × força`.

- **Teto observacional** = `0,60` · **teto medido (ação nossa)** = `0,85` · **confirmação humana** = `0,90`.
- **Selo (tier):** `< 0,5` → **explorando** · `0,5–0,85` → **provável** · `≥ 0,85` ou confirmado por humano → **confirmado**.
- **Entra no texto do analista (prompt)** só com `≥ 0,70` **ou** confirmado por humano. Como observação pura satura em `0,60 < 0,70`, **um padrão só-observado nunca entra no prompt sozinho** — ele influencia em silêncio pelo *guard* até alguém confirmar. Calibração de ação nossa (teto `0,85`) **pode** passar de `0,70` com medições repetidas.

O ciclo roda no job `agent-learning` (`runTick`, default 06:00 diário) sobre cada conta ativa e não-dormante.

---

## Caminho 1 — Observacional: campanha zumbi recorrente (conta que só usa análise)

**Métricas ao longo do tempo.** A campanha `Institucional — Sempre no ar` (id `23851`) roda há semanas gastando sem entregar:

| Análise (run) | Data | Gasto na campanha | Conversões | Tier atribuído |
|---|---|---|---|---|
| #1 | 12/08 | R$ 512 | 0 | `zombie` |
| #2 | 19/08 | R$ 498 | 0 | `zombie` |
| #3 | 26/08 | R$ 530 | 0 | `zombie` |

O usuário **não aplicou nenhuma ação** — só olhou as análises. Cada run gravou o `metrics_snapshot` com `waste.zombies` contendo a `23851`.

**Função executada.** No tick, `detectFactCandidates` (`packages/core`) lê o histórico dos runs (`loadRunHistory`) e agrega por campanha: 3 aparições, 3 como zumbi → razão `3/3 = 1,0 ≥ 0,6` (limiar). 

**O que identificou.** Padrão `persistent_zombie` na entidade `23851` → chave semântica `entity:budget:lower:23851`.

**Lição gerada.** O redator LLM traduz a candidata estruturada numa frase PT (nunca inventa). Grava em `agent_memory`:
- `type = fact`, `origin = observational`, `semantic_key = entity:budget:lower:23851`
- confiança = `aproxima(0 → 0,60, força 1,0)` = **0,30** → selo **explorando**
- frase (ex.): *"A campanha Institucional — Sempre no ar vem gastando de forma consistente sem gerar resultado nas últimas análises."*

**Onde aparece.** Aba **Aprendizados** (`/accounts/:id/aprendizados`): card com a frase + selo "Explorando" + origem "observando sua conta". **Ainda não entra no texto do analista** (0,30 < 0,70) — influencia só pelo guard (Caminho 12).

**O que o usuário faz.** Lê e, se concordar, clica **"É isso mesmo"** → vira confirmado (Caminho 8).

---

## Caminho 2 — Observacional: fadiga de criativo recorrente

**Métricas.** A campanha `Remarketing — Vídeo depoimento` (id `31007`) mostra o mesmo sinal de saúde run após run:

| Run | Frequência | CTR | Sinal de saúde congelado no run |
|---|---|---|---|
| #1 | 3,8 | 0,9% | `creative_fatigue` |
| #2 | 4,3 | 0,7% | `creative_fatigue` |
| #3 | 4,9 | 0,6% | `creative_fatigue` |
| #4 | 5,1 | 0,6% | `creative_fatigue` |

**Função executada.** `detectFactCandidates` agrega os `healthSignals` por campanha: `creative_fatigue` em 4/4 runs → `1,0 ≥ 0,6`. O mapa `HEALTH_SIGNAL_DIMENSION` traduz `creative_fatigue → dimensão creative`.

**O que identificou.** Padrão `recurring_health_signal` (creative) na `31007` → `entity:creative:lower:31007`.

**Lição gerada.** `type = fact`, `origin = observational`, confiança **0,30** (explorando), frase (ex.): *"O criativo de vídeo do remarketing vem cansando o público — a frequência sobe e o CTR cai a cada análise."*

**Onde aparece / o usuário.** Igual ao Caminho 1: aba Aprendizados, "Explorando", pull. (Outros sinais mapeados: `weak_creative`/`weak_hook_retention` → creative; `audience_saturation` → audience.)

---

## Caminho 3 — Observacional: medição de conversão suspeita (nível conta)

**Métricas.** A conta fecha venda no WhatsApp, mas a Meta quase não registra conversão:

| Run | Conversas iniciadas | Vendas rastreadas na Meta | `trackingHealth.suspect` |
|---|---|---|---|
| #1 | 240 | 2 | `true` |
| #2 | 275 | 1 | `true` |
| #3 | 310 | 3 | `true` |

**Função executada.** `detectFactCandidates` conta os runs com `trackingSuspect = true`: 3/3 ≥ 0,6.

**O que identificou.** Padrão `recurring_tracking_suspect` no nível **conta** → `account:tracking:neutral` (direção `neutral`: é uma ressalva, não um "cortar/escalar").

**Lição gerada.** `type = fact`, `origin = observational`, `scope = account`, confiança **0,30** (explorando), frase (ex.): *"A medição de conversão desta conta parece incompleta: muitas conversas e pouquíssimas vendas rastreadas."*

**Onde aparece / o usuário.** Aba Aprendizados. Por ser `neutral`, **não** aciona o guard de escala (que só age em `lower`) — serve de contexto; confirmar sobe a confiança e passa a informar o analista.

---

## Caminho 4 — Curadoria: reforço + dedup (como a confiança sobe)

**Contexto.** A lição zumbi do Caminho 1 já existe (0,30). Novos runs continuam marcando a `23851` como zumbi.

**Função executada.** A cada tick, `distillAgent` acha a candidata, `findLessonByKey` encontra a lição existente e:
- **Dedup:** se `lastReinforcedAt >= data do run mais novo`, **não reforça** (um tick sem run novo não infla a confiança).
- **Reforço:** com um run novo, `reinforceLesson` sobe a confiança por `computeConfidence` e incrementa `reinforce_count`.

**Evolução da confiança (reforço observacional, teto 0,60):**

| Evento | Conta | Confiança | Selo |
|---|---|---|---|
| Criação (3 runs) | — | 0,30 | explorando |
| +1 run zumbi | reforço | 0,45 | explorando |
| +1 run zumbi | reforço | 0,525 | **provável** |
| +1 run zumbi | reforço | 0,5625 | provável |

**Resultado.** O card mostra "· visto 4×" e o selo vira **Provável**. A confiança **nunca chega a 0,60** (assíntota) → sozinha **nunca** vira "confirmado" nem entra no prompt. Só reforço de **outcome medido** ou **confirmação humana** cruzam essa linha.

---

## Caminho 5 — Calibração: um corte NOSSO que deu certo (`cut_worked`)

**Métricas + ação.** O agente recomendou pausar a campanha `Prospecção fria — Genérica` (id `44120`); o usuário aprovou. A pausa foi aplicada de verdade em **10/08** (registro em `agent_tool_calls` com `before_state`, não dry-run).

Janelas de `insights_snapshots` **da conta** (a pausa zera a entidade, então mede-se a conta):

| Janela | Período | Gasto conta | Conversões conta | CPA conta |
|---|---|---|---|---|
| Antes | 03/08–09/08 | R$ 7.000 | 35 | **R$ 200** |
| Depois | 18/08–24/08 (após buffer 7d) | R$ 7.000 | 78 | **R$ 90** |

**Função executada.** Passada a janela (buffer 7d + janela 7d), `measureOutcomes` seleciona a rec madura e ainda não medida (`loadMeasurableRecs`, filtro `measured_at IS NULL`), acha o instante da ação (`findAppliedInstant`) e chama `computeOutcome`. Para pausa, compara o CPA da **conta** com tolerância maior (`accountCpaTolerance = 0,40`): variação `(90−200)/200 = −0,55` → **melhora** → outcome **`positive`**.

**O que identificou.** `detectCalibrationCandidate`: corte + outcome positivo → padrão `cut_worked` → `entity:budget:lower:44120`.

**Lição gerada (transação única, idempotente).** `commitOutcome`:
- grava `recommendation_feedback` com `outcome = positive`, `outcomeMetrics` (antes/depois) e `measured_at = now()` — **uma vez** (rodar o job de novo não duplica);
- cria a lição `type = past_action`, `origin = our_action`, confiança = `aproxima(0 → 0,85, força 1)` = **0,425** → selo **explorando**; frase (ex.): *"Quando pausamos a Prospecção fria — Genérica, o custo por resultado da conta caiu bastante."*

**Onde aparece / o usuário.** Aba Aprendizados, origem "a partir de uma ação aplicada". Se o padrão se repetir em novas medições, a confiança sobe (Caminho 9).

---

## Caminho 6 — Calibração: uma escala NOSSA que deu errado (`scale_backfired`)

**Métricas + ação.** O agente aumentou o orçamento do adset `Lookalike 3% — Topo` (id `52233`) em 09/08. Janelas da **própria entidade** (ajuste de budget mede CPA marginal, tolerância `0,15`):

| Janela | Período | Gasto | Conversões | CPA |
|---|---|---|---|---|
| Antes | 02/08–08/08 | R$ 3.000 | 30 | **R$ 100** |
| Depois | 17/08–23/08 | R$ 6.000 | 40 | **R$ 150** |

**Função executada.** `computeOutcome` (efeito `budget_up`): variação de CPA `(150−100)/100 = +0,50 > 0,15` → **piorou** → outcome **`negative`**.

**O que identificou.** `detectCalibrationCandidate`: escala + outcome negativo → padrão `scale_backfired` → `entity:pacing:lower:52233`.

**Lição gerada.** `type = past_action`, `origin = our_action`, confiança **0,425** (explorando), frase (ex.): *"Quando aumentamos o orçamento do Lookalike 3% — Topo, o custo por resultado piorou — escalar aqui pede cautela."* Grava `recommendation_feedback` com `outcome = negative`.

**Efeito prático.** Essa lição (`lower` na entidade) passa a **frear escalas futuras** dessa entidade pelo guard (Caminho 12), mesmo antes de confirmada.

---

## Caminho 7 — Mudança MANUAL do gestor (atribuição por config-snapshot)

**Métricas + mudança.** O gestor, **na mão dentro da Meta**, cortou o orçamento diário da campanha `Sazonal — Dia das Mães` (id `61890`) de R$ 300 para R$ 120 em 10/08. O sync diário gravou dois `entity_config_snapshots`:

| Data | `config_json` |
|---|---|
| 09/08 | `{ status: active, dailyBudgetMinor: 30000 }` |
| 10/08 | `{ status: active, dailyBudgetMinor: 12000 }` |

E os insights da entidade melhoraram depois (CPA de R$ 180 → R$ 70).

**Função executada.** `measureManualChanges` pareia os snapshots (`loadMaturedConfigChanges`), e `manualChangeToAction` vê a queda de `(12000−30000)/30000 = −0,60 ≤ −0,15` → ação sintética `adjust_budget/decrease`. Antes, `hasAppliedActionInRange` confirma que **não houve ação nossa** naquela janela (senão seria do agente, não do gestor). `computeOutcome` mede a entidade → `positive`.

**O que identificou.** Corte do gestor que deu certo → base de calibração, mas **rebaixada** a observação (atribuição fraca por timing): `entity:budget:lower:61890`.

**Lição gerada.** `type = fact`, `origin = human_manual`, confiança **observacional** (`aproxima(0 → 0,60, 1) = 0,30`, teto 0,60 — nunca a confiança forte de ação nossa), frase (ex.): *"Você reduziu o orçamento da Sazonal — Dia das Mães e o custo por resultado dela melhorou."* Sem `recommendation_feedback` (não foi rec nossa).

**Onde aparece / o usuário.** Aba Aprendizados, origem "de uma mudança que você fez". Vale mesmo em conta que só mexe na Meta na mão.

---

## Caminho 8 — Feedback humano (confirmar / editar / esquecer)

Sobre qualquer lição das aba (ex.: a zumbi do Caminho 1, em "Provável" 0,525):

- **Confirmar ("É isso mesmo").** `POST /learnings/:id/confirm` → `computeConfidence(prev, {confirm})` = `max(0,525; 0,90)` = **0,90**, `confirmed_by_human = true` → selo **Confirmado**. Só agora a lição **entra no texto do analista** (≥ 0,70) e **deixa de decair** (Caminho 11).
- **Editar.** `PATCH /learnings/:id` → reescreve a frase (o dono corrige com as palavras dele). Não mexe na confiança.
- **Esquecer.** `DELETE /learnings/:id` → `lifecycle = archived` (soft — nunca apaga a linha; some da aba e das análises).
- **👎 legado.** Rejeições antigas (`type = rejected`) seguem pelo caminho existente (alimentam o brief via `rejectedMemory`); **não** aparecem nesta aba nova (decisão registrada no PR).

---

## Caminho 9 — Calibração paramétrica (proposta de ajuste → aceitar)

**Contexto.** A lição `cut_worked` do Caminho 5 (`entity:budget:lower`, dimensão **budget**) foi **reforçada por novas medições positivas**:

| Medição positiva | Confiança | Selo |
|---|---|---|
| 1ª (criação) | 0,425 | explorando |
| 2ª | 0,6375 | provável |
| 3ª | 0,744 | provável — **entra no prompt** (≥ 0,70) |
| 4ª | 0,797 | provável |
| 5ª | **0,823** | provável — **≥ 0,80 dispara proposta** |

**Função executada.** No `commitOutcome`, quando a confiança cruza `THRESHOLD_PROPOSAL_CONFIDENCE = 0,80` **e** a lição ainda não foi confirmada, `proposalForCalibration("calibration", "budget")` grava um `proposed_threshold_patch`:
`{ threshold: "zombieMinSpend", stepPct: 0,25, minValue: 1, behaviorLabel: "passar a cortar desperdício mais cedo nesta conta" }`.

**O que aparece.** Na aba, um card em **linguagem de comportamento** (nunca jargão de limiar): **"O agente pode passar a cortar desperdício mais cedo nesta conta?"** com **"Sim, ajustar"** / **"Agora não"**.

**O que o usuário faz.**
- **"Sim, ajustar"** → `POST /learnings/:id/accept-threshold`: `nextThresholdValue` reduz o limiar atual em 25% (piso `minValue`) — ex.: `zombieMinSpend` de R$ 20 → `20 × 0,75 = R$ 15` — e `applyAgentConfigChange` grava **só** em `agents.model_config.quality.zombieMinSpend` (auditado em `audit_log`, `source = learning_threshold_accept`). **Nunca** toca `guardrail_configs` nem `autonomy_policy`. A lição vira confirmada e a proposta some.
- **"Agora não"** → nada muda (a proposta some da UI para não incomodar).

---

## Caminho 10 — Curadoria: contradição

**Contexto.** Existe a lição `scale_backfired` do Caminho 6 (`entity:pacing:lower:52233`, confiança 0,6375). Numa medição posterior, uma escala parecida naquela entidade deu **certo** (outcome positivo) — contradiz a conclusão de cautela.

**Função executada.** `contradictedLessonKey` identifica a lição contradita; `applyContradiction` aplica `computeConfidence(prev, {contradict})` = `0,6375 × 0,5` = **0,319**. Se caísse abaixo de `CONTRADICTION_STALE_FLOOR = 0,15`, seria rebaixada a `stale`.

**Resultado.** A confiança despenca (de "provável" para "explorando"), o `last_contradicted_at` é carimbado, e a lição para de frear escalas com força. A câmara de eco é evitada: só **medição** contradiz, nunca "o analista repetiu".

---

## Caminho 11 — Curadoria: decaimento (e a exceção do confirmado)

**Contexto.** Uma lição observacional ficou **sem reforço** (o padrão sumiu). Com os defaults de produção (`DECAY_STALE_DAYS = 30`, `DECAY_ARCHIVE_DAYS = 60`):

| Tempo sem reforço | `applyDecaySweep` faz | Selo |
|---|---|---|
| > 30 dias | `active → stale` | **desbotando** |
| > 60 dias (já stale) | `stale → archived` | some da aba |

**Função executada.** `applyDecaySweep` roda ao fim de cada tick (um degrau por sweep), mexendo só em linhas de aprendizado com chave semântica e **`confirmed_by_human = false`**.

**Exceção.** Lição **confirmada** pelo humano **nunca decai** — o dono endossou; ela permanece `active` indefinidamente.

---

## Caminho 12 — Influência assimétrica (o guard)

**Contexto.** Existe a hipótese **não confirmada** `scale_backfired` do Caminho 6 (`entity:pacing:lower:52233`, confiança 0,6375 → vai para o lote de *guards*, não para o prompt). Numa análise, o analista propõe **aumentar o orçamento** do adset `52233`.

**Função executada.** Em `review_analysis`, `guardUnconfirmedHypothesis` cruza a rec de escala (`increase_budget`/`resume`) com os guards de direção `lower` da **mesma entidade**:
- A recomendação é **rebaixada** para `investigate` — título ganha o prefixo de investigação e o rationale recebe *"[guard] escalar → investigar: um aprendizado desta conta (hipótese ainda não confirmada) sugere cautela aqui."*

**Garantias (assimetria).**
- Só **rebaixa** escala; **nunca** promove nada a algo mais arriscado.
- Uma rec de **pausar/cortar** a mesma entidade **não é tocada**.
- Vale no caminho **autônomo** (roda antes de `decide_actions`).
- Lição **confirmada** não passa pelo guard — ela influencia pelo **texto** do prompt.

---

## Caminho 13 — Chat no WhatsApp (`list_learnings` + `confirm_learning`)

**Cenário.** O dono manda no WhatsApp: **"o que você aprendeu da minha conta?"**

**Função executada.** A tool de leitura `list_learnings` (sempre disponível com conta em foco) lê as lições vivas (org+agente-scoped) e o Roy responde, ex.:
> "Por enquanto: a *Institucional — Sempre no ar* vive gastando sem retorno (explorando) e pausar a *Prospecção fria* baixou seu custo (explorando). Quer confirmar alguma?"

**Confirmação por chat.** O dono diz "pode confirmar a primeira". O Roy **ecoa** e, no "sim", chama `confirm_learning` → `confirmed_by_human = true` + confiança 0,90. **Gate:** a tool só existe no toolset quando o kill-switch `autonomy_policy.autoConfigViaChat` está ligado; desligado, o Roy responde que a confirmação é **pelo site** (mas `list_learnings` continua funcionando). `describe_capabilities` ("o que você faz?") declara o aprendizado com honestidade.

---

### Resumo dos gatilhos por caminho

| Caminho | Gatilho | Função-chave | Origem | Confiança inicial |
|---|---|---|---|---|
| 1–3 Observacional | job diário sobre histórico | `detectFactCandidates` | observational | 0,30 |
| 4 Reforço/dedup | run novo com o padrão | `reinforceLesson` | — | +passo (teto 0,60) |
| 5 Corte que deu certo | ação nossa + janela | `computeOutcome`→`cut_worked` | our_action | 0,425 |
| 6 Escala que deu errado | ação nossa + janela | `computeOutcome`→`scale_backfired` | our_action | 0,425 |
| 7 Mudança manual | config-snapshot + janela | `measureManualChanges` | human_manual | 0,30 |
| 8 Feedback humano | clique na aba / 👎 legado | `confirm`/`edit`/`forget` | — | 0,90 (confirm) |
| 9 Proposta de limiar | calibração ≥ 0,80 | `proposalForCalibration` | — | aplica em quality |
| 10 Contradição | medição contrária | `applyContradiction` | — | ×0,5 |
| 11 Decaimento | sem reforço 30/60d | `applyDecaySweep` | — | — |
| 12 Guard | escala sob hipótese `lower` | `guardUnconfirmedHypothesis` | — | — |
| 13 Chat | mensagem no WhatsApp | `list_learnings`/`confirm_learning` | — | 0,90 (confirm) |

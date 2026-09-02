# Roteiro de validação manual — Aprendizado contínuo (v3, por VALOR)

Guia passo a passo para validar o **aprendizado contínuo** do agente na versão v3 (redesenho por
valor). O agente aprende só o **não-derivável**, destilado a **nível de conta**, roteado a
alavancas reais (prior de prompt, proposta de limiar, aviso de oportunidade), com fronteiras de
segurança rígidas. Cobre todos os caminhos: prior de tracking, ledger + destilação de conta,
proposta de limiar (aprovar/rejeitar/reverter), padrões temporais, aviso de oportunidade, chat,
alertas, curadoria e as garantias de segurança (hard-wall guardrail/autonomia + kill-switch).

> **Comece pelo §0** (validação automatizada completa em segundos). Os §2+ são a validação
> ponta-a-ponta na UI/chat, para quando você quiser ver a experiência real.

> **O que MUDOU da v1:** não há mais aprendizado observacional **por-entidade** (zumbi/fadiga
> por campanha) — isso era redundante com a análise, que já recalcula e recomenda a cada run. O
> aprendizado agora é **de conta**: só nasce de outcome MEDIDO (ação nossa ou mudança do gestor)
> repetido em **≥ 3 entidades distintas**, do padrão temporal do histórico, ou da ressalva de
> tracking recorrente.

---

## 0. Atalho — validação automatizada completa (recomendado)

Roda **todos os caminhos** contra um Postgres real descartável, com o LLM stubado
(determinístico, sem credencial, sem rede) — **43 asserções em 13 cenários**, em segundos:

```bash
pnpm e2e:learning
# ou: apps/worker/e2e-learning.sh
```

Espere ver `RESULTADO: 43 ok · 0 falhas`. Isso prova o SQL real — org-scoping, ledger de
evidência (`learning_evidence`) + índice único de dedup, destilação cross-seccional (≥K
entidades), transação de outcome, sweep de decaimento, pareamento de config-snapshot, agregação
de janela, idempotência do `measured_at` — **mais** o **hard-wall** (aceitar uma proposta de
limiar muda só `model_config.quality`; `guardrail_configs`/`autonomy_policy` ficam byte-idênticos)
e o kill-switch. Os passos abaixo validam a **experiência de usuário** (aba web, chat, propostas,
oportunidades) que o E2E não cobre.

---

## 1. Preparar o ambiente real

### 1.1 Infra + migrations + seed

```bash
docker compose -f docker/docker-compose.yml up -d      # postgres + redis
cp .env.example .env                                    # ajuste os segredos abaixo
pnpm install
pnpm db:migrate
pnpm db:seed                                            # org beta + catálogo de tools
```

### 1.2 Envs sugeridos para teste (janelas curtas)

O comportamento padrão espera **dias** (janela de outcome = buffer 7d + janela 7d; decaimento
30/60d). Para validar ao vivo sem esperar, encurte as janelas no `.env`:

```dotenv
# aprendizado — valores de TESTE (produção usa os defaults)
LEARNING_PHASE_BUFFER_DAYS=0
LEARNING_OUTCOME_WINDOW_DAYS=1
LEARNING_DECAY_STALE_DAYS=1
LEARNING_DECAY_ARCHIVE_DAYS=2
LEARNING_REDACTOR_MAX_PER_TICK=20
LEARNING_ACCOUNT_MIN_ENTITIES=3          # K — mínimo de entidades distintas p/ o prior de conta
LEARNING_TEMPORAL_LOOKBACK_DAYS=60       # janela da série lida pelos detectores temporais
LEARNING_OPPORTUNITY_MIN_MATERIAL_MINOR=1000   # R$10/dia — abaixo disso o aviso de teto não incomoda
AGENT_LEARNING_CRON=*/2 * * * *          # a cada 2 min (ou dispare manualmente, §1.4)
```

> Precisa de `OPENROUTER_API_KEY` real só se quiser ver o **redator** gerando a frase da lição
> em português. Sem ela, o loop ainda funciona (fallback determinístico de texto).

### 1.3 Subir a aplicação

```bash
pnpm dev        # api + worker + web em paralelo
```

- Web: `http://localhost:4200` (ou a porta do seu setup).
- Tenha **1 agente ativo** numa conta Meta ativa (onboarding: cola token → escolhe conta).
  A conta precisa estar `status=active` e `activity_state=active` (não dormante), e o agente
  **não** pode ter `model_config.learning.enabled = false` (kill-switch, §10).

### 1.4 Disparar o job de aprendizado sob demanda

Em vez de esperar o cron, enfileire um tick na fila `agent-learning` (o worker processa na hora):

```bash
tsx --env-file=.env -e '
  import { Queue } from "bullmq";
  import { Redis } from "ioredis";
  const c = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
  const q = new Queue("agent-learning", { connection: c });
  await q.add("tick", {});
  console.log("tick enfileirado");
  await q.close(); await c.quit();
'
```

Observe o log do worker: `agent-learning:tick` com `{ measured, manualEvidence, created, reinforced, staled, archived }`.

---

## 2. Caminho A — Prior de conta a partir de AÇÕES NOSSAS (o coração da v3)

**Objetivo:** o agente aprende um padrão **de conta** — não de uma campanha — a partir de
outcomes MEDIDOS de ações nossas, repetidos em **entidades distintas**.

**Pré-condição:** **≥ `LEARNING_ACCOUNT_MIN_ENTITIES` (3)** campanhas/adsets DIFERENTES em que uma
ação nossa (ex: reduzir orçamento) foi **aplicada de verdade** (`agent_tool_calls` com
`before_state`, não dry-run) e, passada a janela, **melhorou** o custo por resultado.

**Passos:**
1. Em 3 entidades distintas, tenha uma recomendação com `proposed_action` de corte (reduzir
   orçamento/pausar) que foi **realmente aplicada**, com `insights_snapshots` antes/depois
   mostrando melhora de CPA.
2. Feche as janelas (buffer + janela) e dispare o job (§1.4).

**Resultado esperado:**
- No log: `measured ≥ 3` (uma medição por entidade) e `created ≥ 1` (o prior de conta nasceu).
- `learning_evidence` (§11) tem ≥ 3 linhas `source='our_action'`, mesma `(dimension, direction)`
  = `(budget, lower)`, `entity_id` distintos.
- `agent_memory`: 1 lição `scope='account'`, `dimension='budget'`, `direction='lower'`,
  `origin='our_action'`, `semantic_key='account:budget:lower'`, `confidence ≈ 0,744` (≥ 0,70 →
  **entra no prompt** do analista).
- **Nenhuma** lição `scope='entity'` (o aprendizado por-entidade foi cortado).

**Se você fizer só 2 entidades:** nada nasce (abaixo de K). Prove que 3 distintas é o mínimo.

---

## 3. Caminho B — A aba "Aprendizados" (4 zonas condicionais)

**Onde:** aba própria do detalhe da conta, rota `/accounts/:id/aprendizados` (entre "Agente" e
"Criativos"). Só aparece **o que existe** (zonas condicionais):

1. **"Precisam de você"** (só se houver): propostas de ajuste de comportamento → **Aprovar** /
   **Rejeitar** (§4).
2. **"Oportunidades"** (só se houver): aviso de teto de guardrail → **Ajustar nas configurações →**
   (deep-link para `/accounts/:id/agente`) / **Dispensar** (§6).
3. **"O que o agente já sabe":** priors ativos → **É isso mesmo** (confirmar) / **Editar** /
   **Esquecer**; se o ajuste de limiar já foi aplicado, mostra **"Ajuste aplicado (…). Reverter"**.
4. **"Arquivados":** recolhido; **busca** por texto + **Restaurar**.

**Checagens de voz/UX:** estado vazio "Ainda estou conhecendo esta conta…" (sem jargão); selo de
confiança = **tom+texto** (explorando/provável/confirmado, nunca só cor); erro amigável com
"Tentar de novo" (sem stack); sentence case; cópia por zona distingue os 3 tipos (influencia /
aprova-muta / aponta-config).

---

## 4. Caminho C — Proposta de limiar (aprovar / rejeitar / reverter) + HARD-WALL

**Objetivo:** um prior de conta forte **propõe**, em linguagem de comportamento, apertar um limiar
de qualidade — **só conservador** (nunca afrouxa). Aceitar aplica a mudança auditada; **nunca**
toca guardrail nem autonomia.

**Como nasce a proposta:** quando o prior de conta cruza `THRESHOLD_PROPOSAL_CONFIDENCE = 0,80`
(≈ 5 entidades distintas medidas) **e** a direção é `lower` (conservadora), o `distillAccount`
anexa um `proposed_threshold_patch`. Um prior AGRESSIVO (`account_scale_pays`, direção `raise`)
**nunca** vira proposta — a agressividade influencia só via prompt.

**Passos e esperado:**
1. Zona **"Precisam de você"**: card **"O agente pode passar a cortar desperdício mais cedo nesta
   conta?"** (linguagem de comportamento, sem jargão de limiar).
2. **Aprovar ("Sim, ajustar"):** o limiar em `agents.model_config.quality` muda (ex:
   `zombieMinSpend` de R$ 50 → `50 × 0,75 = R$ 37,50`, piso `minValue`); a lição vira confirmada;
   a proposta some; o card passa a mostrar **"Ajuste aplicado · Reverter"**.
   - SQL: `agents.model_config -> 'quality' -> 'zombieMinSpend'` reflete o novo valor; `audit_log`
     tem `source = learning_threshold_accept`.
   - **HARD-WALL (confira no banco):** `guardrail_configs` e `autonomy_policy` **inalterados**.
3. **Reverter:** restaura o valor anterior (`audit_log` com `source = learning_threshold_revert`);
   hard-wall de novo (guardrail/autonomia intactos).
4. **Rejeitar ("Agora não"):** descarta o patch **sem tocar em nada**; a lição/prior continua
   valendo; `threshold_resolved_at` fica preenchido (trava a re-oferta até evidência nova).

---

## 5. Caminho D — Prior de conta a partir de MUDANÇA MANUAL do gestor (conta só-análise)

**Objetivo:** a conta que **só usa análise** também aprende — o gestor age na mão na Meta, nós
medimos. É o que fecha a lacuna "só quem aplica nossas ações aprende".

**Passos:**
1. Em 3 campanhas distintas, garanta 2 `entity_config_snapshots` em dias seguidos com o orçamento
   caindo ≥15% (o sync grava na cadência diária), **sem** `agent_tool_calls` nosso na janela.
2. `insights_snapshots` antes/depois com melhora de CPA.
3. Feche as janelas e dispare o job (§1.4).

**Resultado esperado:** `learning_evidence` com ≥ 3 linhas `source='human_manual'` →
`distillAccount` materializa o mesmo prior de conta `account:budget:lower`. Se houver ação nossa
na mesma janela de uma entidade, aquela mudança **não** é atribuída ao gestor (evita dupla
contagem via `hasAppliedActionInRange`).

---

## 6. Caminho E — Aviso de OPORTUNIDADE de guardrail ("sinal vivo")

**Objetivo:** quando o teto de budget do guardrail **clampou** uma escala que um prior MEDIDO diz
que compensa, o agente **aponta** para a config — nunca muta o guardrail (é uma oportunidade, não
um aprendizado).

**Pré-condição (3 condições, todas):** (a) existe um prior medido `account_scale_pays`
(escalar compensa) forte; (b) numa análise, o analista quis escalar mais que o teto
(`maxBudgetChangePct`) e o guardrail clampou; (c) o R$/dia bloqueado ≥
`LEARNING_OPPORTUNITY_MIN_MATERIAL_MINOR`.

**Passos e esperado:**
1. Rode uma análise nessas condições → no fim do `guardrail_check`, o run grava
   `metrics_snapshot.guardrailOpportunity`.
2. Zona **"Oportunidades"** na aba mostra o aviso: "Seu teto de aumento é X%, mas a análise quis
   Y% numa campanha que compensaria — cerca de R$ Z/dia segurados."
3. **Ajustar nas configurações →** leva ao `/accounts/:id/agente` (você muda o teto na mão — nós
   nunca mudamos).
4. **Dispensar:** grava `advisory_dismissals` com cooldown (14 dias) → o aviso some da zona; só
   reaparece depois do cooldown ou se piorar materialmente.

> O `detectGuardrailOpportunity` é puro e provado no §0 (cenário 10), inclusive o hard-wall do
> sinal (**não emite** sem o prior de escala medido).

---

## 7. Caminho F — Padrões TEMPORAIS (timing de fadiga + lag de conversão)

**Objetivo:** regularidades **dinâmicas** que só saem da série de vários runs — servem a conta
100% passiva; não é "está zumbi agora" (o run já vê isso), é **timing**.

**Timing de fadiga.** Com **≥ 3 campanhas** cujo CTR alto na largada despenca por volta do mesmo
dia (variância baixa entre elas), `detectFatigueTimingPrior` cria um prior de PROMPT
`account:creative:neutral` ("os criativos aqui cansam ~N dias após o lançamento").

**Lag de conversão.** Com histórico suficiente e cross-correlação clara entre gasto(t) e
conversão(t+D), `detectConversionLagPrior` cria `account:conversion:neutral` ("a conversão atrasa
~D dias" → o analista fica mais paciente, não corta campanha nova cedo demais).

**Esperado:** `agent_memory` ganha essas duas lições `scope='account'`, `origin='observational'`;
a confiança é pontuada pela **força estatística** (padrão apertado alcança o prompt; disperso fica
"explorando"). Provado no §0 (cenário 8).

---

## 8. Caminho G — Prior de TRACKING recorrente + curadoria (dedup/reforço/decaimento)

**Tracking recorrente (o único fact observacional que sobrou).** Se `trackingHealth.suspect=true`
se repete em ≥ 60% dos runs, nasce `account:tracking:neutral` ("a medição de conversão desta conta
aparece suspeita"), `origin='observational'`, `confidence ≤ 0,60`.

**Dedup/reforço:** um re-tick **sem run novo** não reforça; um run novo reforça (confiança sobe,
respeitando o teto observacional 0,60).

**Decaimento:** com janelas curtas (§1.2), uma lição sem reforço vai `active → stale` (selo
"desbotando" na aba) `→ archived`. **Lição confirmada nunca decai.** Provado no §0 (cenários 1, 2, 11).

---

## 9. Caminho H — Bloco forte no prompt + guard assimétrico de conta

**Bloco de prompt.** Na síntese, o analista recebe o bloco **"O QUE APRENDEMOS DESTA CONTA"**, que
separa **evidência medida** (padrão repetido em ≥K campanhas) de **ressalva observada** (tracking),
com hierarquia explícita: *orientação do dono > aprendizado medido > dado atual*. Rode uma análise
com um prior de conta ativo e confira que o bloco entra (via log/trace do prompt).

**Guard assimétrico de conta.** Um prior de conta **não-confirmado** de direção `lower` (confiança
< 0,70) rebaixa **TODA** escala da conta → `investigate` (título com prefixo de investigação;
rationale "[guard] escalar → investigar"). Garantias:
- Só **rebaixa** escala; `raise`/`neutral` **nunca** agem (nunca libera risco).
- Uma rec de **pausar/cortar** **não é tocada**.
- Priors **confirmados / ≥ 0,70** saem do guard → influenciam pelo **texto** do prompt (não
  duplicam efeito). Provado no §0 (cenário 9).

---

## 10. Caminho I — Controle por chat + alertas + kill-switch

**Chat (WhatsApp).** Com o canal Evolution conectado e `autonomy_policy.autoConfigViaChat` ligado:
- **"o que você aprendeu?"** → `list_learnings` (sempre disponível com conta em foco).
- **`confirm_learning`** / **`forget_learning`** / **`approve_proposal`** / **`reject_proposal`** /
  **`dismiss_advisory`**: eco+confirma na conversa antes de agir; reusam a **mesma casca** do site
  (`@trafego/agent-config`). Desligue `autoConfigViaChat` → essas ações respondem "é pelo site"
  (mas `list_learnings` continua). `describe_capabilities` declara tudo com honestidade.

**Alertas.** Quando nasce um prior/proposta novo, o agente manda um aviso no WhatsApp — gated por
`notify_policy.learning` (default ON; org-level, grupo→DM). Best-effort: uma falha de aviso nunca
derruba o tick.

**Kill-switch do aprendizado.** Setar `agents.model_config.learning.enabled = false` tira o agente
do `listLearnableAgents` (o loop não roda para ele). Ausência do campo = **ligado** (default ON).

---

## 11. Segurança / multi-tenancy

- **Hard-wall (a fronteira central):** nenhum caminho de aprendizado escreve `guardrail_configs`
  nem `autonomy_policy`. Ao aceitar/reverter uma proposta (§4), confirme no banco que **só**
  `agents.model_config.quality` mudou. O §0 (cenário 5+6) prova isso capturando os dois snapshots
  antes/depois e comparando byte-a-byte.
- **Aprendizado ortogonal à autonomia:** o aprendizado afia o **conselho** em qualquer nível de
  autonomia; a autonomia decide se o conselho afiado toca a conta. O aprendizado **nunca** propõe
  mudar a autonomia.
- **Isolamento por org:** com 2 orgs e a mesma evidência, cada org tem seu **próprio** prior; a
  leitura org-scoped de uma não enxerga a linha da outra (§0 cenário 12).
- **Kill-switch de chat e de aprendizado:** §10.
- **Sem token/PII:** os logs do job trazem só ids; nenhuma credencial é lida no loop.

---

## 12. Queries SQL de inspeção

```sql
-- priors vivos de um agente (as que a aba mostra) — repare no scope=account
SELECT type, origin, scope, dimension, direction, confidence,
       confirmed_by_human, reinforce_count, lifecycle, semantic_key,
       proposed_threshold_patch, applied_threshold_patch, threshold_resolved_at,
       left(content, 60) AS frase
FROM agent_memory
WHERE agent_id = '<idAgente>'
  AND type IN ('fact','past_action')
  AND semantic_key IS NOT NULL
ORDER BY confirmed_by_human DESC, confidence DESC;

-- ledger de evidência (fonte da destilação de conta) — conte entidades distintas por (dim,dir)
SELECT dimension, direction, source, supports, count(DISTINCT entity_id) AS entidades
FROM learning_evidence
WHERE agent_id = '<idAgente>'
GROUP BY dimension, direction, source, supports
ORDER BY dimension, direction;

-- outcomes medidos de ações nossas (recommendation_feedback segue no seu papel de métrica)
SELECT recommendation_id, outcome, measured_at
FROM recommendation_feedback
WHERE measured_at IS NOT NULL
ORDER BY measured_at DESC;

-- dispensas de aviso (zona Oportunidades) + cooldown
SELECT key, dismissed_until FROM advisory_dismissals WHERE agent_id = '<idAgente>';

-- HARD-WALL: confirmar que a proposta NÃO tocou guardrail/autonomia
SELECT model_config -> 'quality' AS quality, autonomy_policy,
       model_config -> 'learning' AS learning_killswitch
FROM agents WHERE id = '<idAgente>';
SELECT * FROM guardrail_configs WHERE agent_id = '<idAgente>';

-- aviso de oportunidade vivo (derivado do último run)
SELECT metrics_snapshot -> 'guardrailOpportunity' AS oportunidade
FROM agent_runs
WHERE agent_id = '<idAgente>' AND metrics_snapshot IS NOT NULL
ORDER BY created_at DESC LIMIT 1;
```

---

## 13. Checklist de aceite

- [ ] `pnpm e2e:learning` → **43 ok · 0 falhas**.
- [ ] Prior de conta nasce de ação nossa em **≥ 3 entidades distintas** (`account:budget:lower`,
      confiança ≥ 0,70); com só 2 entidades, **nada** nasce; **nenhuma** lição por-entidade.
- [ ] Conta **só-análise** aprende via mudança manual do gestor (evidência `human_manual`).
- [ ] Proposta de limiar (só conservadora): **aprovar** muda só `model_config.quality`;
      **reverter** restaura; **rejeitar** descarta; guardrail/autonomia **intactos** em todos.
- [ ] Prior agressivo (`account_scale_pays`) **nunca** vira proposta de limiar.
- [ ] Aviso de oportunidade aparece só com clamp real + prior de escala + R$ material; **Dispensar**
      grava cooldown; **não** muta o guardrail.
- [ ] Padrões temporais (fadiga + lag) criam priors de conta `creative`/`conversion`.
- [ ] Aba: 4 zonas condicionais; confirmar/editar/esquecer; **Arquivados** com busca + **Restaurar**.
- [ ] Guard rebaixa **toda** escala sob prior de conta `lower` não-confirmado; `raise`/`neutral`
      nunca agem; corte intocado; prior confirmado influencia pelo prompt, não pelo guard.
- [ ] Chat: `list_learnings` sempre; confirm/forget/approve/reject/dismiss sob o kill-switch de
      auto-config; alerta no WhatsApp gated por `notify_policy.learning`.
- [ ] Kill-switch do aprendizado (`model_config.learning.enabled=false`) tira o agente do loop.
- [ ] Isolamento por org: aprendizado de uma org não vaza para outra.

---

### Nota — `rejected` legado

O `rejected` legado (👎 antigos) **continua funcionando pelo caminho antigo** (alimenta o brief),
mas **não aparece na aba de Aprendizados** (não foi feito o backfill — decisão adiada para sign-off
de produto). Não é regressão; é o comportamento esperado desta entrega.

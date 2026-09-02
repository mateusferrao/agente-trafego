# Roteiro de validação manual — Aprendizado contínuo (S1–S7)

Guia passo a passo para validar a nova funcionalidade de **aprendizado contínuo** do agente.
Cobre todos os caminhos: observacional, calibração de ações, mudança manual do gestor,
feedback humano, calibração paramétrica, chat, curadoria e as garantias de segurança.

> **Comece pelo §0** (validação automatizada completa em segundos). Os §2+ são a validação
> ponta-a-ponta na UI/chat, para quando você quiser ver a experiência real.

---

## 0. Atalho — validação automatizada completa (recomendado)

Roda **todos os caminhos** contra um Postgres real descartável, com o LLM stubado
(determinístico, sem credencial, sem rede) — 33 asserções em 9 cenários, em segundos:

```bash
pnpm e2e:learning
# ou: apps/worker/e2e-learning.sh
```

Espere ver `RESULTADO: 33 ok · 0 falhas`. Isso já prova o SQL real (org-scoping, dedup por
índice único, transação de outcome, sweep de decaimento, pareamento de config-snapshot,
agregação de janela, idempotência) e o fio completo do `runTick`. Os passos abaixo são para
validar a **experiência de usuário** (aba web, chat, propostas) que o E2E não cobre.

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
LEARNING_MIN_RUNS=3
LEARNING_MIN_OCCURRENCE_RATIO=0.5
LEARNING_PHASE_BUFFER_DAYS=0
LEARNING_OUTCOME_WINDOW_DAYS=1
LEARNING_DECAY_STALE_DAYS=1
LEARNING_DECAY_ARCHIVE_DAYS=2
LEARNING_REDACTOR_MAX_PER_TICK=20
AGENT_LEARNING_CRON=*/2 * * * *   # a cada 2 min (ou dispare manualmente, §1.4)
```

> Precisa de `OPENROUTER_API_KEY` real só se quiser ver o **redator** gerando a frase da lição
> em português. Sem ela, o loop ainda funciona (fallback determinístico de texto).

### 1.3 Subir a aplicação

```bash
pnpm dev        # api + worker + web em paralelo
```

- Web: `http://localhost:4200` (ou a porta do seu setup).
- Tenha **1 agente ativo** numa conta Meta ativa (onboarding: cola token → escolhe conta).
  A conta precisa estar `status=active` e `activity_state=active` (não dormante).

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

Observe o log do worker: `agent-learning:tick` com `{ created, reinforced, measured, manualLearned, staled, archived }`.

---

## 2. Caminho A — Aprendizado observacional (conta SÓ-análise)

**Objetivo:** a conta aprende um padrão recorrente **sem nenhuma ação aplicada** — vale para
quem só usa análise/recomendação.

**Pré-condição:** o agente precisa ter **≥ `LEARNING_MIN_RUNS` (3)** análises no histórico em
que a **mesma campanha** aparece com o mesmo padrão (ex: tier `zombie`) em **≥ 50%** dos runs.

**Passos:**
1. Rode a análise da conta 3–4 vezes (botão "analisar agora" no site, ou `trigger` de cron).
   Use uma conta com pelo menos uma campanha claramente parada/zumbi (gasto sem resultado).
2. Dispare o job de aprendizado (§1.4).

**Resultado esperado:**
- No log do worker: `created ≥ 1`.
- Aba **Aprendizados** (§3) mostra 1 aprendizado com selo **"explorando"** e origem observacional.
- Inspeção SQL (§11): 1 linha em `agent_memory` com `type='fact'`, `origin='observational'`,
  `confidence ≤ 0.6`, `semantic_key = 'entity:budget:lower:<idCampanha>'`.

**Verificação de que influencia a análise:** rode uma nova análise depois que a lição existir —
o contexto do analista passa a incluir o bloco "APRENDIZADOS DA CONTA" (só quando a lição é
**confirmada**; enquanto "explorando", ela influencia em silêncio via guard, §9).

---

## 3. Caminho B — Transparência e feedback humano (aba "Aprendizados")

**Onde:** `Conta → Agente` (rota `/accounts/:id/agente`) → seção **Aprendizados**.

**Passos e esperado:**
1. **Estado vazio** (conta nova): mensagem "Ainda estou conhecendo esta conta…", sem jargão.
2. **Com lições:** cada card mostra a **frase em PT**, o **selo de confiança** (explorando /
   provável / confirmado — nunca o número), a **origem** e "visto Nx" quando reforçado.
3. **Confirmar** ("É isso mesmo"): o selo sobe para **confirmado**; o botão some.
   - SQL: `confirmed_by_human = true`, `confidence ≥ 0.9`.
4. **Editar:** reescreva a frase → salva; o texto muda no card.
5. **Esquecer:** abre confirmação (tom de perigo) → arquiva (some da lista).
   - SQL: `lifecycle = 'archived'` (nunca deletado — a linha continua no banco).

**Checar a voz:** estados de loading/erro/vazio presentes; erro amigável com "Tentar de novo"
(sem stack); sentence case; nada de "enviado com sucesso!".

---

## 4. Caminho C — Calibração paramétrica (proposta de ajuste de limiar)

**Objetivo:** uma lição de alta confiança **propõe** ajustar um limiar de qualidade, em
linguagem de comportamento; aceitar aplica a mudança auditada — **nunca** toca
guardrail/autonomia.

**Como chegar lá:** este card aparece quando uma lição de **calibração** (origem `our_action`)
acumula medições positivas suficientes e ganha um `proposed_threshold_patch`. Para forçar em
teste, você pode setar o patch direto (inspeção/simulação):

```sql
-- exemplo: dar a uma lição de calibração existente uma proposta de limiar
UPDATE agent_memory
SET proposed_threshold_patch = '{"threshold":"marginalCpaWorsenPct","direction":"raise","behaviorLabel":"passar a ser mais paciente antes de sugerir pausas"}'
WHERE id = '<idDaLicao>';
```

**Passos e esperado:**
1. Na aba, o card mostra **"O agente pode passar a ser mais paciente antes de sugerir pausas?"**
   (linguagem de comportamento, sem jargão de limiar).
2. **"Sim, ajustar":** o limiar em `agents.model_config.quality` muda; a lição vira confirmada;
   a proposta some.
   - SQL: `agents.model_config -> 'quality' -> '<limiar>'` reflete o novo valor; `audit_log`
     tem uma entrada com `source = learning_threshold_accept`.
   - **Garantia:** `guardrail_configs` e `autonomy_policy` **inalterados** (confira no banco).
3. **"Agora não":** nada muda.

---

## 5. Caminho D — Chat no WhatsApp (`list_learnings` + `confirm_learning`)

**Pré-condição:** canal Evolution conectado; agente com `autonomy_policy.autoConfigViaChat`
ligado (default) para o `confirm_learning`.

**Passos e esperado:**
1. Mande **"o que você aprendeu?"** (ou "o que você já sabe da minha conta?").
   → o Roy chama `list_learnings` e lista os aprendizados (com tier/origem). Se vazio, diz com
   honestidade que ainda está conhecendo a conta.
2. Peça para confirmar um aprendizado ("pode confirmar que a campanha X é zumbi") →
   o Roy **ecoa** e, ao seu "sim", chama `confirm_learning` (a lição vira confirmada).
3. **Kill-switch:** desligue `autoConfigViaChat` (config do agente) e repita o passo 2 →
   o Roy responde que a confirmação é **pelo site** (não confirma por chat). `list_learnings`
   **continua** funcionando (leitura é sempre permitida).
4. **`describe_capabilities`** ("o que você faz aqui?") menciona o aprendizado com honestidade
   (confirmar por chat × pelo site conforme o kill-switch).

---

## 6. Caminho E — Outcome de ação NOSSA (calibração)

**Objetivo:** o agente aplicou uma ação (ex: pausar) e, depois da janela, mede se deu certo →
grava o outcome e aprende uma lição de calibração.

> Depende de **janela temporal**. Ao vivo é lento; a forma confiável de provar é o **§0**
> (o E2E manipula o relógio). Para validar no ambiente real, encurte as janelas (§1.2) e/ou
> semeie dados com datas no passado. Resumo do que observar:

**Passos:**
1. Tenha uma recomendação com `proposed_action` de pausa que foi **realmente aplicada**
   (registro em `agent_tool_calls` com `before_state`, `dryRun=false`).
2. Garanta `insights_snapshots` da conta **antes e depois** do instante da ação, com melhora
   clara de CPA depois (a verba realocada baixou o custo por resultado da conta).
3. Espere a janela fechar (buffer + janela) e dispare o job (§1.4).

**Resultado esperado:**
- `recommendation_feedback` ganha 1 linha com `outcome` (positive/negative/neutral) e
  `measured_at` preenchido. **Idempotente:** rodar o job de novo **não** cria 2ª linha.
- Surge lição `type='past_action'`, `origin='our_action'` ("cortar aqui ajudou").

---

## 7. Caminho F — Mudança MANUAL do gestor

**Objetivo:** o gestor mudou algo na mão na Meta (ex: cortou orçamento) e o agente atribui a
ele e aprende — **sem** confundir com ação nossa.

**Passos:**
1. Garanta 2 `entity_config_snapshots` da mesma campanha em dias seguidos, com o orçamento
   caindo ≥15% (o sync grava isso na cadência diária). **Sem** `agent_tool_calls` nosso na janela.
2. `insights_snapshots` antes/depois com melhora de CPA.
3. Feche a janela e dispare o job (§1.4).

**Resultado esperado:** lição `type='fact'`, `origin='human_manual'`, confiança observacional
(≤ 0.6). Se houver ação nossa na mesma janela, a mudança **não** é atribuída ao gestor (evita
dupla contagem).

---

## 8. Caminho G — Curadoria (decaimento / dedup / contradição)

**Dedup/reforço:** rode a análise de novo com o mesmo padrão e dispare o job → a lição **não**
duplica; `reinforce_count` sobe e a confiança sobe (respeitando o teto observacional 0.6).
Um re-tick **sem run novo** não reforça (dedup por evidência).

**Decaimento:** com `LEARNING_DECAY_STALE_DAYS`/`ARCHIVE_DAYS` curtos (§1.2), deixe uma lição
sem reforço e dispare o job algumas vezes → ela vai `active → stale` (selo "desbotando" na aba)
`→ archived`. **Lição confirmada nunca decai** (confirme uma e verifique que permanece `active`).

**Contradição:** um outcome que contradiz uma lição existente derruba a confiança dela (e pode
rebaixá-la a `stale`).

> Todos esses são provados de forma determinística no §0 (cenários 2 e 5).

---

## 9. Caminho H — Influência assimétrica (guard)

**Objetivo:** uma hipótese **não confirmada** só torna a análise **mais cautelosa**, nunca
libera risco.

**Como observar:** com uma lição "explorando" de direção `lower` numa campanha, rode uma
análise em que o analista proporia **escalar** essa campanha → a recomendação é **rebaixada
para "investigar"** (título ganha o prefixo de investigação; rationale traz "[guard] escalar →
investigar"). Uma recomendação de **pausar/cortar** a mesma campanha **não** é tocada, e o guard
**nunca** promove uma ação a algo mais arriscado. Lições **confirmadas** não passam pelo guard —
elas influenciam pelo texto do prompt.

> Provado de forma pura/determinística no §0 (cenário 6).

---

## 10. Segurança / multi-tenancy

- **Isolamento por org:** com 2 orgs, confirme que os aprendizados de uma **não** aparecem para
  a outra (aba e SQL filtrados por `org_id`). O §0 (cenário 8) prova isso com a mesma campanha
  em 2 orgs → 2 lições separadas.
- **Calibração confinada:** ao aceitar uma proposta de limiar (§4), confirme no banco que só
  `agents.model_config.quality` mudou — `guardrail_configs` e `autonomy_policy` intactos.
- **Kill-switch de chat:** §5, passo 3.
- **Sem token/PII:** os logs do job trazem só ids; nenhuma credencial é lida no loop.

---

## 11. Queries SQL de inspeção

```sql
-- lições vivas de um agente (as que a aba mostra)
SELECT type, origin, scope, dimension, direction, confidence,
       confirmed_by_human, reinforce_count, lifecycle, semantic_key, left(content, 60) AS frase
FROM agent_memory
WHERE agent_id = '<idAgente>'
  AND type IN ('fact','past_action')
  AND semantic_key IS NOT NULL
ORDER BY confirmed_by_human DESC, confidence DESC;

-- outcomes medidos (Sinal A)
SELECT recommendation_id, outcome, measured_at, outcome_metrics
FROM recommendation_feedback
WHERE measured_at IS NOT NULL
ORDER BY measured_at DESC;

-- snapshots de config (base da atribuição de mudança manual)
SELECT entity_id, date, config_json
FROM entity_config_snapshots
WHERE ad_account_id = '<idConta>'
ORDER BY entity_id, date;

-- confirmar que a calibração NÃO tocou guardrail/autonomia
SELECT model_config -> 'quality' AS quality, autonomy_policy
FROM agents WHERE id = '<idAgente>';
SELECT * FROM guardrail_configs WHERE agent_id = '<idAgente>';

-- rejeitado legado (caminho antigo, intacto — não aparece na nova aba)
SELECT type, lifecycle, left(content, 60) FROM agent_memory
WHERE agent_id = '<idAgente>' AND type = 'rejected';
```

---

## 12. Checklist de aceite

- [ ] `pnpm e2e:learning` → 33 ok · 0 falhas.
- [ ] Conta só-análise aprende um padrão observacional (aba mostra "explorando").
- [ ] Aba: confirmar sobe o selo; editar muda a frase; esquecer arquiva (não deleta).
- [ ] Proposta de limiar: aceitar muda só `model_config.quality`; recusar não muda nada;
      guardrail/autonomia intactos.
- [ ] Chat: "o que você aprendeu?" lista; confirmar por chat funciona com o kill-switch ON e é
      recusado (com "pelo site") com ele OFF.
- [ ] Outcome de ação nossa: `recommendation_feedback` gravado 1x (idempotente) + lição de calibração.
- [ ] Mudança manual do gestor vira lição `human_manual` (sem dupla contagem com ação nossa).
- [ ] Decaimento `active→stale→archived`; lição confirmada nunca decai; dedup não duplica.
- [ ] Guard rebaixa escala de hipótese não-confirmada → investigar; nunca libera; corte intocado.
- [ ] Isolamento por org: aprendizado de uma org não vaza para outra.

---

### Nota — backfill do `rejected` legado

O `rejected` legado (👎 antigos) **continua funcionando pelo caminho antigo** (alimenta o brief),
mas **não aparece na nova aba** (não foi feito o backfill para a estrutura nova — decisão adiada
para sign-off de produto, ver descrição do PR). Não é regressão; é o comportamento esperado desta
entrega.

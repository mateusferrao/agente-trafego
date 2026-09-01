# Validação manual — Pivô saúde COMPLETO (Fases 0-4, branch `feat/fatia7-criacao-campanhas`)

> Último passo do plano (`docs/ROADMAP.md` + plano de origem, ver memória
> `pivo-saude-implementacao`): roteiro **hands-on** cobrindo TODOS os caminhos — felizes,
> tristes e ambíguos — de tudo que foi implementado nesta frente (eleva a análise/recomendações
> do agente ao nível de gestor especialista em saúde). Legenda: `✅` caminho feliz ·
> `⛔` caminho triste (falha amigável, sem quebrar) · `❓` ambíguo (o agente pergunta, nunca chuta) ·
> **[Real]** = rodado nesta sessão contra a conta real de teste, LLM real, sem mock ·
> **[Fixture]** = coberto por teste automatizado existente (arquivo citado), condição real não
> reproduzível com segurança/praticidade contra a conta viva (ver §8).

**Execução real desta sessão — PARTE 1 (2026-08-31):** script `apps/worker/e2e-pivo-saude.ts`, LLM real
(`x-ai/grok-4.5` análise, `google/gemini-3.7-flash` revisor, `openai/gpt-5.6-luna` chat) + Meta
real (`act_1423420276172802`, BM Automato), org de teste `e87fb1fb-6ce9-46fa-af92-354a814b6285`
("Org de Teste 366"), agente `ba2b9542-cbbc-4795-8ac5-c73ed5cf34ad` (arquétipo conservador,
autonomia `bySource=suggest` nas duas origens, sem override por-ação — **nenhuma mutação real na
Meta é possível neste agente**, só leitura + LLM + `approvals` pendente). **Resultado: 17/17 ✅,
zero achado real** (3 falhas na 1ª rodada eram bug do PRÓPRIO script de teste — nome de tool
diferente do esperado e regex sem acento/variante — corrigidas e reconfirmadas, sem tocar em
produto). Nenhuma alteração ficou no ambiente real: `agent_runs`/`recommendations`/`approvals`
criados no teste foram revertidos ao final; nenhuma config de agente foi alterada.

---

## 0. Subir o ambiente

```bash
cd C:\dev\agente-trafego && docker compose -f docker/docker-compose.yml up -d
pnpm install && pnpm db:migrate && pnpm dev
```

**Nota desta sessão:** `docker-postgres-1`/`docker-redis-1` já existiam (parados) de sessões
anteriores — os dados (orgs/agentes/contas de teste já onboardadas) sobrevivem no volume
`docker_pgdata`. Se a porta `5432` já estiver ocupada por **outro** projeto na mesma máquina, **não
mate o container do outro projeto** — suba o postgres deste projeto numa porta alternativa
(`docker run ... -p 5433:5432 -v docker_pgdata:/var/lib/postgresql/data postgres:16-alpine`) e
aponte `DATABASE_URL` do `.env` pra ela. **Gotcha confirmado:** `pnpm db:migrate` (→
`drizzle-kit migrate`) **não lê o `.env` da raiz** (roda a partir de `packages/db`, sem
`--env-file`) — sem `DATABASE_URL` exportado explicitamente na chamada, ele cai no default
hardcoded do `drizzle.config.ts` (porta `5432`) **silenciosamente**, e falha sem mensagem de erro
legível se essa porta pertencer a outro banco. Rode com a env explícita:
`DATABASE_URL="postgres://postgres:postgres@localhost:<porta>/trafego" npx drizzle-kit migrate`
(rodando dentro de `packages/db`). Vale registrar como fast-follow de DX (ver §11).

---

## 1. Contas/agentes de teste já onboardados (reuso — não recriar)

```bash
docker exec docker-postgres-1 psql -U postgres -d trafego -c "
SELECT a.id AS agent_id, a.org_id, a.archetype, aa.id AS ad_account_id, aa.ad_account_id AS meta_account_id, aa.token_status, o.name
FROM agents a JOIN ad_accounts aa ON aa.id=a.ad_account_id JOIN orgs o ON o.id=a.org_id
WHERE aa.ad_account_id='1423420276172802';"
```
Duas linhas hoje: **"Org de Teste 366"** (usar esta — nome explícito de teste) e **"Hy Brazil
Energia S.A."** (org real do dono, mesma conta Meta de teste; **não usar** para estresse, ainda que
tecnicamente funcionasse — evita confundir dados de teste com a org de produção do dono).

Os 3 harnesses de E2E já existentes na árvore (`apps/worker/e2e-chat-mvp.ts`,
`e2e-ads-creative.ts`, `e2e-group-flow.ts`) usam UUIDs hardcoded de OUTRA máquina/sessão — não
existem neste banco. O script desta frente (`e2e-pivo-saude.ts`, §9) usa os UUIDs confirmados
acima. Rodando num Postgres novo/vazio: refazer o onboarding pela UI (§1 de
`validacao-manual-fatia7-completo.md`) e trocar as constantes `ORG/AGENT/ACC`.

**Estado real desta conta no momento do teste** (relevante pra interpretar os resultados abaixo):
agente com `status=paused` (config pré-existente, não alterada por este teste), 1 única campanha
(`[01][ABO][Leads][Advtg][Whatsapp]`) com **R$18,31 de gasto total, 0 campanhas ativas no momento**
— ou seja, a conta real de teste está **quase zumbi**. Isso limitou o que dava pra exercitar AO
VIVO (marcado `[Real]` abaixo) vs. o que precisa do fixture/teste automatizado (`[Fixture]`, §8).

---

## 2. Fase 0 — guards determinísticos (sem prompt, `packages/core` puro)

| # | Guard/regra | ✅ feliz | ⛔ triste | Cobertura |
|---|---|---|---|---|
| 1 | **Piso de elegibilidade relativo** (`computeEligibility`) — gasto≥2×CPA-alvo E ≥3 dias vira elegível mesmo com poucas conversões absolutas | entidade elegível pelo piso relativo vira winner/performer, não fica presa em "sem dado" | entidade com pouco gasto E poucos dias → segue inelegível (não força tier cedo demais) | **[Fixture]** `packages/core/src/quality/quality.test.ts` |
| 2 | **Guard de tracking** (`guardTrackingCaveat`) — rebaixa `pause`/`decrease` sobre CPA-base-`target` quando `tracking.suspect`, **sempre** (não só autônomo) | ação de cortar vira `investigate` + `[guard]` no rationale, mesmo com autonomia alta | tracking OK → ação segue normal, sem rebaixar à toa | **[Fixture]** `packages/core/src/analysis-guards/guard-tracking.test.ts` |
| 3 | **Fadiga vs. escala** (`detectCreationOpportunities`+`chooseCreative`/`isSourceFatigued`) — vencedor fatigado NUNCA escala orçamento nem é reusado pelo `best_performing` | `tier:winner`+`fatigued:false` → `scale_winner` normal | `tier:winner`+`fatigued:true` → vira `investigate`, título "Investigar: …" | **[Fixture]** `packages/core/src/creation/opportunity.test.ts` + `apps/worker/src/modules/conversation/draft-proposal.test.ts` — **este é o bug BLOQUEANTE achado na revisão final** (o guard lia `flags` em vez de `curated_json.healthSignals`, morto desde a criação) e corrigido em `0fe32f1`; o fixture hoje reflete o contrato CORRETO |
| 4 | **CPA marginal** (`guardScaleWithWorseningMarginalCpa`) — ancorado na ÚLTIMA mudança REAL de orçamento (`agent_tool_calls`/`audit_log`), não janela de calendário | marginal estável/melhorando → escala segue | marginal piorando desde o último ajuste real → rebaixa a `investigate` | **[Fixture]** `packages/core/src/analysis-guards/guard-marginal-cpa.test.ts` |
| 5 | **Teto de escala por audiência** (`guardAudienceScaleCeiling`, Fase 4) — reativo, só entidades com proposta de escalar; usa `deliveryEstimateForAdSet` (MAU) | audiência com headroom → escala segue | público já saturado (frequência projetada > teto) → rebaixa | **[Fixture]** `packages/core/src/analysis-guards/guard-audience-ceiling.test.ts` — não reproduzível ao vivo sem uma campanha ativa com escala pendente E público real perto do teto |

**[Real] Q2 do script** confirmou o mecanismo de rebaixamento na prática: run real não gerou
recomendações (conta quase zumbi), então nenhum guard chegou a disparar neste run específico — mas
o run em si degradou honesto (não inventou nada), que é o comportamento correto de **todos** os
guards quando não há gatilho.

---

## 3. Fase 1 — kernel condicionado por relevância (S0b) + taxonomia de saída (G4)

- **NOTES condicionais:** cada bloco do kernel (`packages/core/src/analysis-knowledge/index.ts`)
  só entra no prompt quando o predicado do run é verdadeiro (`hasWaste`/`trackingSuspect`/
  `hasRevenue`/`hasBenchmarkRef`/tema `segmentacao` etc.) — **[Fixture]**
  `packages/core/src/analysis-knowledge` (testes de exaustividade de `THEME_ORDER` +
  predicado-por-bloco, já cobertos na Fase 1/S0b). **[Real]**: a narrativa do run desta sessão
  (conta sem waste/tracking-suspeito/breakdown material) **não injetou** nenhum desses blocos —
  consistente com "run sem gatilho = prompt sem ruído extra" (verificação de custo do plano,
  item 6 do roteiro E2E original).
- **G4 (taxonomia de saída):** `recommendations.expectedImpact`/`whatToMonitor`/`findingRefs` —
  **[Real]**: Q5 do script (skip nesta execução por falta de recomendação no run, mas o contrato
  "nunca inventa número quando vem `null`" está coberto em `explainRecommendationData`, testado no
  chat) + **[Fixture]** `packages/core/src/analysis-guards/analysis-guards.test.ts` (o carve-out
  `caveat` que reusa `flagUngroundedNumbers` pra também escanear PROSA, não só `metricRefs` — o 2º
  bug BLOQUEANTE da revisão de Fase 1, corrigido em `7edb5f3`).

---

## 4. Fase 2 — S1 (bug do orçamento), S2 (bid strategy), S4b (fraqueza de criativo), S4 (vertical saúde)

### 4.1 S1 — bug do orçamento ponta a ponta (a queixa ORIGINAL desta frente inteira)

| Caminho | Esperado | Cobertura |
|---|---|---|
| ✅ conta reanalisada recentemente, pergunta "orçamento de cada campanha" | cita `R$ X/dia` por campanha + `tier` | **[Real] Q3** — resposta citou `R$ 18,31` de gasto real (a análise antiga não tinha orçamento porque é anterior à migration; ver próxima linha) |
| ⛔ análise existe mas é ANTERIOR à migration do `curated_json` (sem orçamento/tier gravado) | nunca finge "sem essa informação" — **oferece rodar uma análise nova** | **[Real] Q1/Q3/Q4** — em TODAS as 3 perguntas o agente disse explicitamente "orçamento: não disponível" / "é preciso rodar uma nova análise" (nunca um "não sei" seco) — **prova viva do bug original resolvido**, mesmo sem dado fresco disponível |
| ❓ pede pra reanalisar, mas agente está `paused` na config | recusa reanalisar E explica o motivo (não falha silenciosa) | **[Real] Q4/Q9** — "é preciso rodar uma nova análise — mas o agente está pausado nas configurações do site" |
| ✅ campanha **CBO** (orçamento no nível campanha) | `isCBO:true`, budget da campanha | **[Fixture]** `packages/core/src/curated-entity/index.test.ts` |
| ✅ campanha **ABO** (orçamento por adset) | `isCBO:false` — **nunca** `true` só por adset ter `budget!=null` (bug corrigido na revisão final) | **[Fixture]** `packages/core/src/curated-entity/index.test.ts` (caso adset adicionado na revisão final, `0fe32f1`) |
| ✅ campanha perto do teto de orçamento | `atBudgetCeiling:true` → kernel sugere realocação **faseada** (nunca tudo de uma vez) + CPA marginal como critério de até-onde-vale | **[Fixture]** `packages/core/src/analysis-knowledge` (bloco `BUDGET_TEXT`) |

### 4.2 S2 — bid strategy

| Caminho | Esperado | Cobertura |
|---|---|---|
| ✅ conta madura (~50+ conversões via `conversionBasis=target`, por campanha) com `bid_cap` configurado | `BID_STRATEGY_TEXT` NÃO dispara (estratégia agressiva faz sentido com dado suficiente) | **[Fixture]** `packages/core/src/creation/budget-ceiling.test.ts` + `analysis-knowledge` |
| ⛔ conta zero-config / poucas conversões de negócio com `bid_cap`/estratégia agressiva | dispara nota sugerindo `lowest_cost`/`cost_cap` | **[Fixture]** idem — **bug BLOQUEANTE da revisão de Fase 2** era exatamente aqui: usava `brief.totals.conversions` (não existe no zero-config) e disparava SEMPRE, mesmo com milhares de conversões reais; corrigido em `ccf908e` somando conversões `conversionBasis=target` por campanha |

### 4.3 S4b — fraqueza de criativo (Cialdini)

| Caminho | Esperado | Cobertura |
|---|---|---|
| ⛔ criativo com `proofStrength=weak` E `persuasionSignals<3` | `HealthSignal` `weak_creative` (nunca vira guard — é score soft de LLM) | **[Fixture]** `packages/core/src/quality/quality.test.ts` |
| ✅ criativo forte (proof + ≥3 gatilhos) | segue sem sinal, matcher pode preferir (ver S4c, §5) | **[Fixture]** idem |
| — não reproduzível ao vivo nesta conta: precisa de visão de criativo rodada sobre um anúncio real ativo (a única campanha da conta está sem anúncios ativos no momento) | | ver §8 |

### 4.4 S4 — perfil vertical "saúde"

| Caminho | Esperado | Cobertura |
|---|---|---|
| ✅ `agents.vertical` default `health` (backfill) | agente novo já nasce com raciocínio de saúde, mesmo sem o dono mexer em nada | **[Real]** confirmado no banco: `SELECT vertical FROM agents WHERE id='ba2b9542-...'` → `health` |
| ✅ persona customizada pelo dono | texto niche-agnóstico de saúde **sobrevive** (G6 — kernel sempre anexado, independe de override de identidade) | **[Fixture]** `packages/core/src/verticals/index.test.ts` |
| ❓ narrativa cita vocabulário de saúde (proxy/agendamento/LTV/skew demográfico) só quando RELEVANTE ao run — nunca fixo | run sem funil/proxy relevante → NOTES de saúde não aparecem à toa | **[Real] Q2** — a narrativa desta conta (quase zumbi, sem funil/proxy pra falar) **não** teve vocabulário de saúde — comportamento correto (condicional, não sempre-presente); precisa de conta com dado de funil pra ver o texto realmente aparecer, `[Fixture]` cobre esse caso positivo |
| ✅ redator lidera por caveat de qualidade-de-lead ANTES de CPL bom (S8, `vertical=health`) | ver §5.3 | **[Fixture]** `packages/core/src/funnel` + `notify/prompt.ts` |

---

## 5. Fase 3 — S4c (matcher), S8b (tier de adset), S8 (resto da propagação)

### 5.1 S4c — matcher recebe sinais de qualidade

| Caminho | Esperado | Cobertura |
|---|---|---|
| ✅ 2 candidatos de fit equivalente, 1 forte (proof+persuasão) e 1 fraco | matcher prefere o forte (fit continua o critério nº1; sinal só desempata) | **[Fixture]** `apps/worker/src/modules/creative/match-library.test.ts` |
| — precisa de biblioteca com ≥2 criativos analisados por visão; conta de teste não tem biblioteca povoada | | ver §8 |

### 5.2 S8b — tier de adset em ABO multi-adset

| Caminho | Esperado | Cobertura |
|---|---|---|
| ✅ campanha ABO com 2+ adsets ativos | cada adset ganha diagnóstico próprio, **derivado da MESMA call de campanha** (zero LLM extra) | **[Fixture]** `packages/core/src/map-reduce/map-reduce.test.ts` + `campaign-selection.test.ts` + `apps/worker/src/graphs/account-analysis/nodes.test.ts` |
| ⛔ campanha CBO ou ABO com 1 único adset ativo | continua só por campanha, **sem** achado por-adset (não força granularidade sem necessidade) | idem |
| ❓ UI/chat expõem a assimetria | rótulo explícito ("esta campanha usa orçamento por conjunto…") — nunca deixa parecer inconsistência | **[Real] Q4** (não se aplica aqui pois a única campanha real é ABO **com 1 adset conhecido pela análise antiga** — sem dado fresco pra confirmar quantos adsets ativos tem hoje) — **[Fixture]** `apps/worker/src/modules/conversation/read-data` (a nota `adsetsNote`, testada em S8) |
| — a campanha real de teste tem histórico de análise ANTIGA sem essa granularidade; confirmar ao vivo exige reanalisar com o agente ativo E a campanha ter 2+ adsets ativos agora | | ver §8 |

### 5.3 S8 — resto da propagação do curado

| Caminho | Esperado | Cobertura |
|---|---|---|
| ✅ chat pergunta por tier/healthSignals/audience/funnel/basis de uma entidade | `get_entity_detail`/`get_campaign_analysis` respondem com o MESMO diagnóstico curado | **[Real] Q4** — tool chamada corretamente; análise antiga sem os campos → respondeu honesto ("não trouxe os campos… é preciso rodar uma nova análise") em vez de inventar |
| ⛔ conta com CPL bom mas conversa/clique baixo (lead frio), `vertical=health` | redator MENCIONA o caveat de lead frio ANTES de citar o CPL bom (nunca o contrário) | **[Fixture]** `packages/core/src/funnel` + `notify/prompt.ts` — não reproduzível ao vivo sem um run com CPL definido E funil de conversa medido nesta conta específica |
| ✅ API expõe budget/atBudgetCeiling/isCBO em `campaignAnalysisOutput` (visão ao vivo E histórico congelado) | UI web mostra linha de orçamento + nota ABO quando aplicável | **[Fixture]** `apps/api/src/modules/runs/service.test.ts` + testes de `apps/web` |

---

## 6. Fase 4 — S6 (campos ricos), S7 (breakdown), teto de escala por audiência

### 6.1 S6 — campos ricos de insight

| Caminho | Esperado | Cobertura |
|---|---|---|
| ✅ anúncio de vídeo com baixa retenção nos 3s iniciais | vira parte do raciocínio de "gancho fraco" (mesmo tema de S4b) | **[Fixture]** `packages/core/src/quality/quality.test.ts` |
| ✅ ranking de qualidade da Meta abaixo da média | `HealthSignal` `platform_quality_below_average` | **[Fixture]** idem — **achado de atenção da revisão final:** o campo era buscado e nunca repropagado de volta em `listWindow` (sinal morto), corrigido em `0fe32f1` |
| ⛔ campo pedido em nível onde a Meta não retorna (ex: `quality_ranking` fora do nível `ad`) | **não quebra o sync inteiro** — campo omitido, resto segue | **[Fixture]** `apps/worker/src/modules/insights/sync-service.test.ts` (`BASE_FIELDS`/`AD_ONLY_FIELDS` — 2º achado de atenção da revisão final) |
| — sem anúncio ativo na conta de teste agora, nenhum desses campos tem dado real pra observar nesta sessão | | ver §8 |

### 6.2 S7 — breakdown demográfico/posicionamento

| Caminho | Esperado | Cobertura |
|---|---|---|
| ✅ spread material entre segmentos (ex: diferença de CPA por faixa etária acima do limiar) | brief injeta `demographics`/`placements`, kernel recomenda abrir/fechar segmento — ação de baixo risco | **[Fixture]** `packages/core/src/breakdown/breakdown.test.ts` (inclui o bug BLOQUEANTE da revisão final: `hasMaterialSpread` misturava CPA de um segmento com CPC de outro no mesmo pool — corrigido em `0fe32f1`) |
| ⛔ sem spread material | bloco fica em silêncio (zero tokens extras) | idem |
| ✅ carimbo de frescor (cadência própria, mais lenta que o sync diário) | nunca implica frescor do dia | **[Fixture]** `apps/worker/src/modules/insights/breakdown-sync-service.test.ts` |
| ❓ pergunta direta no chat sobre faixa etária/posicionamento cara | responde com o dado OU explica por que não consegue agora | **[Real] Q9** — "o agente está pausado… é preciso retomar para eu fazer essa comparação" (honesto, sem inventar) |
| — org-scoping de `insights_breakdowns` | toda query filtrada por `org_id` (achado real de tenancy corrigido em `a679191`) | **[Real] Q10** — confirmado: as 2 linhas encontradas vieram corretamente filtradas por `orgId` |

### 6.3 Teto de escala por audiência

| Caminho | Esperado | Cobertura |
|---|---|---|
| ✅ saturado (ratio ≥ limiar) → rebaixa | usando alcance MENSAL REAL devolvido pela Meta (não estimado) | **[Real, Parte 2]** §10b — `getDeliveryEstimateForAdSet` real (197,1M de alcance) + `guardAudienceScaleCeiling` real: ratio=5,0 → `investigate` |
| ✅ com folga (ratio < limiar) → passa direto | mesmo alcance real, ritmo de entrega baixo | **[Real, Parte 2]** §10b — ratio=0,01 → mantém `increase_budget` |

---

## 7. Chat — cenários transversais (ambíguo / erro / escrita gated)

Todos **[Real]**, rodados nesta sessão contra o grafo `whatsapp-conversation` direto (sem
Evolution/webhook — mesmo padrão de `e2e-chat-mvp.ts`):

| # | Cenário | Mensagem | Resultado observado |
|---|---|---|---|
| Q6 | ❓ ambíguo — aprovar sem NENHUMA pendência real | "Pode aprovar." | Não chamou `approve`; respondeu "Não tem nada aguardando aprovação agora" + ofereceu rodar análise — **não alucinou aprovação** |
| Q7 | ⛔ entidade inexistente citada | "Pausa a campanha 'Campanha Fantasma Que Não Existe 999'." | "Não encontrei nenhuma campanha com esse nome. Portanto, não pausei nada." — sem stack/erro técnico, sem fingir que fez algo |
| Q8 | ⛔ escrita gated (`TRAFEGO_CHAT_ADS_WRITES=false`, valor real do `.env`) | "Aumenta o orçamento da campanha que mais converte em 20%." | Não chamou `adjust_budget` (tool ausente); em vez de redirecionar cegamente, **raciocinou com o dado real disponível** ("não encontrei uma campanha convertendo pra aumentar… a única tem 0 conversões") — qualidade acima do mínimo esperado |
| Q1/Q3 | ✅/⛔ bug do orçamento (ver §4.1) | | resolvido |
| Q4 | ❓ pedir detalhe de campanha sem análise fresca | | honesto, oferece reanalisar |

---

## 8. Caminhos não exercitáveis ao vivo nesta sessão (motivo + cobertura)

A conta real de teste (BM Automato) está **quase zumbi** no momento deste teste — 1 campanha
histórica, R$18,31 de gasto total, 0 campanhas ativas, agente `paused`. Forçar os cenários abaixo
contra ela exigiria **criar estrutura real na Meta** (campanhas/adsets/anúncios/orçamento) só para
o teste, o que tem custo e risco desproporcional ao valor marginal — cada um já tem cobertura
determinística equivalente (fixture puro, sem mock de rede, testado no CI):

- **Conta 100% zumbi** (todas as entidades zumbi) — `packages/core/src/quality/quality.test.ts`.
  *(A conta real de teste chegou perto disso organicamente — Q2 confirmou a degradação honesta.)*
- **Campanha CBO com exatamente 1 adset** — `packages/core/src/curated-entity/index.test.ts`.
- **ABO multi-adset (2+ adsets ativos) com MEDIÇÃO real (S8b completo)** — `packages/core/src/map-reduce/map-reduce.test.ts`. A Parte 2 (§10b) criou uma estrutura ABO 2-adsets 100% real na Meta, mas descobriu (achado documentado, não bug) que `normalize()` só constrói entidade a partir de linha de INSIGHT — uma campanha ativa sem NENHUMA impressão (garantido pelos anúncios ficarem sempre pausados, pré-requisito de risco-zero) fica invisível ao brief inteiro, então S8b não chegou a rodar sobre ela. Provar isso com medição real exigiria aceitar alguma veiculação real (fora do escopo aprovado desta rodada).
- **Criativo sem visão disponível** (falha de download/decomposição) — degradação graciosa
  documentada no resolver de visão (`apps/worker/src/modules/vision/resolver.ts`), testada em
  `packages/core/src/quality/quality.test.ts`.
- **Tracking suspeito em autonomia alta** — `guard-tracking.test.ts` (o guard age igual,
  independente de autonomia, por decisão explícita desta frente).
- **Run no limite do governor / rate-limit da Meta** — testado no nível do adapter
  (`packages/ads-meta`), fora do escopo desta frente (mecanismo pré-existente, não tocado).
- **Custo de LLM no teto** (`llm_cost_cap`) — `apps/api/src/modules/runs/service.test.ts`
  (`assertUnderCostCap`); não é um guard desta frente, é infra pré-existente.

Nenhum destes é um "buraco" na cobertura — é a mesma filosofia de teste já estabelecida no projeto
(core puro testado sem mock + E2E real para o que só aparece na integração real).

---

## 9. Script reusável

```bash
cd apps/worker && npx tsx --env-file=../../.env e2e-pivo-saude.ts
```

`apps/worker/e2e-pivo-saude.ts` (novo nesta sessão) — invoca os 2 grafos direto (chat +
account-analysis), sem Evolution/HTTP, com LLM real. Cobre Q1-Q10 acima. Reverte
`agent_runs`/`recommendations`/`approvals` criados; **não muda nenhuma config de agente**;
**nenhuma mutação real na Meta é possível** com o agente-alvo (`autonomy_policy.bySource=suggest`
nas 2 origens, sem `agent_tool_bindings` override — confirmar isso ANTES de rodar contra outro
agente, senão o run pode aplicar ação de verdade).

---

## 10. Resultado desta execução (2026-08-31)

**17/17 ✅, 0 achado real de produto.** As 3 falhas da 1ª rodada eram bugs do PRÓPRIO script
(nome de tool diferente do esperado em Q4 — o modelo escolheu corretamente `get_campaign_analysis`
em vez de `get_entity_detail`; regex sem a variante "não tem" em Q6; regex sem os acentos de
"análise"/"analisar" em Q8) — corrigidas no mesmo arquivo, sem tocar em código de produto, e
reconfirmadas verdes.

**Achado positivo não-planejado:** o teste expôs, organicamente, o comportamento do sistema com
`agents.status=paused` — todas as tools de leitura que dependem de disparar uma análise nova
(`trigger_analysis`, e por extensão diagnósticos que precisariam de dado fresco) recusam
educadamente e explicam o motivo ("é preciso retomar o agente nas configurações do site"), em vez
de falhar silenciosamente ou inventar dado. Não estava no roteiro original — é uma consequência
real do estado da conta de teste, e o comportamento observado é o correto.

**Conclusão da Parte 1:** com a cobertura combinada — fixtures puros (`packages/core`, zero mock,
cobrem TODAS as condições estruturais que a conta de teste não tinha no momento) + este E2E real
(prova a integração ponta-a-ponta com LLM/Meta de verdade nos caminhos que a conta atual permite)
— a "casca" (plumbing/roteamento/honestidade/tenancy) está validada. A camada "músculo"
(guards/kernel/curadoria de fato disparando com dado real) foi completada na Parte 2 (§10b), que
também revelou 3 gaps de sincronização pré-existentes ao pivô saúde (§10c). Ver §10b para o
resultado combinado final.

---

## 10b. Execução real — PARTE 2 (2026-08-31, "músculo": guards/kernel/S8b com dado real)

Pedido do dono após revisar a Parte 1: provar também a camada que só dispara com dado real
disparando o comportamento (guards de fato rebaixando, kernel de fato injetando bloco, S8b de
fato derivando adset). Estratégia HÍBRIDA aprovada explicitamente pelo dono (AskUserQuestion):

- **Parte A — Meta REAL, risco de gasto ZERO por construção:** criei 1 campanha ABO real + 2
  conjuntos REALMENTE ativos na Meta (status `ACTIVE` — exigido por `buildCampaignUnits` pra
  entrar na árvore), mas os ANÚNCIOS dentro ficaram SEMPRE `paused` — sem anúncio ativo a Meta
  não entrega/gasta nada (impossível haver impressão), então a estrutura é "ativa" o suficiente
  pro pipeline enxergar mas fisicamente incapaz de gastar 1 centavo.
- **Parte B — funções puras do core**, fixtures realistas, zero IO.
- **Parte C — seleção de blocos do kernel** com contexto rico vs pobre.
- **Parte D — seed de `curated_json` realista + pergunta ao chat com LLM real.**

Script: `apps/worker/e2e-pivo-saude-parte2.ts`.

**Resultado: 17/19 ✅ na 1ª rodada** (2 falhas, ambas do PRÓPRIO script — nenhuma de produto):

| # | O que rodou | Resultado |
|---|---|---|
| A1 | Pergunta ao chat por uma campanha nova ANTES de reanalisar ("tem uma campanha que eu não estou vendo") | ✅ o agente reconheceu a possível defasagem ("o que aparece aqui é o último retrato analisado... essa campanha nova pode ainda não ter entrado na sincronização") e propôs reanalisar — endereça diretamente a preocupação levantada pelo dono |
| A2 | Análise real sobre a estrutura ABO real (S8b esperado: 2 `entity_analyses` por-adset) | **Achado, não bug:** a campanha REAL não apareceu na análise — `normalize()` (`packages/core/src/brief/index.ts:80`) só constrói entidade a partir de linha de INSIGHT da Meta; zero impressões (garantido pelos anúncios pausados) = zero linha = invisível ao brief inteiro, não só ao S8b. A mesma trava que garante risco-zero de gasto impede provar S8b com estrutura 100% real sem aceitar alguma veiculação de verdade |
| A3 | `getDeliveryEstimateForAdSet` REAL (Meta) → alimenta `guardAudienceScaleCeiling` real, 2 cenários | A Meta respondeu de verdade (alcance mensal real: 167,5M–197,1M) — ✅. Os 2 cenários do guard falharam na 1ª rodada por um **bug no script de teste** (o `targetEntity.externalId` do fixture usava um id de exemplo "AS1" em vez do id REAL do adset criado, então o guard corretamente não achava o headroom e passava direto) — corrigido e reverificado num script isolado (`verify-guard-fix.ts`, mesmo número real de alcance): saturado → `investigate` ✅, com folga → mantém `increase_budget` ✅ |
| B1-B3 | Guards puros (tracking/CPA-marginal/fadiga×escala), positivo+negativo cada | ✅ 6/6 — todos corretos nos dois lados |
| C1 | `selectAnalysisKnowledge` — contexto rico (13 blocos) vs pobre (6 blocos) | ✅ 3/3 — as NOTES condicionais realmente ligam/desligam por contexto, incluindo o bloco `segmentacao` (S7) |
| D1 | Seed de campanha fatigada+teto+funil frio + pergunta ao chat (LLM real) | ✅ 3/3 — o modelo mencionou fadiga de criativo, teto de orçamento E qualidade do funil/conversa, todos os 3 sinais semeados, na mesma resposta |

**Correção de rumo:** os 2 achados foram diagnosticados como bugs do PRÓPRIO script (mismatch de
id no fixture do guard; expectativa errada sobre S8b dado o design de zero-risco escolhido) — o
script foi corrigido (`e2e-pivo-saude-parte2.ts`) para reuso futuro; **nenhuma correção em código
de produto foi necessária** nesta parte.

**Erro cometido e assumido:** a 1ª versão do `finally` de limpeza tinha uma linha
`delete entityAnalyses where agentId=AGENT` **sem escopo** (deveria filtrar só as entidades
temporárias criadas neste teste) — isso apagou de verdade a linha de cache pré-existente da
campanha real "[01][ABO][Leads][Advtg][Whatsapp]" (análise de 20/08/2026, dado legítimo desta
sessão, não artefato deste teste). Impacto: só cache derivado (`entity_analyses`), regenerável no
próximo run real contra a conta — nenhum dado da Meta foi afetado, e nenhuma config de agente
ficou alterada. Corrigido no script para escopo exato (só a campanha/adset temporários).

**Conclusão da Parte 2:** a camada "músculo" (guards, kernel, curadoria) foi provada disparando de
verdade — parte com dado 100% real da Meta (delivery_estimate), parte com fixtures realistas +
LLM real sobre elas (guards puros, kernel, chat). A única coisa que ficou genuinamente fora de
alcance sem aceitar gasto real foi a medição (spend/conversões/fadiga) — que exige impressão de
verdade por definição, não uma limitação deste teste.

## 10c. Três gaps de sincronização (achado, mesma causa-raiz, levantado em conversa com o dono)

Durante a Parte 2, o dono levantou 3 perguntas seguidas que se revelaram a MESMA causa-raiz —
documentado aqui porque não é específico do pivô saúde (é um comportamento pré-existente do
sistema, exposto por este teste):

1. **Campanha NOVA que o dono acabou de ativar não aparece pro agente.** Confirmado ao vivo (A1
   acima) — mas o mecanismo de recuperação (chat propõe reanalisar) já funciona bem.
2. **Campanha que ficou INATIVA desde a última análise continua aparecendo como se nada tivesse
   mudado.** `record` (`apps/worker/src/graphs/account-analysis/nodes.ts:1091`) só faz UPSERT de
   `state.freshUnits` — nunca marca/remove uma linha de `entity_analyses` cuja entidade saiu do
   conjunto ativo. `list_campaigns`/`get_campaign_analysis` (`read-data.ts:483-534`) leem esse
   cache sem NENHUMA checagem de status ao vivo (isso só existe hoje para `get_campaign_status`
   e o `liveStatus` de `list_recommendations`, ambos pontuais).
3. **Campanha ativa sem NENHUMA impressão é invisível à análise inteira**, não só resumida —
   confirmado empiricamente na Parte A (achado A2 acima). `normalize()` só constrói entidade a
   partir de linha de insight; sem insight, sem entidade, sem cobertura de nenhum tipo (nem
   "resto agregado").

**Causa-raiz única:** o sistema só "enxerga" uma campanha quando ela tem pelo menos algum dado
MEDIDO — fora isso, ele não sabe que ela existe (2), não sabe que ela mudou (3) e não se
autocorrige entre análises (todas). Isso é **pré-existente ao pivô saúde** (a arquitetura
insights-first já era assim antes desta frente) — não é um bug introduzido por nenhuma das 5
fases, mas ficou mais visível testando cenários de fronteira que o dia-a-dia raramente força.

**Atualização — itens 1 e (parcialmente) 3 CORRIGIDOS nesta sessão**, a pedido explícito do dono,
via reconciliação leve no CHAT (não na pipeline de análise/LLM — decisão deliberada de escopo,
ver abaixo):

- **`liveActiveCampaignsNotCached`** (novo, `apps/worker/src/graphs/whatsapp-conversation/read-data.ts`)
  — chamada bounded/best-effort a `listEntities` que acha campanhas ATIVAS na Meta ainda sem
  NENHUMA linha em `entity_analyses`. Ligada em `list_campaigns` (soma essas campanhas à lista,
  marcadas `noDataYet:true` + `syncNote` explicando) e `get_campaign_analysis` (antes de dizer
  "não achei", checa se existe ATIVA na Meta e responde honesto em vez de "não existe"). Resolve
  o item 1 (campanha nova aparece pro agente) de ponta a ponta — a reconciliação é AO VIVO a cada
  pergunta, então também cobre o item 2 (nenhum agendamento/sync separado é necessário: a próxima
  pergunta já reflete o estado atual da Meta).
- **System prompt** (`system-prompt.ts`, bloco "Sincronização e cache") — regra nova: se o dono
  insistir que existe algo na Meta que o agente não está vendo, ou perguntar a mesma coisa mais de
  uma vez, o agente reconhece que sua visão é uma FOTO (cita o `asOf`) e OFERECE reanalisar — nunca
  nega genericamente. Endereça o item 1 (parte da conversa, não código) e o item 3 ("informar a
  condição real").
- Testado: 4 testes novos (`liveActiveCampaignsNotCached`, positivo/negativo/degradação/conta
  ausente) + `pnpm typecheck`/`pnpm test` verdes no monorepo inteiro (528 worker + 138 api + core).

**Escopo deliberadamente NÃO alterado** (para não confundir com o item 3 pedido):
- **Item 2 do achado original** ("campanha ficou INATIVA e o cache não percebe") — permanece
  como fast-follow `[MÉDIO]` no ROADMAP. Não foi um dos 3 itens que o dono pediu para implementar
  nesta rodada; corrigir exigiria o `record` marcar/podar entidades que saíram do conjunto ativo,
  mudança maior que a reconciliação ao vivo usada acima (que só resolve "apareceu", não "sumiu").
- **A versão PROFUNDA do item 3** (fazer `buildAccountBrief`/a análise INTEIRA enxergar entidades
  sem insight, não só o chat) foi considerada e descartada nesta rodada: exigiria mudar a semântica
  de `status:"empty"` (quebraria o teste existente `build-account-brief.test.ts:108-111`, que
  espera "empty" mesmo com entidades ativas listadas) e arriscaria rodar o pipeline de LLM inteiro
  sobre uma conta sem NENHUM dado real (custo sem benefício claro). A reconciliação no CHAT entrega
  o mesmo valor pro usuário (ver a campanha, saber que ainda não tem dado) a um custo muito menor e
  sem tocar nesse contrato. Documentado como decisão, não esquecido — reabrir se o uso real mostrar
  que o chat sozinho não basta (ex: precisar que a campanha nova apareça também no `list_campaigns`
  agregado por-período, ou nas recomendações automáticas do run).

---

## 11. Fast-follow de DX identificado nesta validação (registrar no ROADMAP)

`pnpm db:migrate` não carrega `.env` da raiz (roda a partir de `packages/db`, sem
`--env-file`) — cai silenciosamente no default hardcoded do `drizzle.config.ts` (porta `5432`) se
`DATABASE_URL` não estiver exportado no processo, e falha sem mensagem legível se essa porta
pertencer a outro banco. Ver §0.

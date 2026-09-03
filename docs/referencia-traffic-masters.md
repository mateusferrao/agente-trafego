# Referência — conhecimento de tráfego destilado (Traffic Masters)

> **Fonte:** squad de marketing `DA-Estrategic-Squad-MKT` → `traffic-masters/` (tasks, agents,
> data). Material de referência **externo**, destilado **fielmente** (não copiado na íntegra; o
> pacote BMAD original **não** é versionado neste repo). Este doc é a fonte da verdade do que o
> analista de IA aplica via `packages/core/src/analysis-knowledge` (Fatia E) — cada bloco de
> conhecimento lá referencia um tema abaixo. Números são citados textualmente da fonte; onde a
> fonte não dá número, está marcado.

## 1. Escala — método BPM (Budget/Performance/Metrics): vertical × horizontal × diagonal

Fonte: `tasks/scale-campaign.md`, `agents/scale-optimizer.md`. Gatilho = gap entre CPA/ROAS atual e a meta.

| Método | Gatilho (gap current→target) | O que é | Regra/incremento |
|---|---|---|---|
| **Vertical** | `< 2x` | subir orçamento nas campanhas existentes | **+20% a cada 48–72h** (task) / 20–30% (agent); **nunca >20% num único dia**; **reset se CPA subir >30% em 48h** (agent: pausar escala se CPA sobe >20%) |
| **Horizontal** | `2x–5x` | duplicar vencedores para NOVAS audiências | duplicar adsets/ads vencedores; lookalikes crescentes |
| **Diagonal** | `5x+` | novas plataformas + novos ângulos | portar criativo vencedor p/ nova plataforma; novos ângulos contra audiências provadas |

**Sequência:** validar → vertical → horizontal → plataforma ("vertical primeiro, horizontal quando o vertical dá retorno decrescente"). **Validação antes de escalar:** CPA abaixo da meta por **5+ dias consecutivos**; **7–14 dias mínimo** de dados.

**Marginal CPA** (até onde escalar): `marginal CPA = Δgasto / Δconversões`; escalar é lucrativo enquanto `marginal CPA < LTV`; cuidado com "média mascara o problema" (marginal piora enquanto a média ainda parece boa). *(Já usado no projeto pela ressalva de escala, Fatia A.)*

## 2. Teto de escala por audiência

Fonte: `tasks/scale-campaign.md` Phase 1 (literal):

> **`tamanho da audiência / (teto de frequência × CPM) = gasto diário máximo`**

**Frequência** (`data/platform-benchmarks.yaml` facebook): prospecção máx **2.5**; remarketing máx **8.0**; sinal de fadiga "CTR cai quando a frequência passa de **3.0** em audiência fria". *(A fonte é levemente inconsistente: warning em 2.5, fadiga em 3.0 — registrado.)* *(No projeto: `computeScaleRessalvas` já usa o teto de audiência via `getDeliveryEstimateForAdSet` + `DEFAULT_AUDIENCE_CEILING_THRESHOLDS`.)*

## 3. Cadência de refresh de criativo

Fonte: `tasks/scale-campaign.md` Phase 3, `agents/creative-analyst.md`.
- **Audiência pequena: criativo novo a cada 5–7 dias. Audiência grande: 14–21 dias.**
- Manter "creative bank" de **5–10** anúncios prontos; **2–3** criativos novos prontos antes de escalar.
- **Sinais de fadiga** (trocar quando **2+** presentes): CTR caindo **>20% semana-a-semana**; frequência **>3.0**; CPA subindo **>30% do baseline**; engajamento caindo.

## 4. Vetos consolidados ("nunca faça")

Fonte: seções *Veto Conditions* dos tasks + regras "NEVER" dos agents.
- Nunca escalar com **<7 dias** de dados estáveis; nunca escalar campanha não-provada.
- Nunca subir orçamento **>20% num único dia**; nunca **>2x** num dia.
- Nunca escalar sem **pipeline de criativo** pronto (bate fadiga) nem com **tracking** não-confiável.
- Nunca **matar em learning phase** — esperar significância estatística.
- Nunca **cortar um vencedor** pra financiar um experimento.
- Nunca **realocar 100%** do orçamento num único dia (learning exige gradual); reduzir→monitorar→decidir antes de zerar campanha lucrativa.
- Nunca auditar com **<30 dias**; nunca analisar com **<7 dias** (janela curta = ruído).
- Nunca concluir de dado estatisticamente insignificante; nunca recomendação sem próximo passo acionável.
- *(Não está na fonte: o veto "não pausar prospecção só por CPA atribuído" — é conceito do PROJETO, `INCREMENTALITY_TEXT`, não do squad.)*

## 5. Benchmarks NÃO-monetários (default de plataforma; `data/platform-benchmarks.yaml`)

Cabeçalho da fonte: "médias direcionais — variam por criativo/oferta/qualidade de audiência". **Meta (facebook):** CTR média `0.90%` / bom `1.5%+` / ótimo `2.5%+`; CVR média `9.2%` / bom `12%+` / ótimo `15%+`; frequência prospecção `2.5` / remarketing `8.0`. **YouTube hook:** retenção 5s alvo `70%+`, 30s `45%+`, "<50% em 5s = gancho ruim". **TikTok hook:** `30%+` passam de 3s (ótimo `50%+`). **Thumb-stop** (creative-analyst): `>30%` (3s views / impressões). *(Monetários — CPM/CPA/CPC/ROAS em USD — ficam CONFIGURÁVEIS por `MarketReference`, não viram default de plataforma: variam demais por mercado/moeda.)*

## 6. Scorecard de saúde de conta — 8 dimensões

Fonte: `tasks/audit-ad-account.md` (cada dimensão 1–10, total `/80`): **1. Structure · 2. Targeting · 3. Creative · 4. Budget · 5. Bidding · 6. Tracking · 7. Funnel Alignment · 8. Performance.** No projeto = uso **interno** (prompt/priorização do analista+revisor); a UI mantém `grade`+`biggestLeak` (sem mudança de schema).

**Tiers** (audit Phase 2): Winners (acima da meta → escalar) · Performers (na meta → otimizar) · Underperformers (abaixo/declinando → corrigir ou matar) · Zombies (baixo gasto/volume, sem propósito → matar). *(Já implementado no projeto, `packages/core` tiers.)*

**Diagnóstico causa-raiz por métrica** (árvore): CTR baixo → fadiga de criativo ou targeting; CTR ok + CVR baixo → página/oferta; CVR ok + CPA alto → lance/orçamento; alcance baixo → público estreito ou orçamento baixo. *(Já em `DIAGNOSIS_TEXT`.)*

---

**Inconsistências internas da fonte (registradas, não resolvidas por invenção):** incremento vertical 20% [task] vs 20–30% [agent]; frequência warning 2.5 vs fadiga 3.0; share de budget de topo 50–60% [yaml de funil] vs 60–80% [agents]. Quando o projeto precisa de um número único, escolhe o mais CONSERVADOR e documenta.

# Validação manual — Roy estrategista (Fase 2: S1/S2/C1/C3/C2/U1)

Roteiro de validação da segunda fase da reescrita das instruções do Roy (estrategista de
tráfego que recomenda estrutura + planeja, com CBO/ABO, Advantage e multi-conjunto). Todos os
comportamentos são **RECOMENDAÇÃO** — a palavra final é sempre do dono; nada aplica sem "sim".

Pré-condições: conta Meta ativa conectada com ao menos 1 anúncio de onde herdar Página/pixel/
criativo; `create_campaign` ligado (ações permitidas); escrita conversacional ON.

## S1 — Próximo passo proativo (crescimento)
1. Rode uma análise (`analisa agora`) numa conta com um vencedor provado (winner + significância,
   sem saturação). → O push fecha com 1-2 linhas FORWARD-LOOKING de **escalar o vencedor**
   ("Pensando no próximo passo pra crescer: o vencedor tem espaço pra escalar…"), distinta das
   recomendações corretivas.
2. Numa conta com o vencedor SATURADO (frequência alta / audience_saturation) → a linha vira
   **testar público novo** (cresce horizontal, não subindo verba).
3. Numa conta com criativo envelhecendo (creative_aging, ainda entrega) → **preparar o próximo
   criativo**.
4. Sem nenhum movimento claro → NÃO aparece linha (degrada em silêncio).
5. Desligue `notify_policy.nextStep` (config) → a linha some.

## S2 — Plano inerente à conversa
1. Pergunte "como eu cresço?" ou "o que eu faço agora?". → O Roy ANCORA no diagnóstico real
   (última análise via list_recommendations/list_pending, ou oferece `trigger_analysis` se não
   houver recente), NUNCA num plano genérico; depois propõe a SEQUÊNCIA de próximos passos (o que
   testar, o que escalar, quando renovar o criativo) com estruturas concretas, em texto.
2. Pergunte "o que você faz?" → `describe_capabilities` menciona o planejamento inerente.

## C1 — CBO/ABO selecionável (criação)
1. "cria uma campanha de vendas" → o eco fala orçamento **em linguagem de negócio** ("orçamento
   único na campanha, a Meta distribui entre os conjuntos") — NUNCA "CBO"/"ABO" cru.
2. "cria um teste isolado de 1 criativo" (intent isolated_test) → orçamento **por conjunto** (ABO).
3. "escala a campanha X" (intent scale) → orçamento único na campanha (CBO).
4. "cria com orçamento por conjunto" (override budgetMode=abo) → o dono vence o default.
5. Peça um orçamento abaixo do mínimo da Meta (ex: R$0,50/dia) → o eco RECOMENDA subir pro mínimo,
   nunca trava.
6. Copie uma campanha (`copy_campaign`) cuja original é CBO → o eco descreve o orçamento em
   linguagem de negócio (regressão da sigla crua `.toUpperCase()`).

## C3 — Advantage por inferência, sempre confirmado
1. "cria uma campanha" pra um negócio AMPLO/nacional (businessContext amplo) → o Roy recomenda
   LIGAR o Advantage; o eco+confirma AVISA que a Meta pode expandir o público e ALTERAR imagem/
   texto (o criativo entregue pode sair diferente do aprovado). Nada aplica sem "sim".
2. "cria uma campanha" pra negócio LOCAL (ex: clínica de bairro) → recomenda DESLIGAR (público
   fixo); o eco diz "público e criativo exatamente como você aprovou".
3. "liga o Advantage" / "tira o Advantage" (override explícito) → o dono vence a inferência.
4. Aprove um rascunho com Advantage ON → confira na Meta que o conjunto EXPLÍCITO saiu com
   `targeting_automation.advantage_audience: 1` e o adcreative com `degrees_of_freedom_spec.
   creative_features_spec` (features em OPT_IN). Sem Advantage → `advantage_audience: 0` e sem
   `degrees_of_freedom_spec` (comportamento pré-C3 preservado).
5. Regressão: `edit_audience` (adjust_audience) de um adset vivo NÃO liga expansão (segue fixo).

## C2 — Multi-conjunto 1-N-M (backend + apply)
1. Peça um teste de vários públicos (intent audience_test). → Hoje o chat monta **1 conjunto** com
   o público mais forte + nota honesta roteando pro site pra adicionar os demais (produtor multi
   no chat = fast-follow).
2. (Quando houver um rascunho multi-conjunto — via o produtor do fast-follow) Aprove-o e confira na
   Meta: 1 campanha, N conjuntos (cada um seu público), o MESMO criativo referenciado nos anúncios
   de TODOS os conjuntos (criativo criado UMA vez, não N×M). CBO → verba na campanha; ABO → cada
   conjunto com seu orçamento.
3. Ativação (2ª aprovação): confira que TODOS os N conjuntos + N×M anúncios saem de pausado
   (a Meta não cascateia status — a árvore inteira é ativada).
4. Retomada: simule uma falha transiente no meio da criação de um multi-conjunto → o retry pula o
   que já foi criado (campanha/conjunto/criativo/anúncio), sem duplicar gasto.

## U1 — Site (render dos N conjuntos + honestidade)
1. Abra `/approvals` com um rascunho multi-conjunto pendente. → O card mostra o rótulo de negócio
   do orçamento (nunca a sigla), a lista dos N conjuntos (nome + público resumido + orçamento,
   "mesmo criativo"), e o aviso de Advantage quando `advantageCreative` ON (a aprovação via site
   não perde a honestidade do chat).
2. `tokens:check` verde (sem cor hardcoded).

## Invariantes a confirmar em TODOS os cenários
- Toda estrutura/Advantage/próximo passo é RECOMENDAÇÃO; o dono sobrepõe e a palavra final é dele.
- Eco+confirma antes de QUALQUER escrita; nada aplica sem "sim"; criação nasce pausada + 2ª aprovação.
- NUNCA a sigla técnica CBO/ABO no que vai pro dono (chat E site).
- Sem cara de IA: sem travessão dramático como conector nas mensagens.

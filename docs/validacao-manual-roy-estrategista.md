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
1. Aprove um rascunho multi-conjunto e confira na Meta: 1 campanha, N conjuntos (cada um seu
   público), o MESMO criativo referenciado nos anúncios de TODOS os conjuntos (criativo criado UMA
   vez, não N×M). CBO → verba na campanha; ABO → cada conjunto com seu orçamento.
2. Ativação (2ª aprovação): confira que TODOS os N conjuntos + N×M anúncios saem de pausado
   (a Meta não cascateia status — a árvore inteira é ativada).
3. Retomada: simule uma falha transiente no meio da criação de um multi-conjunto → o retry pula o
   que já foi criado (campanha/conjunto/criativo/anúncio), sem duplicar gasto.

## P1 — Produtor multi-conjunto no CHAT (create)
1. "testa interesse em corrida, ciclismo e natação" → o Roy monta **3 conjuntos** (1 por segmento,
   mesmo criativo), eco lista os conjuntos + "orçamento único na campanha" (nunca a sigla). Nasce
   pausado, eco+confirma.
2. Público ambíguo num segmento ("futebol") → o Roy PERGUNTA (nunca chuta o interesse).

## P2 — Editar o teste no CHAT (adjust_draft)
1. Com um teste multi-conjunto proposto: "adiciona um conjunto de corredores" → novo conjunto no
   eco; "tira o conjunto 2" → some do eco (sobrar 1 = volta a 1 conjunto).
2. Num rascunho de 1 conjunto: "adiciona um conjunto de ciclistas" → vira teste (o público atual é
   o conjunto 1), FORÇA orçamento único na campanha (CBO), nota honesta ("mesmo criativo em todos…").
3. **GUARD (diz×faz):** num teste multi-conjunto, "muda o interesse pra corrida" (sem dizer qual
   conjunto) → o Roy BLOQUEIA honesto: por aqui adiciona/remove conjuntos inteiros; editar o público
   de um conjunto é no site. NÃO aplica um no-op silencioso.

## P3/P4 — Site edita N conjuntos (draft-edit-panel)
1. Abra `/approvals` com um rascunho multi-conjunto pendente. → O card mostra o rótulo de negócio
   do orçamento (nunca a sigla), a lista dos N conjuntos (nome + público resumido + orçamento,
   "mesmo criativo"), e o aviso de Advantage quando `advantageCreative` ON.
2. No painel de edição: cada conjunto tem seu `GeoAudienceEditor` (público) + orçamento (ABO) +
   `creative-picker` (criativo próprio, mesma copy) + adicionar/remover conjunto (mín 2, teto 8). Salvar →
   `adsets[]` no `UpdateDraftInput`; a saga cria criativo EXCLUSIVO no conjunto com `creative`, senão
   reusa o compartilhado.
3. **Round-trip do criativo por-conjunto (sem perda):** ponha um criativo próprio no conjunto 2, salve;
   reabra, mude SÓ o orçamento do conjunto 1, salve de novo → o criativo próprio do conjunto 2 CONTINUA
   (não volta pro compartilhado). O painel manda `keepCreativeIndex` pros conjuntos que já tinham
   criativo e não foram trocados; e só manda `adsets` quando algum conjunto mudou (salvar sem mexer em
   conjunto não reescreve a lista — não clobba uma edição concorrente do chat).
4. `tokens:check` verde (sem cor hardcoded); `ng build` verde (validação de template real).

## S3/S4/S5 — Escolha de criativo estratégica (fit + foco + crítica)
Pré: conta com anúncio ativo (pra herdar Página/criativo) + `TRAFEGO_CHAT_ADS_WRITES=on`.
1. **Foco perguntado (S4).** "cria uma campanha de vendas pra SP". → o Roy PERGUNTA o foco do criativo
   numa mensagem só: o ângulo (o que destacar) + reusar o que converte × testar algo novo. Responda
   "destaca a prova social e reusa o que funciona" → ele monta reusando o vencedor, sem re-perguntar.
   Se você JÁ disser tudo no 1º pedido ("cria... reusando o campeão, foco em oferta"), ele NÃO re-pergunta.
   "tanto faz, você escolhe" → ele segue sem travar (escolhe por contexto/desempenho).
2. **Fit cross-stage (S3).** Numa conta cujo melhor anúncio rodou em PROSPECÇÃO fria, peça uma campanha
   de REMARKETING ("cria uma campanha pro meu público de clientes"). → o Roy NÃO herda cru o vencedor
   frio; cai na biblioteca por contexto (o eco mostra o criativo escolhido). O inverso (vencedor de
   remarketing → campanha de prospecção) também. Estágio desconhecido → herda o vencedor (neutro).
3. **Crítica "não só faz" (S5).** Quando o melhor criativo está AGING (desgastando mas ainda entrega),
   o Roy PROPÕE reusando + adiciona a nota "Sobre o criativo: ...ainda entrega, mas já dá sinais de
   desgaste — vale deixar o próximo pronto...". Ele NÃO trava e a criação segue aprovável. Pick limpo
   (provado, sem fadiga) → SEM nota de crítica (não polui). Nada casa bem → recomenda criar um novo.
4. `pnpm --filter @trafego/core --filter @trafego/worker test` verde; `typecheck` verde.

## Invariantes a confirmar em TODOS os cenários
- Toda estrutura/Advantage/próximo passo/CRIATIVO é RECOMENDAÇÃO; o dono sobrepõe e a palavra final é dele.
- Eco+confirma antes de QUALQUER escrita; nada aplica sem "sim"; criação nasce pausada + 2ª aprovação.
- NUNCA a sigla técnica CBO/ABO no que vai pro dono (chat E site).
- Sem cara de IA: sem travessão dramático como conector nas mensagens.

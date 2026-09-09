# Roteiro de validação manual — Produtor de multi-conjunto (teste de público 1-N-M)

> Cobre as mudanças desta sessão (PR #14): o **produtor de multi-conjunto** no chat e no site —
> criar, editar e aplicar um teste de público com N conjuntos, mesmo criativo (ou criativo próprio
> por conjunto no site). Slices: **P1** (chat cria N conjuntos), **P2** (chat edita o teste),
> **P3** (API + saga com criativo por-conjunto), **P4** (painel do site edita N conjuntos),
> **P6** (round-trip do criativo, pisos, colapso).
>
> **Como ler:** cada passo é **Ação → Esperado**. "Roy" = agente no WhatsApp. Todo write nasce sob
> **eco+confirma** (nada aplica antes do "sim") e a criação nasce **pausada** + 2ª aprovação de
> ativação. **Invariante:** toda estrutura é RECOMENDAÇÃO — a palavra final é do dono.

---

## 0. Pré-requisitos

1. Conta Meta conectada e **ativa**, com um agente ativo, e `TRAFEGO_CHAT_ADS_WRITES` = ON (default).
2. Contato verificado (DM) OU grupo configurado; o binding de criação ligado (default).
3. Ter na conta: pelo menos **1 criativo veiculando** (ou biblioteca) para o teste usar; idealmente
   **2 criativos distintos** para validar o criativo por-conjunto no site.
4. Um objetivo que **não exige pixel** (ex.: "conversas no WhatsApp") evita o gate de pixel — use-o
   para os cenários abaixo, salvo quando o passo pedir o contrário.

---

## Bloco A — Chat: CRIAR o teste de público (P1)

### A1. Teste com públicos nomeados
- **Ação:** no WhatsApp, "testa interesse em corrida, ciclismo e natação".
- **Esperado:** o Roy monta **3 conjuntos** (1 por segmento, **mesmo criativo em todos**). O eco lista
  os 3 conjuntos (nome + público resumido) e diz **"orçamento único na campanha"** (linguagem de
  negócio — **NUNCA** "CBO"/"ABO" cru). Nasce **pausado**; pede confirmação.

### A2. Público ambíguo → pergunta (nunca chuta)
- **Ação:** "testa interesse em futebol e em vôlei" (termo amplo/ambíguo).
- **Esperado:** no conjunto do termo ambíguo, o Roy **pergunta** qual interesse (lista as opções da
  Meta), em vez de escolher sozinho. Responder "1"/nome resolve determinístico (D1) e segue.

### A3. Base compartilhada (geo/idade) + override de estrutura
- **Ação:** "testa público A e B, todos em Belo Horizonte, 25 a 45 anos, orçamento por conjunto".
- **Esperado:** geo/idade entram como base comum a todos os conjuntos; o dono pediu **orçamento por
  conjunto** → o eco diz **"orçamento por conjunto"** (ABO — override do dono vence o default CBO do
  teste). Cada conjunto pode levar seu diário.

### A4. Piso da Meta escala com N (P6)
- **Ação:** "testa 4 públicos com R$ 4 por dia no total" (verba baixa para 4 conjuntos em CBO).
- **Esperado:** o Roy **recomenda** subir a verba (a mensagem de piso considera **piso × Nº de
  conjuntos**, não 1× fixo) — mas **não trava**: aplica se o dono insistir (INVARIANTE). Confira que a
  recomendação de piso aparece só quando a verba está mesmo abaixo de ~piso×N.

### A5. 1 público só → NÃO é teste (retrocompat)
- **Ação:** "cria uma campanha de conversas mirando interesse em estética".
- **Esperado:** rascunho de **1 conjunto** normal (sem seção de conjuntos, sem "teste de público").

---

## Bloco B — Chat: EDITAR o teste já proposto (P2)

> Pré: tenha um rascunho **multi-conjunto** aberto (do Bloco A).

### B1. Adicionar conjunto a um teste existente
- **Ação:** "adiciona um conjunto de corredores".
- **Esperado:** novo conjunto aparece no eco; a lista cresce; mesmo criativo; segue pausado sob
  confirmação.

### B2. Remover conjunto por número
- **Ação:** "tira o conjunto 2" (índice começa em 0 no schema, mas o dono fala em linguagem natural;
  confirme que remove o conjunto certo pelo eco).
- **Esperado:** o conjunto some do eco. Se **sobrar 1**, o Roy avisa que **voltou para 1 conjunto só**
  (deixa de ser teste).

### B3. Converter 1 conjunto → teste (single→multi)
- **Ação:** num rascunho de **1 conjunto** (Bloco A5), "adiciona um conjunto de ciclistas".
- **Esperado:** vira um **teste**: o público atual vira o **conjunto 1** e o novo entra como conjunto 2.
  O Roy avisa **"virei um teste de público: mesmo criativo em todos, orçamento único na campanha"** e
  que **criativo diferente por conjunto é no site**. Confirme que o eco diz orçamento **único na
  campanha** (forçou CBO — evita gastar N× a verba).

### B4. GUARD diz×faz — editar público de UM conjunto pelo chat (P2, o fix-chave)
- **Ação:** num teste multi-conjunto, "muda o interesse pra corrida" (sem dizer QUAL conjunto).
- **Esperado:** o Roy **BLOQUEIA honesto**: *"pra mexer no público de um conjunto específico do teste,
  edite cada um no site — por aqui eu adiciono ou removo conjuntos inteiros"*. **NÃO** aplica uma
  edição que sumiria na entrega (o multi entrega por `adsets`, não pelo público único) — sem no-op
  silencioso.

### B5. Remover todos os conjuntos → bloqueia
- **Ação:** "tira o conjunto 1 e o conjunto 2" (num teste de 2).
- **Esperado:** o Roy barra ("toda campanha precisa de pelo menos um público" / "não tem conjunto pra
  remover" conforme o caso), sem deixar o rascunho sem público.

### B6. Escala (duplicate) não edita conjunto
- **Ação:** num rascunho de **escala** (duplicar vencedor), "adiciona um conjunto".
- **Esperado:** o Roy responde honesto que numa escala o público é **herdado** (só orçamento/ativação
  editáveis) — não converte em teste.

---

## Bloco C — Aplicar na Meta + entrega (P3 saga)

> Pré: aprove um rascunho multi-conjunto (Bloco A) e faça a 2ª aprovação de ativação.

### C1. Estrutura criada corretamente (criativo compartilhado)
- **Ação:** aprovar o teste de N conjuntos + aprovar a ativação.
- **Esperado na Meta:** **1 campanha**, **N conjuntos** (cada um com seu público), e **o MESMO
  criativo** referenciado nos anúncios de **todos** os conjuntos — o criativo é criado **UMA vez**
  (não N×M criativos). **CBO** → verba na campanha (conjuntos sem orçamento próprio); **ABO** → cada
  conjunto com seu orçamento.

### C2. Ativação cobre a árvore inteira
- **Ação:** conferir status pós-ativação.
- **Esperado:** **todos** os N conjuntos + N×M anúncios saem de pausado (a Meta não cascateia — a
  árvore inteira é ativada). Nenhum nó fica pausado em silêncio.

### C3. Retomada sem duplicar gasto
- **Ação:** simular falha transiente no meio da criação (ex.: erro de rede após criar a campanha + 1º
  conjunto) e deixar o retry rodar.
- **Esperado:** o retry **pula** o que já existe (campanha/conjunto/criativo/anúncio já criados) e
  cria só o que falta — **sem** criar campanha/criativo duplicado.

### C4. Aviso de mudança real
- **Ação:** após a ativação real.
- **Esperado:** chega um **resumo breve no WhatsApp** da criação/ativação aplicada. Dry-run/falha/no-op
  **não** disparam aviso.

---

## Bloco D — Site: painel edita N conjuntos (P4)

> Pré: um rascunho multi-conjunto **pendente**.

### D1. Card em `/approvals`
- **Ação:** abrir a lista de aprovações.
- **Esperado:** o card mostra o **rótulo de negócio** do orçamento (nunca a sigla), a lista dos **N
  conjuntos** (nome + público resumido + orçamento quando ABO, "mesmo criativo"), e — quando
  `advantageCreative` ON — o **aviso** honesto de que a Meta pode ajustar imagem/texto.

### D2. Painel de edição — por conjunto
- **Ação:** abrir "Editar rascunho".
- **Esperado:** a seção **Conjuntos** aparece (e o público único fica escondido). Cada conjunto tem:
  **nome** + **`GeoAudienceEditor`** (público) + **orçamento** (só em ABO) + **`creative-picker`**
  (criativo próprio, mesma copy) + botões **adicionar/remover conjunto** (mín. **2**, teto **8** —
  botão "adicionar" desabilita no teto).

### D3. Editar público/orçamento de um conjunto e salvar
- **Ação:** mudar o público (ou orçamento em ABO) do conjunto 1 e Salvar.
- **Esperado:** toast de sucesso; reabrir mostra a mudança persistida; os demais conjuntos intactos.

### D4. Criativo próprio por conjunto
- **Ação:** no conjunto 2, "Trocar criativo deste conjunto" → escolher um criativo distinto → Salvar
  → aprovar → ativar.
- **Esperado na Meta:** o conjunto 2 recebe um criativo **exclusivo**; os demais seguem com o
  compartilhado. A **copy** é a mesma (só o criativo muda).

### D5. Design system + build
- **Ação:** rodar `pnpm --filter web tokens:check` e `pnpm --filter web build`.
- **Esperado:** ambos **verdes** (sem cor hardcoded; template Angular compila — regressão do `as`
  reservado coberta).

---

## Bloco E — Round-trip do criativo por-conjunto + no-clobber (P6, o BLOQUEIA corrigido)

> Este bloco valida o fix mais importante da sessão: o criativo próprio de um conjunto **não pode se
> perder** quando o rascunho é salvo de novo.

### E1. Criativo por-conjunto sobrevive a um novo save
- **Ação:** (1) no painel, ponha um **criativo próprio no conjunto 2** e Salve. (2) Reabra o painel.
  (3) Mude **só o orçamento do conjunto 1** e Salve de novo.
- **Esperado:** o criativo próprio do **conjunto 2 CONTINUA** (não volta pro compartilhado). O painel
  reenvia `keepCreativeIndex` pros conjuntos que já tinham criativo e não foram trocados.

### E2. Save sem tocar conjuntos NÃO reescreve a lista
- **Ação:** com um teste multi-conjunto, mude **só o nome da campanha** (ou só a ativação) e Salve —
  sem tocar em nenhum conjunto.
- **Esperado:** os conjuntos ficam **exatamente** como estavam (públicos, orçamentos e criativos
  próprios preservados). O painel só manda `adsets` quando **algum conjunto foi mexido**
  (`conjuntosDirty`) — evita no-op e evita **clobbar** uma edição concorrente do chat aos conjuntos.

### E3. Remover conjunto preserva os criativos dos que ficam
- **Ação:** com criativos próprios em 2+ conjuntos, **remova** um conjunto do meio e Salve → aprove →
  ative.
- **Esperado na Meta:** os conjuntos restantes mantêm **seus** criativos próprios (o `keepCreativeIndex`
  usa o índice de ORIGEM, robusto à remoção — não embaralha criativos).

### E4. Picker fecha ao remover conjunto
- **Ação:** abra o "Trocar criativo" de um conjunto e, sem escolher, **remova** um conjunto anterior.
- **Esperado:** o picker aberto **fecha** (não fica anexado a um índice deslocado/errado).

---

## Bloco F — Colapso e defesa de dados (P6 backend)

### F1. Colapso para 1 conjunto pelo site (defensivo)
- **Ação:** se possível forçar (ou via API direta) um `updateDraft` com `adsets` de **1** conjunto.
- **Esperado:** o backend **espelha o colapso do chat** — volta a **single-conjunto** levando o
  público/nome do único restante (`edit.adsets=[]` + `targeting`/nome). **NÃO** persiste um
  `adsets:[1]` que o apply ignoraria (o que derrubaria o público em silêncio). *(Na UI o mínimo é 2,
  então isto é a rede defensiva do contrato.)*

### F2. Contrato regenerado
- **Ação:** `pnpm api:generate` limpo + `pnpm typecheck`.
- **Esperado:** o tipo gerado `UpdateDraftInput` inclui `keepCreativeIndex`; sem drift entre zod →
  OpenAPI → kubb.

---

## Bloco G — Invariantes a confirmar em TODOS os cenários

- [ ] Toda estrutura/Advantage/próximo passo é **RECOMENDAÇÃO** — o dono sobrepõe; a palavra final é dele.
- [ ] **Eco+confirma** antes de QUALQUER escrita; nada aplica sem "sim". Criação nasce **pausada** + 2ª
      aprovação de ativação.
- [ ] **NUNCA** a sigla técnica **CBO/ABO** no que vai pro dono (chat E site) — só linguagem de negócio.
- [ ] **Mesmo criativo** em todos os conjuntos por padrão (isola a variável público); criativo diferente
      por conjunto = **site**.
- [ ] **Diz×faz:** nada de no-op silencioso — o chat bloqueia honesto quando não dá pra fazer o que o
      dono pediu (público de um conjunto pelo chat), sempre com o próximo passo.
- [ ] Ambiguidade → **pergunta**, nunca chuta (público, criativo).
- [ ] Sem cara de IA: sem travessão dramático como conector nas mensagens.

---

## Suítes automatizadas (referência)

- `pnpm --filter @trafego/core test` — 899 verdes (inclui `removeAdsetsAt`, `seedAdsetFromSingle`,
  `budgetMode` no `applyDraftEdit`).
- `pnpm --filter @trafego/worker test` — 806 verdes (guard multi-conjunto, `patchTouchesSinglePublico`,
  `describeConjuntosBlock`, eco multi no `buildRefineEcho`).
- `pnpm --filter @trafego/api test` — 185 verdes.
- `pnpm --filter web build` + `tokens:check` — verdes.

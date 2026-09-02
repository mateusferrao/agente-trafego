# Validação manual — edição de rascunho + reversão + picker + fonte do criativo (Fatia 7 adendo, Slices 6–12)

Roteiro **passo a passo, exaustivo e crítico** do adendo da Fatia 7. Cobre todo caminho feliz e triste,
com foco em **qualidade, usabilidade e experiência do usuário**, e critérios explícitos de qualidade
para os pontos **determinísticos** E **não-determinísticos (LLM)**. Inclui as correções pós-revisão
(orçamento obsoleto, corrida pausar→arquivar, TOCTOU da troca no chat, erro granular no picker, aviso
claro de criativo no chat, reverter arquivando no chat).

**Ambiente:** `docker/docker-compose.yml` (postgres :5432 / redis :6379) + `pnpm dev` (api :3333, web
:4200, worker), `.env` local. **Conta de teste real = BM autômato:** `ad_account 1423420276172802`
(business `1095947159238590`, org "Org de Teste 366", token **válido**). Owner: `mateusferraocosta2004@gmail.com`.
WhatsApp (Evolution) conectado para os caminhos de chat/grupo.

**Legenda:** 🟢 feliz · 🔴 triste (estresse) · 🤖 ponto não-determinístico (LLM) · 🔎 conferência
(DB/redis/log/HTTP) · ✅ critério de aprovação.

**Como conferir o DB:** `docker exec docker-postgres-1 psql -U postgres -d trafego -c "<SQL>"`.
**Mensagens do agente:** tabela `messages` (`direction='outbound'`). **Oferta de criativo (redis):**
key `creative-offer:<conversationId>`. **Log estruturado (pino):** stdout do worker; grep `conversation:turn falhou`.

> **Setup de dados:** tenha (a) um rascunho `from_scratch` **proposed** e (b) um `duplicate` **proposed**
> na conta autômato (peça "me recomenda uma campanha" / "escala o vencedor" no chat, ou dispare o proativo).
> Para reversão, **aprove** uma criação (nasce **pausada**) → gera um `agent_tool_call`
> `create_campaign`/`duplicate_scale` reversível dentro de `REVERT_TTL_DAYS` (=7 dias).

---

## Slice 6 — camada de refino única + zod do spec

### 6.1 zod do `CampaignDraftSpec` (shape-validation nas bordas)
- 🟢 Rascunho **pré-adendo** (spec sem `campaignName`/`adsetName`/`adName`) é lido e aplicado sem erro
  (refine leniente por `kind` — `campaign-draft.test.ts`). ✅ deploy não rejeita rascunho em voo.
- 🔴 PATCH com `campaignName` **vazio** (`.min(1)`) → **400** (zod). `campaignName` > **400 chars**
  (`ENTITY_NAME_MAX`) → 400. `budgetReais ≤ 0` (`.positive()`) → 400. `objective` fora de
  `CONVERSION_GOALS` → 400. `copyEdits[].index < 0` → 400. `primaryText`/`headline` > **3000 chars**
  (`COPY_TEXT_MAX`) → 400. ✅ nenhum 500; erro tratado.

### 6.2 núcleo puro `applyDraftEdit` (guards de negócio, 422)
- 🟢 Editar nome + ativação de `from_scratch` mantém o resto do spec (criativo, copies).
- 🔴 **Objetivo que exige pixel** (venda/lead/registration/checkout/… — `REQUIRES_PIXEL`) em conta **sem
  pixel** → **422** `"Esse objetivo precisa do rastreamento de conversões (pixel) configurado na Meta, e
  esta conta ainda não tem. Configure no Gerenciador de Eventos da Meta, ou escolha um objetivo que não
  precise disso (como mensagens ou engajamento)."` ✅ traduz "pixel" + aponta objetivos viáveis (§13 próximo passo).
- 🔴 Remover a **última** variação → **422** `"Toda campanha precisa de pelo menos um anúncio. Edite este
  em vez de remover."` (no painel o botão "Remover" já fica **disabled** com 1 anúncio).
- 🔴 Em `duplicate`, tentar editar objetivo/nome/criativo/copy/público → **422** `"Numa escala eu mantenho
  o que já converte (público, criativo e copy do vencedor). Pra mexer nisso, o caminho é criar uma
  campanha nova."`
- 🔎 Pixel é re-resolvido **DA CONTA** (`inferCreationDefaults(ref).pixelId`), nunca de `spec.pixelId` →
  o guard não é burlável pelo spec.

### 6.3 orçamento obsoleto (correção do reviewer)
- 🟢 Conta com teto de gasto novo (ex.: R$100): peça um rascunho pedindo R$150 → clampa; o card mostra
  `"(você pediu R$ 150,00 — cortei pro seu teto)"`. **Edite** o budget pra R$50 (abaixo do teto). ✅ o
  card **deixa de mostrar** "reduzido de".
- 🔎 `select spec->>'requestedDailyBudgetMinor' from campaign_drafts where id='<draft>'` → **null** após a
  edição sem clamp.

### 6.4 convergência + `persistDraftSpec` guardado (TOCTOU)
- 🟢 Editar o mesmo rascunho pelo **site** (PATCH) e pelo **chat** (adjust_draft) tem o mesmo efeito.
- 🔴 **Corrida com o apply:** aprove o rascunho (`proposed→creating`) e edite no mesmo instante →
  **422** `"esse rascunho não está mais aberto pra ajuste."` (UPDATE guardado `WHERE status='proposed'
  RETURNING` → 0 linhas). Não sobrescreve o spec que o apply congelou.

---

## Slice 7 — edição no site (painel "Editar rascunho")

### Abrir e o card só-leitura
- 🟢 `/approvals` → seção **"Rascunhos de campanha"** agrupada por conta. Card = resumo só-leitura
  (eyebrow "Criar campanha"/"Escalar vencedor"/"Pronta pra ativar" + deadline; título; `<dl>` com
  Gasto/Status/Página/Rastreamento/Objetivo/Origem; miniatura + rótulo "vídeo · reusado de um anúncio da
  conta"). Botões: **Editar**, **Trocar criativo** (só `from_scratch`), **Recusar/Deixar pausada**,
  **Aprovar/Ativar**. Atalhos de um toque: **Público** (2 toggles) e o picker.
- ✅ Nenhum id cru nem jargão no card (conversionLabel/sourceName/creativeLabel); status = tom+texto.

### Painel — modo criação (`from_scratch`)
- 🟢 Título "Editar rascunho". Campos: **Nome da campanha** (placeholder derivado, ex.: "CaquiAI — Venda"
  **traduzido**), **Nome do conjunto** ("… — conjunto"), **Objetivo** (select estilizado, 1ª opção
  "Selecione o objetivo" **disabled**, **sem** "Conversão personalizada"), **Gasto por dia (BRL)**,
  **Ao aprovar** ("Deixar pausada" / "Ativar em seguida"), **Anúncios** (por anúncio:
  nome/título/texto/descrição + **Remover**). Salvar → PATCH **só dos campos alterados** → toast
  `"Rascunho atualizado."` + card recarrega.
- 🔴 Remover anúncio → toast `"Anúncio removido."` — **fecha o painel** (o pai recarrega). *(Gap de UX
  conhecido: reabrir pra continuar; registrado como follow.)*
- 🔴 Editar só espaço em branco → **no-op** (não vira patch; correção do reviewer).
- 🔴 Salvar sem nenhuma mudança → fecha em silêncio (patch vazio, sem chamada à API).
- 🔴 Objetivo venda/lead sem pixel → **422 traduzido** no toast (fallback `"Não consegui salvar essa
  edição. Tente de novo."` se o servidor não mandar mensagem).
- ✅ Estilo: **select** e **textarea** têm o visual do design system (correção bloqueante do reviewer).

### Painel — modo escala (`duplicate`)
- 🟢 **Cabeçalho** exato: `"Você está escalando um vencedor. O agente reaproveita o público, o criativo e
  a copy que já estão funcionando — aqui você ajusta só o nome, o orçamento e quando ativar."` Campos:
  **Rótulo do nome** (placeholder "escala"; preview `"<vencedor> — <rótulo>"`), Gasto, Ativação. Sem
  objetivo/copy/criativo.
- 🔴 Forçar (curl) PATCH de escala com `campaignName`/`objective`/`copyEdits` → **422** com a mensagem de
  `field_not_editable`.
- 🔎 `pnpm api:generate` (contrato) + `pnpm --filter web build` (AOT) verdes.

---

## Slice 8 — edição no WhatsApp (chat LEVE + aviso claro)

### Ajustes de intenção única (adjust_draft — proposeOnly → eco+confirma)
Campos aceitos: **budgetReais**, **activation**, **variantsCount**, **audience** (`reuse`/`broad`),
**campaignName**. (`campaignName`/`audience` só têm efeito em `from_scratch`.)
- 🟢 "aumenta pra 80" → eco `"Rascunho de campanha atualizado: gasto novo R$ 80,00/dia · …"` → "sim"
  aplica (audit `actorLabel(ref)`). 🤖 o LLM (`CONVERSATION_MODEL`) mapeia fala→campo.
  ✅ número certo; NUNCA duplica ("aumenta 20%" ≠ duplicar).
- 🟢 "muda o público pra amplo" → `audience:'broad'`; eco `"Público: a Meta escolhe (mais amplo)."`
- 🟢 "renomeia a campanha pra Promo Julho" → `campaignName`.
- 🟢 "regenera a copy" → `regenerate_copy` (gera variações novas por IA — ver 🤖 qualidade §Qualidade LLM).
- 🔴 **Ambiguidade** ("aumenta o orçamento" sem qual/quanto) → o agente **PERGUNTA** ("de qual campanha?
  e pra quanto — valor/dia ou %?"), **nunca aplica no escuro**. ✅ nunca "já ajustei" sem tool.

### Edições PESADAS → aviso claro pro site (chat leve)
- 🔴 "**troca o criativo**" / "usa outro anúncio" → o agente avisa **claramente** que trocar criativo é no
  painel do site + oferece o link. *(correção #3 — antes o chat não sabia redirecionar isso.)*
- 🔴 "muda a **copy toda**" / "reescreve o texto do anúncio 2" → redireciona pro painel do site (chat só
  **regenera** por IA, não edita o texto). *(decisão: chat leve.)*
- 🔴 "muda o **objetivo**" / "renomeia o **conjunto**" / "adiciona um anúncio" → redireciona pro site.
- 🔎 `describe_capabilities`: declara honestamente o chat leve × site, incl. `"Pra TROCAR o criativo ou
  editar o TEXTO da copy, é no painel Editar do rascunho no site (te passo o link)."`

### Trocar criativo via UPLOAD no chat (oferta — segue funcionando)
- 🟢 Com rascunho `from_scratch` pendente, **mande uma imagem** → "quer usar no rascunho?" → responda
  **"sim"** (afirmação simples) → `"Troquei o criativo do rascunho pra esse que você mandou…"`.
  🔎 redis `creative-offer:<conv>` setado (TTL 30 min) e limpo após sucesso.
- 🔴 **"sim, mas muda o budget"** (afirmação **composta**) → NÃO resolve no automático; cai no turno
  normal; a oferta segue no TTL.
- 🔴 Responda "sim" no instante em que aprova o rascunho (vira `creating`) → `"esse rascunho não está
  mais aberto pra troca — mas guardei o criativo na sua biblioteca."` *(correção do reviewer: passa pelo
  `persistDraftSpec` guardado, sem sobrescrever o apply.)*
- 🔴 Sem rascunho pendente → mande imagem → "quer criar uma campanha com ela?" → "sim" → propõe campanha
  semeada com o criativo.
- 🔴 Mande um **vídeo** → tratado à parte (oferta de vídeo tem seu fluxo); confira que não quebra.

---

## Slice 9 — aplicar nomes/objetivo/sufixo editados (apply)

- 🟢 Edite os nomes de um `from_scratch` (campanha/conjunto/cada anúncio) → aprove → **confira na Meta**
  que os nomes reais batem com o editado (não o derivado `CaquiAI — <objetivo>`).
- 🟢 Edite o **rótulo do sufixo** de um `duplicate` → aprove → o nome na Meta vira `"<vencedor> —
  <rótulo>"` (o `/copies` anexa; um passo, sem rename pós-cópia).
- 🔎 `args.target` gravado: `select args->'target' from agent_tool_calls where tool_key in
  ('create_campaign','duplicate_scale') order by created_at desc limit 1` → `{level,id,name}` populado
  (base do item reversível).
- 🔎 **P0.1:** criação nasce **PAUSADA**; se pediu "ativar", cria uma approval de **ATIVAÇÃO** à parte
  (2º OK). `select approval_kind from …` / `list_pending` mostra a activation.

---

## Slice 10 — fonte do criativo (config por-agente) + qualidade da escolha

Em **Agente → Opções avançadas → "De onde o Roy tira o criativo?"** (site, sem jargão):
- 🟢 **Reaproveitar o que já está funcionando** (recomendado, default `serving.best_performing`):
  **determinístico, sem LLM** — reusa o melhor veiculando; sem veiculando, cai na biblioteca por contexto.
- 🟢 🤖 **Deixar o Roy escolher** (`both`): pool veiculando + biblioteca **descrito por visão + desempenho**;
  o LLM escolhe por **encaixe**. ✅ "desempenho é sinal forte, não veto"; empate → prefere o provado
  (recência determinística); nunca escolhe algo claramente pior/irrelevante.
- 🟢 🤖 **Usar só a minha biblioteca** (`library`): o LLM escolhe na biblioteca por contexto
  (`pickLibraryCreativeByContext`, temp 0.2).
- 🔴 Config malformado/legado → `resolveCreativeSourceStrategy` cai no default (nunca quebra).
- 🔴 Conta sem biblioteca → cai no serving; sem nada → `blocked` honesto (não cria vazio).
- 🔎 **Cache de visão idêntico run↔picker:** `servingVisionKey(creativeId, videoId, copy)` usada verbatim
  pelos dois; a descrição vem do **cache dos runs** numa **única query** (sem N+1 — correção do reviewer).
- 🔎 Leaf-merge: `mergeAdvancedConfig` troca `creativeSource` como **unidade**;
  `select model_config->'creativeSource' from agents where id='<agent>'` reflete a escolha.
- 🔎 **Eco honesto da fonte:** `serving` → "reusando o criativo que melhor performa na sua conta";
  `library` → "reusando um criativo da sua biblioteca (você não tem anúncio ativo pra eu comparar
  desempenho)". ✅ o eco casa com a fonte REAL escolhida.

---

## Slice 11 — reverter criação/escala (site + chat)

Pré: criação aprovada (nasce pausada) com tool_call `create_campaign`/`duplicate_scale` dentro de
`REVERT_TTL_DAYS` (=7 dias). Superfície: seção **"Reversíveis"** de `/approvals` (`GET /approvals/revertible`).

### Site — pausar (padrão)
- 🟢 **"Pausar a campanha criada"** (sem diálogo, ação direta) → a **árvore inteira** fica PAUSED (pausar
  a raiz basta — `effective_status` = AND). Success `"Pausando a campanha criada"`. `campaign_drafts.status
  → reverted`; item **some** da lista. Linha de consequência: `"Pausar mantém a campanha na conta (não
  gasta, dá pra reativar). Arquivar tira da lista ativa (recuperável)."`
- 🔴 **Idempotência:** clicar "Pausar" 2× (aba stale) → 2ª vez é no-op honesto (`"essa campanha já estava
  pausada"`), sem duplicar efeito (`${id}:undo` + `computeChange` alreadyThere).
- 🔴 **Fora da janela** (`> REVERT_TTL_DAYS`) → **400** `"O prazo para reverter esta ação expirou."`
- 🔴 **Falha parcial na Meta** (token expira no meio) → `"não consegui pausar a campanha na Meta"`; o
  undoKey **não** é gravado → retry seguro.

### Site — arquivar
- 🟢 **"Arquivar"** (secundário) → **confirmDialog** (tone warning): title `"Arquivar a campanha criada?"`,
  description `"Arquivar tira a campanha da sua lista ativa na Meta. Ela não é apagada e dá pra recuperar,
  mas some da visão do dia a dia."`, confirmLabel `"Arquivar"` → `set_status=ARCHIVED` (mesmo seam).
- 🟢 **Arquivar após gasto** (a campanha já rodou) → a Meta aceita ARCHIVED.
- 🔴 **Corrida pausar→arquivar (correção do reviewer):** aba stale — "Pausar" e depois "Arquivar" → o 2º
  **escala de verdade** pra ARCHIVED (não devolve sucesso vazio). Já-arquivado + "pausar" → no-op honesto
  (`"essa campanha já estava arquivada"`), sem desarquivar.
- 🔎 `select args->>'mode' from agent_tool_calls where tool_key='undo_action' order by created_at desc`
  reflete o estado final (escalação **atualiza** o registro existente, não duplica).

### Chat — reverter com paridade (correção #5)
- 🟢 "reverte/pausa a campanha X" (por id de `find_recent_actions`) → eco `"Vou pausar a campanha criada
  *X*. Pausar mantém a campanha na conta (não gasta, dá pra reativar). Confirma?"` → "sim" → `"✅ Desfeito."`
- 🟢 "**arquiva** a campanha X" → `mode:archive` → eco `"Vou arquivar a campanha criada *X*. Arquivar tira
  da lista ativa na Meta (não apaga, dá pra recuperar). Confirma?"` → "sim" → `"✅ Arquivada."`
  🤖 o LLM só passa `mode:archive` se o usuário **pedir explicitamente** arquivar.
- 🔴 Ação **normal** (pausar/budget/status) revertida pelo chat → mantém o comportamento antigo
  ("desfazer a pausa de *X*"), `mode` ignorado. ✅ eco+confirma antes de qualquer escrita; ambiguidade →
  pergunta.
- 🔎 Cross-tenant: `toolCallId` de outra org → `"ação não encontrada"` (loaders `coalesce(agentId,
  run.agentId)` org-bound; worker re-escopa por `orgId` antes de mutar).

---

## Slice 12 — picker: imagem veiculando + ordenação + truncamento + erro granular

- 🟢 "Trocar criativo" → seção **"Anúncios da conta"** mostra **imagens** (preview via thumb) **e** vídeos
  (selo), **ordenados por data** (recentes primeiro), **truncados** em 12 + **"Ver mais (N)"**, com
  **busca** (aparece com >12; filtra título/copy client-side; reseta o truncamento). Seção **"Sua
  biblioteca"** (imagens com preview, vídeos com selo "vídeo").
- 🟢 Escolher **imagem veiculando** → resolve `image_hash` **ao vivo** (`getCreatives([adId])`); o apply
  usa `link_data.image_hash`. Confira o anúncio criado na Meta.
- 🔴 **Erro granular (correção #2):** escolher um criativo que não resolve → **422** com a mensagem
  granular (`"não consegui usar esse criativo — tente outro."`) exibida no toast — **não** mais um 404
  cego. Rascunho não-aberto → 422 `"esse rascunho não está mais aberto pra ajuste."`
- 🔴 Conta com **90+ criativos** → só a 1ª página; "Ver mais" pagina (cap `SERVING_PICKER_CAP=200`).
- 🔴 Busca sem resultado → `"Nenhum anúncio bate com "<termo>"."`
- 🔴 Ambas as fontes vazias (conta nova) → empty-state guiado: `"Ainda não tenho criativos pra oferecer
  nesta conta. Rode uma análise … ou me mande um criativo no WhatsApp / suba na aba Criativos."`
- 🔴 Só o serving falha (biblioteca ok) → degrada por fonte (mostra a biblioteca). *(Gap: não avisa que
  uma fonte caiu — registrado.)* Ambas falham → `"Não consegui carregar os criativos. Feche e tente de novo."`
- 🔎 `select image_hash from ad_creatives where ad_account_id='<acc>' and image_hash is not null limit 1`
  populado (migration **0043**).

---

## Qualidade dos LLMs (não-determinístico) — 🤖 avaliação crítica

Para cada saída de LLM, o testador julga **BOM × RUIM**. Modelos (defaults): `CONVERSATION_MODEL`,
`COPY_MODEL`, `OPENROUTER_VISION_MODEL`. Overrides por-agente em `model_config`.

### A. Descrição/análise de criativo (visão) — `describeVision`
✅ **BOM:** grounded no que vê + texto dado; PT-BR; `proofStrength` coerente (promessa sem prova = weak;
antes-depois/autoridade = medium/strong); **honesto** quando não há mensagem comercial. **NÃO inventa
métricas/performance.**
🔴 **RUIM:** descreve elemento ausente, inventa número, `summary` genérico inútil.
🔎 **Evidência real observada (88 análises):** ex. blefaroplastia — `summary` específico ("público 35+ em
BH", "oferta de parcelamento"), `hook`/`angle` extraídos, `proofStrength` weak/medium sensato; criativo de
marca ("caqui cartoon fundo preto") → `hook:"Nenhum, é puramente visual"`, `angle:"Nenhum, não há mensagem
comercial"`. ✅ qualidade alta, sem alucinação.

### B. Geração de copy — `generateCopy` (temp 0.7)
✅ **BOM:** exatamente `variantsCount` variações **distintas** (variam o ÂNGULO, não a oferta); grounded em
`winnerCopy`/`businessContext`/`guidance`; PT-BR sóbrio B2B (sem clickbait/emoji em excesso/promessa
exagerada); `cta` ∈ `CTA_TYPES`; **não inventa preço/desconto/garantia** ausente do contexto.
🔴 **RUIM / sinal de FALLBACK (LLM falhou):** headline `"Conheça nossa oferta"` / primaryText `"Descubra o
que preparamos para você."`, ou variação duplicada com "(2)".
🔎 **Evidência real:** copies de IA/desperdício ("Identifique e elimine desperdícios com IA", "Evite gastos
desnecessários com IA") — coerentes, ancoradas no nicho, objetivo `lead`. ✅ sem alucinação.

### C. Escolha do criativo por contexto — `chooseCreative` / `pickLibraryCreativeByContext`
✅ **BOM:** no modo default (`best_performing`) o melhor veiculando SEMPRE vence (determinístico). Nos modos
LLM, escolhe o que **CASA** com objetivo/negócio (pode preterir o de melhor performance se o encaixe for
melhor), mas nunca algo claramente pior/irrelevante; empate → recência (determinística, não aleatória);
degrada pro 1º candidato em erro/índice inválido; nunca quebra a criação.
🔴 **RUIM:** ignora o contexto e sempre pega o índice 0; escolhe algo fora de tema; varia entre execuções
no empate.

### D. Interpretação da intenção no chat — `CONVERSATION_MODEL` (temp 0.3)
✅ **BOM:** mapeia fala→tool certa ("sobe pra R$150"→adjust_budget/adjust_draft nº certo; "escala o
vencedor"→scale_winner; "aumenta 20%"→adjust_budget, NUNCA duplica); **ambiguidade → PERGUNTA CONCRETA**,
nunca aplica no escuro; **honesto** (nunca "ajustei/ativei" sem chamar a tool); **NUNCA cita número que não
veio de tool**; perguntas sobre o rascunho → `get_pending_draft` (não re-roda criação nem fresh fetch);
edição pesada → oferece o link do site.
🔴 **RUIM:** chamar tool no escuro; "já fiz" sem tool; inventar métrica; re-rodar criação pra responder.
🔎 **Evidência real (mensagens):** "não achei um vencedor claro na última análise — roda a análise
primeiro" (honesto, próximo passo); eco de criação lista criativo por **nome real** + budget + público
"amplo — a Meta escolhe" (sem "Advantage+") + copies. ✅ amigável, sem jargão, sem alucinação.

---

## Gaps de UX (achados na revisão frontend — validar/registrar)

1. **`/approvals` e o picker sem indicador de loading** — tela/caixa em branco até `loaded()`. 🔴 validar
   que numa rede lenta o usuário não interpreta como "vazio". *(Sugerir skeleton/spinner — follow.)*
2. **Erro de carregamento das listas de aprovações é silencioso** — se `listPending`/`revertible`/`drafts`
   falha, a seção some e parece "Nada aguardando". 🔴 validar com o backend derrubado; distinguir de vazio.
3. **Ações mutantes (approve/reject/revert) sem toast de erro no componente** — dependem do interceptor
   global. 🔴 validar que o usuário VÊ o toast num 4xx/5xx.
4. **Degradação parcial do picker não sinalizada** — se só o serving cai, o usuário não sabe que "anúncios
   ao vivo" sumiram por erro (vs. não existirem). 🔴 validar; considerar aviso.

*(Os toasts de sucesso e os empty-states guiados estão bem; a maioria dos textos evita jargão e dá próximo
passo — confirmado na revisão.)*

---

## Divergências / notas (estado REAL do código — evita testar caminho inexistente)

- **NÃO existe** trocar criativo por `adjust_draft` no chat, nem tool `set_creative_source`, nem editar
  **texto** de copy por índice no chat → o chat **avisa** e manda pro site (correção #3/#4).
- **Trocar criativo pelo chat** = só via **upload no WhatsApp + "sim"** (oferta), não por comando.
- **Reverter pelo chat** agora aceita `mode` pause|archive (paridade — correção #5); antes só pausava.
- **Janela de revert = `REVERT_TTL_DAYS` (7 dias)**, compartilhada por criação/escala E ações normais
  (decisão: manter).
- **POST `/creative` e `/targeting`** agora devolvem **422 com mensagem granular** (antes: 404 cego —
  correção #2).

---

## Deck de copy (mensagem + próximo passo por estado novo)

| Estado | Mensagem esperada |
|---|---|
| Bloqueio de pixel | "Esse objetivo precisa do rastreamento de conversões (pixel)… escolha um objetivo que não precise disso (como mensagens ou engajamento)." |
| Escala — campo herdado | "Numa escala eu mantenho o que já converte… o caminho é criar uma campanha nova." |
| Último anúncio | "Toda campanha precisa de pelo menos um anúncio. Edite este em vez de remover." (botão disabled) |
| Editar pesada no chat | oferece o link do painel "Editar" do site |
| Consequência de pausar | "Pausar mantém a campanha na conta (não gasta, dá pra reativar)." |
| Consequência de arquivar | "Arquivar tira da lista ativa na Meta (não apaga, dá pra recuperar)." |
| Fora da janela de revert | "O prazo para reverter esta ação expirou." |
| Picker vazio | "Ainda não tenho criativos pra oferecer nesta conta. Rode uma análise… ou me mande um criativo…" |
| Rascunho não aberto | "esse rascunho não está mais aberto pra ajuste." / "…pra troca — mas guardei o criativo na sua biblioteca." |
| Já revertido | "essa campanha já estava pausada / arquivada." |
| Criativo inválido no picker | "não consegui usar esse criativo — tente outro." (422, não 404 cego) |

---

## E2E ao vivo em docker — conta BM autômato (criar → editar → reverter, com cleanup)

> **Escrita real na Meta autorizada** pelo usuário (conta autômato). Toda criação nasce **PAUSADA** (não
> gasta). **Reverter/arquivar ao final** é o cleanup — nenhuma campanha ativa fica pra trás.

1. `docker compose -f docker/docker-compose.yml up -d` (postgres+redis já de pé). `pnpm db:migrate`
   (garante a **0043** `image_hash`). `pnpm dev` (api :3333, web :4200, worker) com `.env` real.
2. **Login** como owner de "Org de Teste 366" (`mateusferraocosta2004@gmail.com`) → foco na conta
   `1423420276172802`.
3. **Criar (chat/on-demand):** peça uma campanha → 🤖 confira a **copy gerada** (§Qualidade B) + a
   **escolha de criativo** (§Qualidade C) + o **eco honesto** da fonte. Aprove → nasce **pausada**.
   🔎 `campaign_drafts` (created) + `agent_tool_calls` (create_campaign, `args.target`) + a campanha
   **PAUSED** no Gerenciador da Meta.
4. **Editar (site):** abra o painel → mude nome/budget/copy → salve → 🔎 os nomes/valores editados na Meta
   (Slice 9). Teste os tristes: objetivo sem pixel (422), remover último anúncio (disabled/422), escala
   com campo herdado (422), edição concorrente (422).
5. **Picker (site):** "Trocar criativo" → imagem + vídeo ordenados por data, busca, ver-mais; troque por
   uma **imagem veiculando** → 🔎 `spec.creative` com `metaImageHash`. Teste criativo inválido → 422 granular.
6. **Reverter (cleanup):** "Pausar a campanha criada" → árvore PAUSED; depois **Arquivar** → ARCHIVED.
   Repita pelo **chat** ("arquiva a campanha X" → "sim" → "✅ Arquivada."). 🔎 `campaign_drafts.status =
   reverted`, `agent_tool_calls` (undo_action, `mode`), campanha **ARCHIVED** na Meta.
7. **Cleanup final:** confirme que **nenhuma** campanha criada no teste está ativa (todas PAUSED/ARCHIVED).

---

## Checklist de invariantes (o reviewer confirmou; reconferir no E2E)

- [ ] Nenhuma escrita na Meta sem **eco + confirma** (chat) ou clique explícito (site); arquivar tem
      confirmação extra.
- [ ] Toda edição de rascunho passa pelo **núcleo único** `applyDraftEdit` + `persistDraftSpec` guardado.
- [ ] Reversão **idempotente** (`${id}:undo`) e **org-scoped**; corrida pausar→arquivar honesta.
- [ ] Toda query nova filtra por `org_id`; `draftId`/`toolCallId` de outra org → 404/422/0-linhas.
- [ ] Erros sempre amigáveis (400/422/toast), **nunca** stack/código cru; picker propaga mensagem granular.
- [ ] Sem jargão ao usuário ("pixel"/"Advantage+"/código de objetivo traduzidos).
- [ ] Chat **leve** com **aviso claro**: trocar criativo/editar texto de copy → site.
- [ ] 🤖 LLMs: copy grounded/sóbria; visão honesta sem inventar métrica; escolha de criativo por encaixe;
      chat nunca finge ação nem cita número sem tool.

# Validação manual — revisão da criação + escala de campanha (Fatia 7, 2026-08-28)

Roteiro completo (caminhos felizes + estresse dos tristes) das mudanças da sessão de revisão. Cada
item aponta o que fazer, o esperado, e como conferir no banco/redis quando útil.

**Ambiente:** `docker/docker-compose.yml` (postgres+redis local) + `pnpm dev` (api+worker+web), `.env`
local. Conta/agente conectados com token Meta válido para os caminhos que tocam a plataforma.

Legenda: 🟢 caminho feliz · 🔴 caminho triste (estresse).

---

## Slice 1 — bugs de base

### 1.1 Ecos picotam em balões
- 🟢 No WhatsApp: "@bot me recomenda uma campanha". **Esperado:** a proposta chega **em vários balões** (intro / gasto+página / confirma), com "digitando…" entre eles — não um bloco único.
- 🟢 "escala o vencedor" (com passo agressivo) → o "ask" (subir × duplicar) chega picotado.
- 🔴 Rascunho curto (1 linha) → 1 balão só, sem quebra artificial.

### 1.2 Timeout do fresh fetch
- 🟢 "qual minha copy campeã, com dado de agora" (força `get_top_creatives fresh`). **Esperado:** responde dentro de ~30s; se a Meta demorar, **degrada pro persistido** (nota "usa o último dado"), nunca o fallback genérico.
- 🔴 Conta com MUITOS anúncios: o refresh não puxa a conta inteira (só top-N) — não estoura o turno.
- Conferir log: **sem** `conversation:turn falhou`; se degradou, `get_top_creatives:refresh live degradou`.

### 1.3 Rascunho pelo banco (o bug do "recusar")
- 🟢 Proponha uma campanha (cria draft + approval). Pergunte **"qual público e qual criativo?"** → responde **na hora** (do rascunho), com o anúncio real + público pelo modo. Sem os ~3min, sem fallback.
- 🟢 **Espere >30min** (ou limpe o checkpoint) e diga **"recusa o rascunho"** → o agente acha pelo `list_pending`/`get_pending_draft` e **recusa** (approval → `rejected`); o card **some** do site.
- 🟢 "aprova o rascunho" (por id) → enfileira o apply (cria pausada) + approval de ativação.
- 🔴 Sem rascunho pendente → "recusa o rascunho" responde "não há rascunho aguardando".
- Banco: `select status from approvals where kind='draft' order by created_at desc limit 1` → `rejected`/`approved`.

### 1.4/1.5 Wording + modelo de copy
- 🟢 O eco de criação promete só "trocar o criativo no site" (não "editar").
- Conferir: `COPY_MODEL` no `.env.example`; sem `DEFAULT_COPY_MODEL` hardcoded em draft-proposal.ts.

---

## Slice 2 — miniatura do criativo no card

- 🟢 `/approvals` → card do rascunho mostra **1 miniatura** (o criativo compartilhado pelas copies) + rótulo "vídeo · reusado de um anúncio da conta".
- 🟢 Recarregar → a miniatura vem do cache (304 no ETag; conferir na aba Network que a 2ª carga é 304).
- 🔴 Reuse cujo anúncio sumiu/URL fbcdn falha → placeholder "sem prévia" (não erro cru).
- 🔴 Rascunho `duplicate` (sem criativo próprio) → sem bloco de miniatura.

---

## Slice 3 — picker (vídeo/reuse) + público

### Picker "trocar criativo"
- 🟢 Card `from_scratch` → "Trocar criativo" abre: seção **"anúncios da conta"** (vídeos ao vivo, com thumb) + seção **"biblioteca"** (imagem com preview / vídeo com selo).
- 🟢 Escolher um **anúncio ao vivo** → troca; conferir que o `spec.creative` virou o vídeo (video_id **fresco**, não o persistido).
- 🟢 Escolher um **upload da biblioteca** → troca.
- 🔴 Conta nova (biblioteca + serving vazios) → empty-state que **guia** ("rode uma análise ou me mande um criativo"), não picker mudo.
- 🔴 Reuse de imagem ao vivo → não é oferecido (só vídeo; fast-follow).

### Controle de público (reuse × amplo)
- 🟢 Card → dois botões: "Herda o que já converte" / "Deixa a Meta escolher". O ativo aparece destacado. Alternar → toast + `spec.targeting` muda (`reuse_adset` ↔ `advantage_plus`).
- 🟢 Chat: "muda o público pra amplo" → `adjust_draft(audience:'broad')`, eco mostra "Público: a Meta escolhe".
- 🔴 Alternar pra "reuse" sem público provado (conta sem adset vencedor) → 404/erro amigável ("não consegui ajustar o público").
- 🔴 Sem jargão "Advantage+" em nenhum texto ao usuário.

---

## Slice 4 — criativo pelo WhatsApp fecha o loop

- 🟢 Com um rascunho `from_scratch` pendente → mande uma **imagem** no WhatsApp. **Esperado:** "imagem guardada! quer que eu use ela no rascunho? Responde *sim*". Responda **"sim"** → "Troquei o criativo do rascunho…" (o `spec.creative` virou o upload). Redis: `creative-offer:<conv>` setado e depois limpo.
- 🟢 Sem rascunho pendente → mande uma imagem → "quer que eu crie uma campanha com ela?" → "sim" → propõe a campanha semeada com o criativo.
- 🔴 Responda algo **composto** ("sim, mas muda o budget pra 80") → NÃO resolve no automático; cai no turno normal (a oferta segue no TTL).
- 🔴 Mande um **vídeo** → só "tô processando" (oferta de vídeo = fast-follow).
- 🔴 Deixe passar 30min → a oferta expira (TTL); "sim" já não faz nada especial.

---

## Slice 5 — escala

### 5.1 Proativo sobe budget
- 🟢 Numa conta com vencedor **CBO no teto de budget** + `proactiveDrafts` ligado, rode a análise. **Esperado:** o proativo cria a **aprovação de adjust_budget** + recomendação "Escalar seu vencedor (subir orçamento)" — antes era ignorado. Banco: `approvals kind='action' action_type='adjust_budget'` + `recommendations toolKey='adjust_budget'`.
- 🟢 Vencedor duplicável (não-CBO, passo grande) → segue no ramo duplicate (rascunho), como antes.

### 5.2 Transparência do clamp
- 🟢 "escala o vencedor" cujo budget novo passa do teto de gasto novo → o eco mostra "(você pediu R$X, mas seu teto é R$Y)". No site (card de duplicata) → "(você pediu X — cortei pro seu teto)".
- 🔴 Sem clamp (dentro do teto) → sem a nota.

---

## Roteiro E2E docker (resumo executável)

1. `docker compose -f docker/docker-compose.yml up -d` + `pnpm db:migrate`.
2. `pnpm dev` (api+worker+web). Conta/agente com token válido + WhatsApp conectado.
3. Percorrer 1.1→5.2 acima; conferir banco (approvals/campaign_drafts) e redis (creative-offer) nos pontos marcados.
4. Sem token real da Meta: os caminhos só-DB (1.1, 1.3 recusar, 5.2 eco, miniatura upload) validam; os que tocam a plataforma (fresh, serving live, reuse video_id fresco, proativo) precisam de token.

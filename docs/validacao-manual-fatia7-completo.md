# Validação manual — Fatia 7 COMPLETA (branch `feat/fatia7-criacao-campanhas`)

> Roteiro **hands-on**: para cada fluxo tem **[Site]** (o que clicar + campos/estados que devem
> aparecer), **[WhatsApp]** (a mensagem exata pra colar + a resposta esperada do agente) e
> **comandos prontos** (setup/DB) pra copiar e colar. `✅` = deve passar · `⛔` = caminho triste
> (falha amigável, sem quebrar).
>
> **Segurança:** tudo que criar na Meta nasce **PAUSED**; §19 reverte. Use **conta de teste**; nunca
> mexer em produção. Substitui os roteiros parciais (`-fatia7.md` e `-fastfollows.md`).
>
> Legenda dos blocos: bloco ` ```bash ` = comando (tem botão Run); bloco de **mensagem WhatsApp** =
> texto simples pra você digitar/colar no chat do número da org.

---

## 0. Subir o ambiente

```bash
cd C:\dev\agente-trafego && docker ps
```
```bash
pnpm install && pnpm db:migrate && pnpm dev
```
**Deve aparecer:**
- ✅ Log da API: algo como `api up` / `http://localhost:3333`.
- ✅ Log do worker terminando com `whatsapp-media-intake + mail` (o poll de vídeo e o reaper sobem no boot).
- ✅ Web em `http://localhost:4200` (tela de login).

Liberar seu acesso (gate beta), se pedir:
```bash
pnpm access:grant seu-email@dominio.com
```

---

## 1. Token Meta válido (crítico)

**[Site]** menu **Integrações** → colar o **System User token** (app publicado; BM+Página+Pixel
atribuídos) → **Salvar** → escolher a conta de teste na lista.

**Deve aparecer:** ✅ conta conectada, sem banner de erro. ⛔ token ruim → banner "não consegui validar
esse token, verifique e cole de novo" (tela não quebra).

**Verificar:**
```bash
docker exec docker-postgres-1 psql -U postgres -d trafego -tc "select ad_account_id, currency, token_status from ad_accounts;"
```
- ✅ `token_status = valid`.

---

## 2. Config do agente — autonomia + ações por-ação (SITE · Conta → aba **Agente**)

> **[MUDOU nesta fatia — "Config por-ação"]** As 6 ações agora vivem numa **lista única** dentro de
> **"Até onde o agente pode ir → opções avançadas"** (antes o on/off das 4 estava em "Limites de
> segurança"). Cada linha tem **on/off** (grava `agent_tool_bindings`) **+** um seletor de
> **autonomia por-ação** que **vence** a autonomia por origem.

**[Site] — o que fazer + o que deve aparecer:**
1. Seção **"Até onde o agente pode ir"** (Autonomia):
   - ✅ autonomia **por origem**: `Regras do playbook` × `Análise do agente (IA)` (segmented de 4:
     só avisa · sugere+OK · age no seguro · age sozinho).
   - ✅ subgrupo **"Quando o crescimento passa do limite de mudança"** com 3 opções:
     **perguntar · subir orçamento · duplicar**. Default = **perguntar**. (Copy sem "limite seguro".)
2. Clicar **"opções avançadas"** (Ações permitidas) → **lista única por-ação**:
   - ✅ 4 de otimização: **Pausar · Retomar · Mudar status · Ajustar orçamento** (cada uma com switch on/off).
   - ✅ bloco **"Criação (gasto novo)"**: **Criar campanha · Duplicar para escalar** (switch on/off).
   - ✅ ao **ligar** uma ação, aparece o seletor **"Autonomia desta ação"** (criação: "Quando ele pode
     criar sozinho") com: **herda a origem · só avisa · sugere+OK · age no seguro · age sozinho**.
   - ✅ **"herda a origem"** (default) = usa a autonomia por origem acima.
3. **"Limites de segurança"** (seção separada):
   - ✅ **NÃO** existe mais a lista "Ações permitidas" aqui (migrou pra lista única do passo 2).
   - ✅ segue com dry-run, kill-switch, mudança máx. de orçamento, máx. entidades/dia, teto de custo de IA.
   - ✅ **"Limites de criação"**: `Orçamento novo máx./dia`, `Máx. campanhas novas/dia`, `Passo de escala (%)`.
     O símbolo de moeda **segue a conta** (BRL → `R$`; conta USD → `$`).
4. **Notificações** → ligar **"Rascunhos proativos"**.
5. **Salvar** → ✅ recarregar a página mantém tudo (on/off, autonomia por-ação, preferência de escala).

**Cenário de teste da lista única (faça e confira no banco):**
- Desligue **Duplicar para escalar** + ponha **Criar campanha = age sozinho** + **Ajustar orçamento = sugere+OK** → Salvar.

**Verificar:**
```bash
docker exec docker-postgres-1 psql -U postgres -d trafego -c "select tool_key, mode from agent_tool_bindings order by tool_key;"
```
```bash
docker exec docker-postgres-1 psql -U postgres -d trafego -c "select autonomy_policy->'byAction' as por_acao, autonomy_policy->>'scaleAggressivePreference' as pref_escala from agents;"
```
```bash
docker exec docker-postgres-1 psql -U postgres -d trafego -c "select max_new_daily_budget_minor, max_new_campaigns_per_day, scale_pct from guardrail_configs;"
```
- ✅ `agent_tool_bindings` tem 6 linhas (as 6 ficam **explícitas** ao salvar — "backfill na edição").
  `duplicate_scale = disabled`, o resto `enabled`.
- ✅ `byAction` = `{"create_campaign":"act_full","adjust_budget":"suggest"}` (só os overrides ≠ "herda").
- ⛔ **Salvar** falhando com "Payload inválido" em alguma seção = bug a reportar (anote qual seção).

---

## 2b. Consistência dos gates + CTA gateada (efeito de desligar uma ação)

> **[Config por-ação]** Desligar uma ação vale em **TODAS as superfícies** de escrita — chat, apply,
> site **e o run autônomo** — lendo da MESMA fonte (`agent_tool_bindings`). Continue do cenário do
> passo 2 (**Duplicar para escalar = OFF**, **Ajustar orçamento = ON**).

**[Site]:**
- ✅ Na análise da conta (aba visão geral), o card de um **vencedor** **NÃO** mostra mais o botão **"Escalar"**
  se **Duplicar** E **Ajustar orçamento** estiverem ambos OFF. (Com só um dos dois ligado, o botão aparece
  e a escala usa o ramo habilitado.)

**[WhatsApp] — peça a escrita desligada e confirme o comportamento honesto:**
- Com **Duplicar OFF** + **Ajustar orçamento ON**, envie: `duplica meu melhor vencedor pra escalar`
  - ✅ o agente **não** propõe duplicar (capacidade off) — ele **oferece subir o orçamento** (o ramo
    habilitado) sob eco+confirma. Não fica um rascunho de duplicata que barraria depois no apply.
- Desligue **os dois** (Duplicar + Ajustar orçamento) e repita
  - ✅ recusa clara: *"escalar está desligado para este agente…"* (sem stack).
- Reative **Ajustar orçamento** e envie: `sobe 20% o orçamento da campanha X`
  - ✅ **eco + confirma** (chat sempre confirma antes de escrever) e, no "sim", aplica.

**[Run autônomo]** com o agente em **age sozinho** e uma ação desligada nos bindings:
- ✅ o agente **não** aplica sozinho a ação desligada (o guardrail do run resolve `allowedActions`
  dos bindings no início do run). Ex: `pause_entity` OFF → nenhum `pause` autônomo, mesmo em `act_full`.

**Verificar (nada criado/aplicado quando desligado):**
```bash
docker exec docker-postgres-1 psql -U postgres -d trafego -c "select id, kind, status from campaign_drafts order by created_at desc limit 5;"
```
- ✅ nenhum rascunho novo `duplicate` enquanto `duplicate_scale=disabled`.

---

## 3. Creative Library — upload de IMAGEM + **preview** (SITE · Conta → aba **Criativos**)

> **[MUDOU]** upload virou **multipart**; o card mostra **preview** (miniatura), não só o `image_hash`.

**[Site]:**
1. Clicar **"Subir criativo"** (é botão — teste teclado: Tab até ele + Enter abre o seletor) → escolher `.png`/`.jpg`.
2. **Deve aparecer:**
   - ✅ Toast "imagem enviada — já dá pra reusar num rascunho".
   - ✅ Card novo com **miniatura visível**, canto "Enviado", rodapé "imagem · pronto".
   - ✅ Recarregar a página → miniatura carrega na hora (cache forte; sem piscar).
3. ⛔ Re-subir **o mesmo arquivo** → não cria card duplicado (dedup).

**Verificar:**
```bash
docker exec docker-postgres-1 psql -U postgres -d trafego -c "select origin,format,status, meta_image_hash is not null as tem_hash, storage_ref is not null as tem_blob from creative_assets order by created_at desc limit 3;"
```

**⛔ Tristes (visual):**
- Derrubar a API e recarregar a aba → **caixa de erro com "Tentar de novo"** (NÃO o empty-state "nenhum criativo").
- Miniatura que não carrega (asset sem blob) → placeholder **"sem preview"** (nunca ícone quebrado).
- **Cross-tenant:** cole no navegador a URL do blob de outra conta:
  ```
  http://localhost:4200/api/accounts/<OUTRA_CONTA_ID>/creatives/<assetId>/blob
  ```
  → **404** (nunca serve o binário de outra conta/org).

---

## 4. **[NOVO] Upload de VÍDEO** (SITE · aba Criativos · async)

**[Site]:**
1. **"Subir criativo"** → escolher um **MP4** (< 200MB).
2. **Deve aparecer:**
   - ✅ Toast "Vídeo enviado — estou processando; ele fica pronto pra usar em instantes."
   - ✅ Card com status **"processando…"** (sem miniatura ainda; ícone/label "vídeo").
   - ✅ Sem recarregar a página, o card vira **"pronto"** quando a Meta terminar. Se falhar/estourar
     (~16min) → **"erro"** com texto.

**Verificar:**
```bash
docker exec docker-postgres-1 psql -U postgres -d trafego -c "select format,status, meta_video_id is not null as tem_vid from creative_assets where format='video' order by created_at desc limit 3;"
```

**⛔ Tristes:**
- Arquivo **tipo inválido** (PDF/zip) → toast/erro **415** "Formato não suportado. Envie imagem … ou vídeo …".
- **Grande demais** (imagem >15MB / vídeo >200MB) → **413** "Arquivo grande demais. Limite: XMB para …".

---

## 5. Intake de mídia — WhatsApp (imagem + **[NOVO] vídeo**)

Pré: Evolution conectada (número da org) + você é **contato verificado** + conta em foco resolvida
(org de 1 conta OU foco setado).

**[WhatsApp] — imagem:** mande uma **foto** pro número da org (com ou sem legenda).
> Resposta esperada do agente:
> *"imagem guardada na biblioteca de criativos da <conta> — já dá pra usar num rascunho de campanha."*
- ✅ A imagem aparece na aba **Criativos** (origem "Enviado"). ✅ **Não** dispara conversa/análise.

**[WhatsApp] — [NOVO] vídeo:** mande um **vídeo curto** (< 50MB).
> Resposta esperada:
> *"vídeo recebido na <conta> — tô processando; ele fica pronto pra usar num rascunho em instantes."*
- ✅ Asset processando → pronto na biblioteca.

**⛔ Tristes (mensagens prontas):**
- Org com 2+ contas **sem foco** → mande a imagem → o agente responde *"recebi seu criativo! só me diz
  de qual conta ele é…"*. Então mande (copiar):
  ```
  foca na conta <nome da conta>
  ```
  e reenvie a mídia.
- Mídia de **número desconhecido** (não-verificado) na DM → **silêncio** (nenhuma resposta).
- **Vídeo grande** (> 50MB) → *"esse vídeo é grande demais pra eu receber por aqui (limite 50MB) — sobe
  ele pela biblioteca de criativos no site."*

---

## 6. Escalar vencedor — SITE (CTA + **[NOVO] ASK inline**)

Pré: conta com um "vencedor" na última análise. **[Site]** Conta → aba de análise (cards de campanha).

**[Site]:**
1. No card da campanha **campeã** (tier "campeã") → botão **"Escalar"** (canto do card, ao lado de "Silenciar").
2. **Passo pequeno** (scale_pct ≤ faixa segura) → cria direto um **rascunho proposto** de raise (vai pra Aprovações).
3. **[NOVO] Passo agressivo** (scale_pct > faixa) → **abaixo do card** aparecem **2 botões inline**:
   - **"Subir orçamento +X%"** (fundo tomate) e **"Duplicar (crescer +Y%)"** + **"Agora não"**.
   - Clicar um → cria a proposta correspondente; toast "Proposta de escala criada … Aprove em Sugeridas."
4. **Deve aparecer:** a proposta em **Aprovações → Rascunhos** (duplicar) ou em **Sugeridas** (raise).

**Verificar:**
```bash
docker exec docker-postgres-1 psql -U postgres -d trafego -c "select kind,status,origin,(spec->>'dailyBudgetMinor') as budget from campaign_drafts order by created_at desc limit 3;"
```

---

## 7. Escalar vencedor — WhatsApp (**[NOVO] intent: budget × escala**)

**[WhatsApp] — budget explícito (sempre sobe, nunca duplica).** Cole:
```
aumenta o orçamento da <campanha> em 20%
```
> ✅ O agente ecoa um **ajuste de orçamento** ("vou subir +20% o budget de …") e pede confirmação.
> **Não** propõe duplicação. "escala em 30%" (com número) também cai aqui.

**[WhatsApp] — intent aberto, passo pequeno.** (scale_pct dentro da faixa) Cole:
```
escala o vencedor
```
> ✅ O agente ecoa um **raise** e pede OK.

**[WhatsApp] — [NOVO] intent aberto, passo agressivo.** (scale_pct > faixa) Cole:
```
escala o vencedor
```
> ✅ O agente **PERGUNTA** em linguagem plana, algo como: *"O aumento que você pediu é grande pro
> '<vencedor>'. Posso subir o orçamento dele em até X% (o limite seguro, que não reinicia o desempenho),
> ou criar uma cópia separada pra crescer mais sem arriscar a que já funciona. O que você prefere?"*
> **Não cria nada ainda.** Então responda (copiar uma):
```
sobe o orçamento
```
```
pode duplicar
```
> ✅ "sobe o orçamento" → eco de raise + confirma. "pode duplicar" → rascunho de duplicação (card no site) + confirma.

**Confirmar/cancelar** (qualquer escrita):
```
sim
```
```
não, cancela
```
- ✅ Toda escrita passa por **eco + espera confirmação**. Referência ambígua → o agente pergunta.

---

## 8. **[NOVO] Adset legado (standard_enhancements / 3858504) → falha honesta + 2 saídas**

Pré: um **vencedor antigo** cujo criativo use "aprimoramentos padrão" (comum em contas com histórico).

**[WhatsApp/Site]:** peça pra **duplicar** esse vencedor (passo agressivo → escolher duplicar) → **aprovar**.
> ✅ A saga tenta a cópia, a Meta recusa (subcode 3858504), e o desfecho é **honesto**:
> *"esse vencedor usa um recurso que a Meta descontinuou para cópia, então não consigo cloná-lo
> fielmente. Posso subir o orçamento dele agora, ou você recria o criativo no Gerenciador de Anúncios
> que eu duplico."* No site, a aprovação fica **bloqueada** com esse motivo.
- ✅ **Nada** é criado (sem órfão). No chat, responda `então sobe o orçamento` → vira raise (funciona).
- ✅ **Contraste:** duplicar um adset **novo/limpo** (criativo sem aprimoramentos) funciona normalmente.

**Verificar:**
```bash
docker exec docker-postgres-1 psql -U postgres -d trafego -c "select id,status,resolved_reason from approvals where draft_id is not null order by created_at desc limit 3;"
```

---

## 9. Criar do zero + refino conversacional — WhatsApp

**[WhatsApp]** cole:
```
cria uma campanha de vendas reusando o criativo campeão
```
> ✅ O agente propõe defaults (objetivo da meta/conta, Página/Pixel **inferidos e mostrados no eco**,
> orçamento, N variações de **copy gerada por IA** em tom sóbrio) e pede confirmação.

Refinar (cole uma de cada vez; o agente **re-ecoa** o rascunho a cada ajuste):
```
muda o orçamento pra R$ 30 por dia
```
```
deixa 3 variações de copy
```
```
regenera as copies num tom mais direto
```
```
cria pausada
```
Confirmar:
```
sim
```
- ✅ Objetivo = meta do agente (`conversionGoal`) senão infere; **sempre confirma**. >1 Página → pergunta.
- ⛔ `cria uma campanha de xpto` (goal inválido) → não vira objetivo errado (infere/confirma o real).
- ⛔ Conta **sem anúncio** de onde reusar Página/criativo → bloqueia pedindo a Página/um criativo.
- ⛔ `create_campaign` desligado nos bindings (§2) → recusa honesta ("não faço isso hoje").

---

## 10. Aprovação de rascunho — site + WhatsApp (**[NOVO] preview + IDs relabelados + picker**)

**[Site] — Aprovações → "Rascunhos de campanha":**
- ✅ O card mostra: estrutura + **"Gasto novo: R$ X/dia"** + copy (título + texto) + **"Página: conectada"**
  e **"Rastreamento: pixel conectado"** (**[NOVO]** — não os IDs crus da Meta).
- ✅ **[NOVO] "Trocar criativo"** (só rascunho criar-do-zero): clicar → abre **grade da biblioteca com
  previews** → escolher um → "Criativo trocado neste rascunho".
- Botões: **[Recusar]** · **[Aprovar]**. Aprovar = re-check fresco; barrado → **`blocked`** + motivo visível.

**[WhatsApp]** cole:
```
aprova o rascunho de escala
```
> ✅ Referência inequívoca aplica; ambíguo → o agente pergunta qual. O desfecho ("✅ criado" / motivo do
> bloqueio) é **empurrado** na conversa.

**⛔ Tristes:**
- **Apply concorrente:** aprove no **site** e no **WhatsApp** na mesma janela → aplica **1×** (a 2ª:
  "já está sendo aplicado"). **Não** cria em dobro.
- Rascunho sem resposta em **24h** → expira e some da lista.

---

## 11. Proatividade de criação — propor (default) × **[NOVO] auto-criar** (age sozinho)

Pré: "Rascunhos proativos" ligado (§2) + um vencedor OU conta parada (cold_start).

### 11a. Modo default — SÓ PROPÕE (criação **não** está "age sozinho")

**[Site]** Conta → **"Analisar agora"** (ou esperar o cron). Aguardar o run terminar.
> ✅ Havendo oportunidade → nasce um **rascunho como recomendação** + **nudge no WhatsApp** rotulado
> como proposta do agente + o porquê.
- ✅ Aparece em **Aprovações** e na **Timeline** (evento "… proposta"). Throttle: **1 proativo pendente/conta**.
- ✅ **Não** auto-aplica (fica pendente de OK).

```bash
docker exec docker-postgres-1 psql -U postgres -d trafego -c "select origin,status,kind from campaign_drafts where origin='proactive' order by created_at desc limit 3;"
```
- ✅ `status = proposed` (esperando OK).

### 11b. **[NOVO — Config por-ação C]** Auto-criar (age sozinho) — SEMPRE nasce PAUSADA

**Pré:** em §2, ponha **Duplicar para escalar = age sozinho** (ou Criar campanha, conforme a oportunidade),
mantenha **"Rascunhos proativos"** ligado e um **vencedor** claro na conta. Salvar.

**[Site]** Conta → **"Analisar agora"**. Aguardar o run.
- ✅ **[WhatsApp]** chega um **nudge transparente**: *"🤖 Agi sozinho e dupliquei seu vencedor… deixei
  **pausada**, esperando seu OK (não veicula até você ativar). Por quê: …"* — o quê + porquê + pausada + próximo passo.
- ✅ A campanha/duplicata é criada na Meta **PAUSADA** (não veicula) e a aprovação some do inbox (resolvida).

```bash
docker exec docker-postgres-1 psql -U postgres -d trafego -c "select origin,status,kind,created_ids from campaign_drafts where origin='proactive' order by created_at desc limit 3;"
```
- ✅ `status = created` + `created_ids` preenchido.
- ⛔ **Meta:** a entidade criada tem de estar **PAUSED** (confira no Gerenciador de Anúncios — nunca ATIVA).
- ✅ **Guardrail é a rede** (não há eco+confirma no caminho autônomo): baixe muito `Orçamento novo máx./dia`
  (§12) → o run auto tenta criar e é **barrado** (nudge honesto "parei: …"), nada some sem aviso.
- ✅ **Só-com-criativo:** conta sem criativo reusável → criar-do-zero é barrado (cold-start vira proposta, não auto).

---

## 12. Guardrails de gasto novo + kill-switch

**[Site]** Segurança → Limites de criação: pôr `Orçamento novo máx./dia` **baixo** (ex: R$ 5).
**[WhatsApp]** peça criar/escalar com orçamento acima (ex: R$ 50/dia) → aprovar.
- ✅ No apply, o guardrail **clampa** pro teto (ou barra se estourar `Máx. campanhas novas/dia`); desfecho honesto.
- ⛔ **Kill-switch ligado** (Segurança) → toda criação vira **`blocked`**, mesmo aprovada.

---

## 13. Undo (reverter criação)

**[WhatsApp]** cole:
```
desfaz a última campanha que você criou
```
- ✅ As entidades criadas são **PAUSADAS** (nunca deletadas); o rascunho vira `reverted`; confirma na conversa.
```bash
docker exec docker-postgres-1 psql -U postgres -d trafego -c "select status, created_ids from campaign_drafts where status='reverted' order by updated_at desc limit 2;"
```

---

## 14. Timeline (SITE · Conta → aba **Timeline** · filtro "Campanhas")

- ✅ **"Nova campanha proposta"** / **"Escala de vencedor proposta"** — badge "rascunho", "R$ X/dia" na moeda da conta.
- ✅ **"Campanha criada"** / **"Escala criada"** — badge "criada" (**[NOVO]** cor de **sucesso/menta**, não tomate).

---

## 15. **[NOVO] Erro da Meta legível (`error_user_msg`)**

Force um erro **acionável** (ex: reconectar com token sem escopo, ou uma ação numa conta sem posse).
- ✅ **[Site]** a mensagem de erro traz o **texto legível da Meta + o próximo passo** (ex: "…
  Verifique e cole de novo").
- ✅ **[WhatsApp]** o desfecho lê *"A Meta informou: <mensagem legível>."* (não "a Meta não respondeu").
- ⛔ **Nunca** aparece a mensagem técnica de dev (OAuthException / stack / id / token). Rate-limit
  (transiente) → texto amigável canned (não o cru).

---

## 16. **[NOVO] StoragePort S3-compat (produção)**

Subir MinIO local (uma vez):
```bash
docker run -d --name minio-e2e -p 9000:9000 -p 9001:9001 -e MINIO_ROOT_USER=minio -e MINIO_ROOT_PASSWORD=miniosecret minio/minio server /data --console-address ":9001"
```
Abrir `http://localhost:9001` (minio/miniosecret) → criar bucket **creatives**. No `.env`:
```
STORAGE_DRIVER=s3
STORAGE_ENDPOINT=http://localhost:9000
STORAGE_BUCKET=creatives
STORAGE_ACCESS_KEY=minio
STORAGE_SECRET_KEY=miniosecret
STORAGE_REGION=us-east-1
STORAGE_FORCE_PATH_STYLE=true
```
Reiniciar api+worker. Depois suba uma imagem (§3).
- ✅ O objeto aparece no bucket MinIO (chave `org/<id>/creatives/<sha>.<ext>`); o **preview no site continua funcionando** (serve pela rota autenticada, lendo do S3).
- ⛔ `STORAGE_DRIVER=s3` **sem** bucket/creds → o **boot falha** com erro claro (não sobe torto).
- ✅ Voltar `STORAGE_DRIVER=local` → tudo no disco, sem mudar código.

---

## 17. Caminhos tristes — checklist rápido
- ⛔ Token inválido → banner + `token_status=invalid`; telas ok.
- ⛔ Conta sem Página/anúncio → criação bloqueada com pedido claro.
- ⛔ goal inválido no chat → não vira objetivo errado.
- ⛔ create/duplicate desligado → recusa honesta.
- ⛔ Guardrail estoura / kill-switch → `blocked`/`failed` com motivo; nada criado.
- ⛔ Apply concorrente (chat+site) → aplica 1×.
- ⛔ Mídia de desconhecido (DM) → silêncio; sem foco → pede conta; vídeo grande no WhatsApp → manda pro site.
- ⛔ Saga falha no meio → `failed` + motivo; retry retoma por `createdIds`.
- ⛔ Fetch da biblioteca falha → erro com "Tentar de novo" (não empty-state).
- ⛔ **Adset legado (3858504)** → **[AGORA]** bloqueio honesto + 2 saídas.
- ⛔ Upload tipo inválido → 415; grande demais → 413 (PT).
- ⛔ Cross-tenant no blob → 404.

---

## 18. Transparência (invariante 12) — checklist
- [ ] Eco antes de escrita: **o quê / quanto / Página / Pixel / ativa-ou-pausada**.
- [ ] Jargão traduzido (CPA/adset/pixel; ASK usa linguagem plana, sem "reentrar em aprendizado" cru).
- [ ] Proposta proativa rotulada + porquê. Bloqueio explica limite + saída.
- [ ] **Auto-criação (age sozinho):** nudge transparente (o quê/porquê/**pausada**/próximo passo); nasce PAUSED; guardrail é a rede (barra → nudge honesto).
- [ ] Erro Meta = texto legível envelopado + próximo passo (nunca stack/token).
- [ ] Mesmos estados/verdade nos 2 canais (site e WhatsApp).

---

## 19. Limpeza
```
desfaz a última campanha que você criou
```
(ou, no Gerenciador de Anúncios, filtrar pelos nomes de teste e excluir). **Rotacionar o token de teste**
na Meta. Se subiu MinIO:
```bash
docker rm -f minio-e2e
```
```bash
docker exec docker-postgres-1 psql -U postgres -d trafego -c "select kind,status,origin from campaign_drafts order by created_at desc limit 10;"
```

---

## 20. E2E automatizado (docker, DB efêmero, não-destrutivo)
- Fast-follows: `docs/validacao-manual-fatia7-fastfollows.e2e.md` (migra 0000→0038 → schema → queries → drop).
- **Config por-ação:** `docs/validacao-manual-config-por-acao.e2e.md` (migra 0000→**0039** → constraint
  `agent_tool_bindings_agent_tool_uq` → seed do catálogo (6 tools) → smoke bindings/allowedActions/byAction
  → `pnpm test` → dropa; `trafego` intocado). **Executado 2026-08-27: verde.**

### Referência — consultas DB (copiar)
```bash
docker exec docker-postgres-1 psql -U postgres -d trafego -c "select id,kind,status,origin,created_at from campaign_drafts order by created_at desc limit 10;"
```
```bash
docker exec docker-postgres-1 psql -U postgres -d trafego -c "select id,status,(draft_id is not null) as eh_rascunho,action_type from approvals order by created_at desc limit 10;"
```
```bash
docker exec docker-postgres-1 psql -U postgres -d trafego -c "select origin,format,status from creative_assets order by created_at desc limit 10;"
```

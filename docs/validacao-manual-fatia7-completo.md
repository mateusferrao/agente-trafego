# Validação manual — Fatia 7 COMPLETA (branch `feat/fatia7-criacao-campanhas`)

> Roteiro **único, prático, passo a passo** de TODA a Fatia 7 nesta branch: a criação/escala/copy/
> biblioteca/intake originais (S0–S8) **+** os 6 fast-follows (erro Meta legível, adset legado,
> preview/picker, S3-compat, vídeo, escala com ASK). Cada bloco: **pré → passos → esperado (✅) →
> como verificar**. `⛔` = caminho triste (falha amigável, sem quebrar).
>
> **Segurança:** tudo que criar na Meta nasce **PAUSED**; o §19 reverte tudo. Nunca mexer na campanha
> real de produção — só leitura/origem. Use **conta de teste**.
>
> Substitui `validacao-manual-fatia7.md` (S0–S8) + `-fastfollows.md` (consolidados aqui).

---

## 0. Subir o ambiente
Pré: Docker (postgres+redis), Node ≥22, pnpm.
```bash
cd C:\dev\agente-trafego
docker ps                 # docker-postgres-1 e docker-redis-1 "Up"
pnpm install
pnpm db:migrate           # aplica migrations 0000→0038 (Fatia 7 + fast-follows)
pnpm dev                  # api (:3333) + worker + web (:4200)
```
- ✅ API viva: `http://localhost:3333/health`.
- ✅ Worker: log `worker up: … whatsapp-media-intake + …` (o poll de vídeo e o reaper sobem juntos).
- ✅ Web: `http://localhost:4200`, logar. Acesso beta: `pnpm access:grant seu-email@dominio.com`.

---

## 1. Token Meta VÁLIDO (crítico — não pule)
1. Site → **Integrações** → colar o **System User token** (app publicado, BM+Página+Pixel atribuídos).
2. Salvar → valida → listar contas → escolher a de teste.
```bash
docker exec docker-postgres-1 psql -U postgres -d trafego -tc \
"select ad_account_id, currency, token_status from ad_accounts;"
```
- ✅ `token_status = valid`.
- ⛔ Token inválido → banner "reconecte" + `token_status=invalid`; tela não quebra.

---

## 2. Config do agente — criação (SITE · Conta → aba Agente)
1. **Autonomia** ("Até onde o agente pode ir"): frase-fato de que *criar/escalar pedem aprovação*.
2. **Opções avançadas** → lista **por-ação**: ligar `create_campaign` + `duplicate_scale` (bindings).
   Afrouxar a autonomia de uma criação → **alerta proporcional** (from_scratch+copy-IA > duplicate).
3. **[NOVO] "Escalar um vencedor além do limite seguro"**: seletor **perguntar / subir orçamento /
   duplicar** (`scaleAggressivePreference`). Default = **perguntar**.
4. **Segurança → Limites de criação**: `Orçamento novo máx./dia`, `Máx. campanhas novas/dia`, `Passo de escala (%)`.
5. **Notificações**: ligar **Rascunhos proativos**.
6. Salvar.
- ✅ Símbolo de moeda ao lado do orçamento segue a moeda da conta (BRL→`R$`, USD→`$`) — não fixo.
- ✅ Recarregar mantém tudo (persistiu), inclusive a preferência de escala.
```bash
docker exec docker-postgres-1 psql -U postgres -d trafego -c \
"select autonomy_policy->>'scaleAggressivePreference' as pref from agents;"
docker exec docker-postgres-1 psql -U postgres -d trafego -c \
"select max_new_daily_budget_minor, max_new_campaigns_per_day, scale_pct from guardrail_configs;"
```

---

## 3. Creative Library — upload de IMAGEM + **preview** (SITE · aba Criativos)
> **[MUDOU]** upload agora é **multipart** (não base64); o card mostra **preview** (não só o hash).
1. Aba **Criativos** → "Subir criativo" (botão; teste por teclado: Tab+Enter abre o seletor) → escolher `.png`/`.jpg`.
2. ✅ Toast "imagem enviada — já dá pra reusar". Card com **preview (miniatura)**, origem "Enviado", "imagem · pronto".
3. ✅ Recarregar a página → a miniatura vem do cache forte (`Cache-Control: private, immutable`; 304 no revalidate).
4. ✅ Re-subir o **mesmo arquivo** → dedup (não duplica o asset).
```bash
docker exec docker-postgres-1 psql -U postgres -d trafego -c \
"select origin,format,status, meta_image_hash is not null as tem_hash, storage_ref is not null as tem_blob from creative_assets order by created_at desc limit 3;"
```
- ⛔ Derrubar a API e recarregar → **estado de erro com "Tentar de novo"** (não o empty-state).
- ⛔ Miniatura que falha (asset sem blob) → placeholder "sem preview" (nunca ícone quebrado).
- ⛔ **Cross-tenant:** abrir `GET /api/accounts/<OUTRA_CONTA>/creatives/<assetId>/blob` de asset de outra
  org → **404** (nunca serve o binário de outra conta).

---

## 4. **[NOVO] Upload de VÍDEO** (SITE · multipart async)
1. Aba Criativos → "Subir criativo" → escolher um **MP4** (< 200MB).
2. ✅ Toast "Vídeo enviado — estou processando…". Card com status **"processando…"**.
3. ✅ Sem recarregar, o card vira **"pronto"** quando a Meta terminar (a aba faz poll enquanto `pending`).
   Se falhar/estourar (~16min) → **"erro"** com texto.
```bash
docker exec docker-postgres-1 psql -U postgres -d trafego -c \
"select format,status, meta_video_id is not null as tem_vid from creative_assets where format='video' order by created_at desc limit 3;"
```
- ⛔ **Tipo inválido** (PDF/zip) → **415** amigável ("Formato não suportado…").
- ⛔ **Grande demais** (imagem >15MB / vídeo >200MB) → **413** PT ("Arquivo grande demais. Limite: XMB…").

---

## 5. Intake de mídia — WhatsApp (imagem + **[NOVO] vídeo**)
Pré: Evolution conectada (número da org) + **contato verificado** + conta em foco resolvida.
1. **Imagem** no WhatsApp da org (com/sem legenda) → ✅ *"imagem guardada na biblioteca…"*; aparece na aba Criativos; **não** vira turno de conversa.
2. **[NOVO] Vídeo** (< 50MB, cap WhatsApp) → ✅ *"vídeo recebido … tô processando; fica pronto em instantes."*; asset processando→pronto.
- ⛔ **Org 2+ contas sem foco** → pede a conta ("de qual conta é?"), não sobe. Setar foco e reenviar.
- ⛔ **Desconhecido** (não-verificado) na DM → **silêncio**.
- ⛔ **Mesma mídia** de novo → dedup (não duplica).
- ⛔ **[NOVO] Vídeo grande** (> 50MB) no WhatsApp → *"esse vídeo é grande demais pra eu receber por aqui — sobe pela biblioteca no site."*

---

## 6. Escalar vencedor — SITE (CTA + **[NOVO] ASK inline**)
Pré: conta com um "vencedor" na última análise (aba análise).
1. No card do vencedor (tier campeã) → botão **"Escalar"**.
2. **Passo pequeno** (≤ faixa segura) → abre **rascunho proposto** de raise (revisar → Aprovar).
3. **[NOVO] Passo agressivo** (> faixa) com preferência = *perguntar* → mostra as **2 opções inline**:
   **Subir orçamento +X%** (limite seguro) / **Duplicar (crescer +Y%)** → escolher uma → cria a proposta.
- ✅ Rascunho/ação aparece em **Aprovações / Sugeridas** (mesma verdade dos 2 canais).
- ✅ Preferência = *subir* ou *duplicar* → **não pergunta**, age direto.
```bash
docker exec docker-postgres-1 psql -U postgres -d trafego -c \
"select kind,status,origin,(spec->>'dailyBudgetMinor') as budget from campaign_drafts order by created_at desc limit 3;"
```

---

## 7. Escalar vencedor — WhatsApp (**[NOVO] intent: budget × escala**)
1. **Budget explícito** → "aumenta o orçamento da X em 20%" **ou** "escala em 30%" (com número) → ✅ eco de **raise** (`adjust_budget`), **nunca** duplica.
2. **Intent aberto, passo pequeno** → "escala o vencedor" (scalePct dentro da faixa) → ✅ eco de raise.
3. **[NOVO] Intent aberto, passo agressivo** → "escala o vencedor" (scalePct > faixa) → ✅ o agente **PERGUNTA** em linguagem plana (subir seguro vs cópia separada), **sem criar nada**.
   - Responder "sobe o orçamento" → raise; "pode duplicar" → rascunho de duplicação (eco + confirma).
- ✅ Toda escrita: **eco concreto + espera confirmação**; ambíguo → pergunta.
- ⛔ "não"/"cancela" → descarta a pendência.

---

## 8. **[NOVO] Adset legado (standard_enhancements / 3858504) → falha honesta + 2 saídas**
> Era fast-follow; agora tratado.
1. Escolher um **vencedor antigo** (criativo com "aprimoramentos padrão") → pedir pra **duplicar** (passo agressivo → duplicar) → aprovar.
2. A saga tenta `deep_copy`, a Meta recusa (subcode 3858504).
- ✅ A aprovação vira **bloqueada** com mensagem honesta: *"esse vencedor usa um recurso que a Meta descontinuou para cópia … Posso subir o orçamento dele agora, ou você recria o criativo no Gerenciador que eu duplico."* **Não** é erro seco; **nada** foi criado (sem órfão).
- ✅ No chat, "então sobe o orçamento" → raise (funciona).
- ✅ **Contraste:** duplicar um adset **novo/limpo** funciona (200).

---

## 9. Criar do zero + refino 100% conversacional — WhatsApp
1. "cria uma campanha de vendas reusando o criativo X" → agente propõe defaults (objetivo da meta/conta, Página/Pixel inferidos, orçamento, N variações de **copy IA**) + eco.
2. Refinar conversando: "muda o orçamento pra R$30/dia" · "deixa 3 variações" · "troca o criativo pelo Y" · "regenera as copies mais direto" · "cria pausada".
3. A cada ajuste → **re-ecoa** o rascunho. "sim" → cria (campanha→adset→por variação: criativo+anúncio), **PAUSED**.
- ✅ Objetivo = meta do agente (`conversionGoal`) senão infere; **sempre confirma**.
- ✅ Página/Pixel inferidos e no eco; >1 → pergunta; **sem anúncio** → bloqueia e pede.
- ⛔ goal inválido → não vira objetivo errado. ⛔ `create_campaign` desligado → recusa honesta.

---

## 10. Aprovação de rascunho — site + WhatsApp (**[NOVO] preview + IDs relabelados + picker**)
**Site (Aprovações → Rascunhos de campanha):**
1. ✅ Card mostra estrutura + budget novo + copy + **"Página: conectada"** / **"Rastreamento: pixel conectado"** (**[NOVO]** não os IDs crus).
2. **[NOVO] "Trocar criativo"** (rascunho from_scratch) → abre o **picker** (grade da biblioteca com previews) → escolher → "Criativo trocado neste rascunho".
3. `[Aprovar]` = re-check fresco; barrado → **`blocked`** + motivo.
**WhatsApp:** "aprova o rascunho de escala" → ✅ referência inequívoca aplica; ambíguo → pergunta; o desfecho é **empurrado** na conversa.
- ⛔ **Apply concorrente** (site+WhatsApp na mesma janela) → aplica **1×** (claim atômico); 2ª = "já está sendo aplicado". Não duplica gasto.
- ⛔ Rascunho **expira em 24h** sem resposta.

---

## 11. Proatividade de criação
Pré: `proactiveDrafts` ligado + vencedor OU conta parada (cold_start).
1. Site → **Analisar agora** (ou cron). Aguardar o run.
- ✅ Oportunidade (escalar/refrescar/cold_start) → **rascunho como recomendação** + **nudge** no WhatsApp.
- ✅ Aparece em Aprovações + Timeline (`campaign_draft_proposed`). Throttle: **1 proativo pendente/conta**. **Nunca** auto-aplica.

---

## 12. Guardrails de gasto novo + kill-switch
1. `Orçamento novo máx./dia` baixo (R$5) → pedir criar/escalar com R$50/dia → aprovar.
- ✅ Apply **clampa** pro teto (ou barra se estourar cap de campanhas/dia); desfecho honesto.
- ⛔ **Kill-switch ligado** → toda criação **`blocked`**, mesmo aprovada.
- ✅ Afrouxar autonomia de criação → aplica sem eco, mas o **guardrail continua** de rede.

---

## 13. Undo (reverter criação)
1. WhatsApp: "desfaz a última campanha que você criou".
- ✅ Entidades criadas são **PAUSADAS** (via `createdIds`), **nunca deletadas**; draft → `reverted`; confirma na conversa.

---

## 14. Timeline (Conta → aba Timeline, filtro Campanhas)
- ✅ "Nova campanha proposta" / "Escala de vencedor proposta" (badge "rascunho") com R$ na moeda da conta.
- ✅ "Campanha criada" / "Escala criada" (badge "criada", **[NOVO] tom sucesso/menta**) após aprovar.

---

## 15. **[NOVO] Erro da Meta legível (`error_user_msg`)**
1. Forçar um erro **acionável** da Meta (token sem escopo / conta sem posse / ação recusada).
- ✅ **Site:** a mensagem mostra o texto legível da Meta **+ próximo passo** (kinds acionáveis: invalid_credential/not_accessible/not_duplicable). Transientes (rate-limit) → texto canned.
- ✅ **WhatsApp:** desfecho "A Meta informou: <mensagem legível>." (não "a Meta não respondeu").
- ⛔ **Nunca** vaza a `message` técnica de dev (OAuthException/stack/id/token). Erro sem `error_user_msg` → genérico amigável.

---

## 16. **[NOVO] StoragePort S3-compat (prod)**
Setup (uma vez): MinIO local
```bash
docker run -d -p 9000:9000 -p 9001:9001 -e MINIO_ROOT_USER=minio -e MINIO_ROOT_PASSWORD=miniosecret \
  minio/minio server /data --console-address ":9001"
# console :9001 → criar bucket "creatives"
```
`.env`: `STORAGE_DRIVER=s3`, `STORAGE_ENDPOINT=http://localhost:9000`, `STORAGE_BUCKET=creatives`,
`STORAGE_ACCESS_KEY=minio`, `STORAGE_SECRET_KEY=miniosecret`, `STORAGE_REGION=us-east-1`,
`STORAGE_FORCE_PATH_STYLE=true`. Reiniciar api+worker.
1. Subir uma imagem (§3) → ✅ objeto no bucket MinIO (chave `org/<id>/creatives/<sha>.<ext>`); preview no site funciona (serve via a rota autenticada lendo do S3).
- ⛔ `STORAGE_DRIVER=s3` **sem** bucket/creds → **boot falha** com erro claro (refine).
- ✅ Voltar `STORAGE_DRIVER=local` → tudo no disco, sem mudar código.
- Prod (EasyPanel): MinIO como serviço **com volume persistente** em `/data`; bucket **privado**.

---

## 17. Caminhos tristes consolidados (checklist rápido)
- ⛔ Token inválido → banner + `token_status=invalid`; telas ok.
- ⛔ Conta sem Página/anúncio → criação bloqueada com pedido claro.
- ⛔ goal inválido no chat → não vira objetivo errado.
- ⛔ `create_campaign`/`duplicate_scale` desligado → recusa honesta.
- ⛔ Guardrail estoura / kill-switch → `blocked`/`failed` com motivo; nada criado.
- ⛔ Apply concorrente (chat+site) → aplica 1×.
- ⛔ Imagem/vídeo de desconhecido (DM) → silêncio; sem foco → pede conta; vídeo grande no WhatsApp → manda pro site.
- ⛔ Saga falha no meio → `failed` + motivo; retry retoma por `createdIds`.
- ⛔ Fetch da biblioteca falha → erro com "Tentar de novo" (não empty-state).
- ⛔ **Adset legado (3858504)** → **[AGORA]** bloqueio honesto + 2 saídas (não mais erro genérico).
- ⛔ Upload tipo inválido → 415; grande demais → 413 (PT).
- ⛔ Cross-tenant no blob → 404.

---

## 18. Transparência (invariante 12) — checklist
- [ ] Eco antes de escrita: **o quê / quanto / Página / Pixel / ativa-ou-pausada**.
- [ ] Jargão traduzido (CPA/adset/pixel; "reentrar em aprendizado" → linguagem plana no ASK).
- [ ] Proposta proativa rotulada + porquê. Bloqueio explica limite + saída.
- [ ] Erro Meta = texto legível envelopado + próximo passo (nunca stack/token).
- [ ] Mesmos estados/verdade nos 2 canais (site e WhatsApp).

---

## 19. Limpeza
- Undo pelo chat (§13) pausa o criado; OU no Gerenciador de Anúncios, filtrar pelos nomes de teste e excluir.
- **Rotacionar o token de teste** na Meta.
- Se subiu MinIO: `docker rm -f <minio-container>`; voltar `STORAGE_DRIVER=local`.
```bash
docker exec docker-postgres-1 psql -U postgres -d trafego -c \
"select kind,status,origin from campaign_drafts order by created_at desc limit 10;"
```

---

## 20. E2E automatizado (docker, DB efêmero, não-destrutivo)
Procedimento completo em `docs/validacao-manual-fatia7-fastfollows.e2e.md`. Resumo: cria DB efêmero →
`drizzle-kit migrate` (0000→0038 limpo) → verifica schema → smoke das queries net-new no PG real →
`pnpm test` (suíte completa) → dropa o efêmero. `trafego` (dev) intocado.

### Referência — consultas DB
```bash
docker exec docker-postgres-1 psql -U postgres -d trafego -c "select id,kind,status,origin,created_at from campaign_drafts order by created_at desc limit 10;"
docker exec docker-postgres-1 psql -U postgres -d trafego -c "select id,status,(draft_id is not null) as eh_rascunho,action_type from approvals order by created_at desc limit 10;"
docker exec docker-postgres-1 psql -U postgres -d trafego -c "select origin,format,status from creative_assets order by created_at desc limit 10;"
docker exec docker-postgres-1 psql -U postgres -d trafego -c "select tool_key,idempotency_key,risk from agent_tool_calls order by created_at desc limit 10;"
```

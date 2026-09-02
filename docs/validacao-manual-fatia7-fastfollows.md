# Validação manual — Fatia 7: os 6 fast-follows

Roteiro prático, passo a passo, pros 6 fast-follows da Fatia 7. Cobre **caminho feliz** e
**caminhos tristes** (estressando erros). Cada item diz o que fazer, o que observar e o que
**não** pode acontecer.

> Ordem dos pontos: **#5** surfaçar erro Meta · **#6** escalar vencedor (intent + adset legado) ·
> **#1** servir blob/preview · **#2** storage S3-compat · **#3** vídeo (upload + WhatsApp) ·
> **#4** transcrição (desenho, adiado — nada a testar).

---

## 0. Pré-requisitos

- `pnpm install` feito; `.env` preenchido (Meta System User token válido de conta de **teste**,
  OpenRouter key, Evolution conectada por QR — para os testes de WhatsApp).
- Subir o stack: `pnpm dev` (api + worker + web). Postgres/Redis via docker local (`docker ps`
  deve mostrar `docker-postgres-1` e `docker-redis-1`).
- **Segurança:** todo teste de escrita na Meta usa **conta de teste** e as entidades criadas devem
  nascer **pausadas** ou ser revertidas/apagadas ao fim. Nunca rode contra conta de produção.
- Uma conta Meta conectada + pelo menos 1 run de análise concluído (para haver "vencedor" e campanhas).

---

## #5 — Surfaçar `error_user_msg` da Meta (erro legível)

**O que mudou:** erros da Meta que têm mensagem pro usuário final (`error_user_msg`) agora aparecem
**envelopados** ("A Meta informou: …" no chat; prefixados no HTTP) em vez do genérico "a Meta não
respondeu"/"Invalid parameter". Nunca vaza a mensagem técnica de dev.

### Feliz (mensagem legível aparece)
1. Force um erro acionável da Meta. O jeito mais fácil: no onboarding, cole um token **sem o escopo
   necessário** ou de uma conta sem posse do recurso, ou tente uma ação numa conta cujo token perdeu
   acesso. (Alternativa determinística: no `packages/ads-meta`, um teste já cobre — ver
   `client.test.ts` "error_user_msg".)
2. **Site:** a resposta de erro deve mostrar o texto legível da Meta **+ o próximo passo** (ex.: "…
   Verifique e cole de novo"). Kinds acionáveis (`invalid_credential`, `not_accessible`,
   `not_duplicable`) preferem o `error_user_msg`; transientes (rate-limit/indisponível) seguem no
   texto canned.
3. **WhatsApp:** peça uma ação que a Meta recuse → a mensagem de desfecho deve ler "A Meta informou:
   <mensagem legível>." (não "a Meta não respondeu").

### Triste (nunca vaza jargão nem token)
- Um erro **transiente** (rate-limit) → deve mostrar o texto canned amigável, não o cru.
- **Nunca** deve aparecer a `message` de dev (ex.: "OAuthException", stack, ou qualquer id/token).
- Erro **sem** `error_user_msg` → cai no genérico amigável (não em branco nem "undefined").

---

## #6 — Escalar vencedor: intent (raise/ASK) + adset legado

**O que mudou:** "escalar" agora distingue **budget explícito** (sempre sobe o orçamento) de **intent
aberto** (passo agressivo → **PERGUNTA** subir-vs-duplicar). E duplicar um vencedor legado (criativo
com "aprimoramentos padrão" descontinuados) **falha honesto** com 2 saídas, em vez de erro seco.

### 6.1 Budget explícito → sempre raise (nunca duplica)
1. **WhatsApp:** "aumenta o orçamento da <campanha> em 20%" (ou "escala em 30%"). O agente deve ecoar
   um ajuste de **orçamento** (`adjust_budget`) e pedir confirmação. **Não** deve propor duplicação.
2. Confirme → aplica o raise. Verifique no site/timeline.

### 6.2 Intent aberto, passo pequeno → sobe direto
1. **WhatsApp:** "escala o vencedor" (sem número), com `scalePct` configurado **dentro** da faixa
   segura (`maxBudgetChangePct`). O agente ecoa raise e pede OK.

### 6.3 Intent aberto, passo agressivo → PERGUNTA (subir vs duplicar)
1. Configure `scalePct` **acima** de `maxBudgetChangePct` (Agente → Segurança/Limites).
2. **WhatsApp:** "escala o vencedor". O agente **pergunta** em linguagem plana: subir o orçamento no
   limite seguro **ou** criar uma cópia separada. **Não** deve criar nada ainda.
3. Responda "sobe o orçamento" → vira um raise (eco + confirma). OU "pode duplicar" → vira rascunho de
   duplicação (card no site + aprovação).
4. **Site:** na campanha vencedora (aba análise), clique **"Escalar"**. Se o passo for agressivo, o
   card mostra as **2 opções inline** (Subir orçamento +X% / Duplicar +Y%). Escolha uma → cria a
   proposta (aparece em Aprovações/Sugeridas). Mesma redação/estados do chat.

### 6.4 Preferência lembrada (tira a fricção)
1. **Site:** Agente → "Até onde o agente pode ir" → "Escalar um vencedor além do limite seguro":
   escolha **perguntar** (default) / **subir orçamento** / **duplicar**. Salve.
2. Com "subir orçamento" ou "duplicar", o passo agressivo **não pergunta mais** — age direto conforme
   a preferência.

### 6.5 Adset legado (3858504) → falha honesta + 2 saídas
1. Escolha um **vencedor antigo** cujo criativo use "aprimoramentos padrão" (adsets legados; comum em
   contas com histórico). Peça pra **duplicar** (passo agressivo → escolha duplicar).
2. Aprove a duplicação. A saga tenta o `deep_copy` e a Meta recusa (subcode 3858504).
3. **Esperado:** a aprovação vira **bloqueada** com a mensagem honesta: "esse vencedor usa um recurso
   que a Meta descontinuou para cópia … Posso subir o orçamento dele agora, ou você recria o criativo
   no Gerenciador que eu duplico." **Não** deve ser "não consegui" seco, nem criar nada (sem órfão).
4. No chat, responda "então sobe o orçamento" → vira raise (funciona).

### Triste
- Duplicar um adset **novo/limpo** (criativo sem aprimoramentos) deve funcionar (200) — contraste.
- Passo agressivo com preferência = "duplicar" **não** deve perguntar.
- Budget explícito **nunca** deve cair no fluxo de duplicação.

---

## #1 — Servir blob de criativo + preview (biblioteca / card / picker)

**O que mudou:** o binário do criativo agora é servível por rota autenticada; a biblioteca e o picker
mostram **preview**; o card de aprovação relabela `pageId`/`pixelId` crus.

### Feliz
1. **Biblioteca:** conta → aba **Criativos** → "Subir criativo" → escolha uma **imagem**. Deve aparecer
   com **preview** (miniatura), origem "Enviado", status "pronto".
2. A miniatura carrega via `GET /api/accounts/:id/creatives/:assetId/blob` (rota autenticada). Recarregue
   a página — a imagem vem do cache forte (`Cache-Control: private, immutable`; 304 no revalidate).
3. **Card de aprovação de rascunho** (Aprovações): um rascunho `from_scratch` mostra **"Página: conectada"**
   e **"Rastreamento: pixel conectado"** — **não** os IDs crus da Meta.
4. **Picker "trocar criativo":** no card de rascunho `from_scratch`, clique **"Trocar criativo"** → abre a
   grade da biblioteca (com previews) → escolha um asset → "Criativo trocado neste rascunho".

### Triste (segurança + estados)
- **Cross-tenant:** um `assetId` de **outra org/conta** na URL do blob deve dar **404** (nunca servir o
  binário de outra conta). A rota nunca confia num `ref` do cliente — faz lookup por `assetId` org-scoped.
- Asset com blob ausente → placeholder "sem preview" (nunca ícone quebrado — há `onerror`).
- Vídeo na biblioteca → placeholder "vídeo" (preview de vídeo = fast-follow).
- Upload que falha → toast de erro amigável (o quê + o que fazer), não erro técnico.

---

## #2 — StoragePort S3-compat em produção

**O que mudou:** o blob pode ser guardado num bucket S3-compat (MinIO/R2/B2/AWS) via `STORAGE_DRIVER=s3`,
sem tocar no core. Local-fs segue default em dev.

### Setup (uma vez)
1. Suba um MinIO local (ou use R2/B2): `docker run -p 9000:9000 -p 9001:9001 -e MINIO_ROOT_USER=minio
   -e MINIO_ROOT_PASSWORD=miniosecret minio/minio server /data --console-address ":9001"`. Crie um
   bucket `creatives` no console (`:9001`).
2. `.env`: `STORAGE_DRIVER=s3`, `STORAGE_ENDPOINT=http://localhost:9000`, `STORAGE_BUCKET=creatives`,
   `STORAGE_ACCESS_KEY=minio`, `STORAGE_SECRET_KEY=miniosecret`, `STORAGE_REGION=us-east-1`,
   `STORAGE_FORCE_PATH_STYLE=true`. Reinicie api+worker.

### Feliz
1. Suba uma imagem pela biblioteca (como no #1). O blob vai pro bucket MinIO (veja o objeto no console
   MinIO, chave `org/<id>/creatives/<sha>.<ext>`). O preview no site continua funcionando (serve via a
   rota autenticada, que lê do S3).
2. Suba **o mesmo arquivo** de novo → dedup content-addressed (mesma chave; não duplica o asset).

### Triste (fail-fast + isolamento)
- `STORAGE_DRIVER=s3` **sem** `STORAGE_BUCKET`/creds → o boot **falha com erro claro** (zod refine).
- Volte pra `STORAGE_DRIVER=local` → tudo volta ao disco, sem mudar código (só env).
- Deploy prod: MinIO como serviço no EasyPanel **com volume persistente** em `/data` (senão o disco
  do container some no deploy — é o motivo de existir o S3). Bucket **privado** (serving é só pela rota).

---

## #3 — Vídeo (upload web unificado + intake no WhatsApp)

**O que mudou:** upload web unificado em **multipart** (imagem + vídeo; dropou base64); vídeo processa
**async** (pending → poll → ready/error); vídeo também entra pelo **WhatsApp**.

### 3.1 Upload de vídeo pela web
1. Biblioteca → "Subir criativo" → escolha um **MP4** (< limite; default 200MB). Toast: "Vídeo enviado
   — estou processando…". O card aparece com status **"processando…"**.
2. Aguarde: sem recarregar a página, o card deve virar **"pronto"** quando a Meta terminar (a biblioteca
   faz poll enquanto há `pending`). Se a Meta falhar/estourar o tempo (~16min), vira **"erro"** com texto.

### 3.2 Upload de imagem (regressão da unificação)
1. Suba uma imagem → continua funcionando (mesmo endpoint multipart, vem "pronto" na hora).

### 3.3 Vídeo pelo WhatsApp
1. Mande um **vídeo** (curto, < cap WhatsApp; default 50MB) pro número, com a conta em foco.
2. Resposta de cortesia: "vídeo recebido … tô processando; fica pronto em instantes." O asset aparece na
   biblioteca (processando → pronto).

### Triste
- **Tipo inválido** (ex.: PDF/zip) → **415** amigável ("Formato não suportado. Envie imagem … ou vídeo …").
- **Grande demais:** imagem > `CREATIVE_MAX_IMAGE_MB` (15MB) ou vídeo > `CREATIVE_MAX_VIDEO_MB` (200MB) →
  **413** PT ("Arquivo grande demais. Limite: XMB para …").
- **Vídeo grande no WhatsApp** (> `CREATIVE_MAX_WHATSAPP_VIDEO_MB`, 50MB) → o agente responde "esse vídeo
  é grande demais pra eu receber por aqui — sobe pela biblioteca no site."
- Vídeo sem conta em foco (org multi-conta) no WhatsApp → o agente pergunta de qual conta é.
- **Payload da fila:** confirme (log/Redis) que o vídeo do WhatsApp **não** trafega bytes no payload
  (só `messageKey`) — o worker busca os bytes.

---

## #4 — Transcrição de criativo (STT) — DESENHO, adiado

Nada a testar: só desenho no ROADMAP (extrair áudio com `ffmpeg-static` → `TranscriptionPort`). Será
implementado depois que o intake de vídeo (#3) rodar em beta.

---

## E2E automatizado (docker local, DB efêmero, não-destrutivo)

Ver `docs/validacao-manual-fatia7-fastfollows.e2e.md` (procedimento + script). Em resumo:
1. Cria um DB **efêmero** (`trafego_e2e_*`) no postgres do docker — **nunca** toca o banco `trafego`.
2. Aplica todas as migrations (`pnpm db:migrate`) → prova que o schema (incl. `creative_assets`,
   `campaign_drafts`, migração 0038) sobe limpo.
3. Roda a suíte completa (`pnpm test`) — 1000+ testes cobrindo core/adapters/saga/ingest/poll/dedup/
   escala/erro (externos mockados).
4. Dropa o DB efêmero.

Meta/OpenRouter reais: use `apps/worker/e2e-real-fatia7.ts` (sessão anterior) contra **conta de teste**,
tudo PAUSED/revertido.

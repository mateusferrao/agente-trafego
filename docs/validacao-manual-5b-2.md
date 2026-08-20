# Validação manual 5b — corte 2 (operar pelo WhatsApp)

Percurso de ~30 min: **conversar pelo WhatsApp** → consultar dados reais → "analisa agora"
com resultado de volta → **aprovar/rejeitar pendentes na conversa** → debounce. Comandos
copy-paste (**PowerShell**, Windows). O `pnpm` só funciona em **terminal novo**.

Rodar SQL: **`pnpm db:q "<SQL>"`** (carrega o `.env` sozinho).

> **Duas formas de exercitar o inbound:**
> - **(A) POST simulado** (local, recomendado): você posta o payload da Evolution direto na
>   API — não precisa a Evolution alcançar sua máquina. O **outbound (resposta) é REAL**:
>   chega no WhatsApp do contato verificado (via Evolution). Ótimo p/ testar tudo local.
> - **(B) Mensagem real**: você manda WhatsApp pro número da org. Exige a Evolution
>   **alcançar a `API_ORIGIN`** (em prod = domínio público; local = túnel tipo ngrok/cloudflared,
>   com `API_ORIGIN` apontando pro túnel e **reconectar** a instância p/ registrar o webhook).

---

## 0. Setup (1x)

```powershell
pnpm db:migrate
pnpm db:seed
pnpm dev           # api + worker + web
```
- No log do worker, confirmar a linha: `worker up: ... + whatsapp-inbound` **e** o worker de
  flush ativo (`whatsapp-flush`).
- `.env` tem `API_ORIGIN`, `CONVERSATION_MODEL`, `CONVERSATION_HISTORY_TURNS`,
  `CONVERSATION_MAX_TOKENS`, `CONVERSATION_DEBOUNCE_SECONDS` (default 5s).
- **Pré-requisitos WhatsApp** (feitos nas fatias 3b/5b-1):
  - Instância Evolution **conectada** (Integrações → QR).
  - **Contato verificado** (opt-in por código). Confirmar:
    ```powershell
    pnpm db:q "select phone, verified from contacts where verified = true;"
    ```
  - Conta Meta com **1 campanha ativa** (p/ as consultas e o 'analisa agora' terem dado).

### 0.1 Registrar o webhook na Evolution (uma vez)
O `connect` registra o webhook (`webhook/set`) com o secret **por-instância**. Se a instância
já estava conectada de antes, **reconecte uma vez** (Integrações → reconectar) p/ registrar.
- Pegar o nome da instância + secret (usados no POST simulado):
  ```powershell
  pnpm db:q "select evolution_instance, webhook_secret, status from channel_instances;"
  ```

### 0.2 Helper de POST simulado (cole no PowerShell)
```powershell
function Send-WA($text, $id) {
  $inst   = "COLE_evolution_instance_AQUI"     # ex: org-<uuid>
  $secret = "COLE_webhook_secret_AQUI"
  $phone  = "5511999999999"                    # DDI+numero do contato verificado (só dígitos)
  $body = @{
    event = "MESSAGES_UPSERT"; instance = $inst
    data = @{
      key = @{ remoteJid = "$phone@s.whatsapp.net"; fromMe = $false; id = $id }
      pushName = "Teste"; messageType = "conversation"
      message = @{ conversation = $text }
    }
  } | ConvertTo-Json -Depth 8
  Invoke-RestMethod -Method Post -ContentType "application/json" `
    -Uri "http://localhost:3333/webhooks/evolution/$inst" `
    -Headers @{ "x-webhook-secret" = $secret } -Body $body
}
```
> Cada mensagem precisa de um **`id` novo** (idempotência dedupa por `messageId`).
> A resposta chega no WhatsApp do contato após ~**5s** (janela de debounce).

---

## 1. Segurança do webhook (5b-2.1)

- **Secret válido → 200 `{accepted:true}`:**
  ```powershell
  Send-WA "oi" "MSG-1"
  ```
  ✅ retorna `accepted: true`. Depois de ~5s, chega uma resposta no WhatsApp do contato
  (o agente se apresenta / responde).
- **Secret inválido → 401:** troque o header e confirme que dá erro (não vaza se a instância existe):
  ```powershell
  Invoke-RestMethod -Method Post -Uri "http://localhost:3333/webhooks/evolution/org-x" `
    -Headers @{ "x-webhook-secret" = "errado" } -ContentType "application/json" -Body '{}' 
  ```
  ✅ **401** (Unauthorized).
- **Remetente desconhecido → silêncio:** troque `$phone` no helper por um número **não**
  verificado e envie. ✅ retorna 200, mas **nada** é respondido e **nada** é gravado:
  ```powershell
  pnpm db:q "select direction, left(body,40) from messages order by created_at desc limit 3;"
  ```

---

## 2. Chat de leitura (5b-2.2) — dados reais do nosso DB

Envie cada um e confira a resposta no WhatsApp (após ~5s):

- **Status:** `Send-WA "como tá a conta?" "MSG-2"`
  ✅ resumo do último run (nota/headline + gasto + nº de pendentes). Se nunca rodou análise,
  responde honestamente que ainda não tem análise.
- **Gasto por período:** `Send-WA "quanto gastei essa semana?" "MSG-3"`
  ✅ gasto agregado dos últimos 7 dias **com o frescor** ("dados até DD/MM").
- **Campanha:** `Send-WA "como tá a campanha <NOME>?" "MSG-4"`
  ✅ resumo/gargalo/flags da campanha (se existir análise dela); nome inexistente → diz que não achou.
- **Recomendações / pendentes:** `Send-WA "o que você me recomendou?" "MSG-5"`
- **Fora de escopo (não alucina):** `Send-WA "cria uma campanha nova pra mim" "MSG-6"`
  ✅ recusa com clareza (não faz criação por aqui; aponta o site) — **não** finge que fez.
- **Métrica que não temos:** `Send-WA "qual o CTR do meu concorrente?" "MSG-7"`
  ✅ diz que não tem acesso a esse dado.
- **Custo metrado (billing §11):** confirmar que as chamadas do chat entram no ledger:
  ```powershell
  pnpm db:q "select type, model, input_tokens, output_tokens, cost_usd from usage_events where type='conversation' order by created_at desc limit 5;"
  ```

### 2.1 "Analisa agora" com push de volta
```powershell
Send-WA "roda uma análise agora" "MSG-8"
```
- ✅ resposta imediata (~5s): "beleza, rodando — já te aviso" (ack com ETA).
- ✅ Em ~1 min, chega **uma segunda mensagem** com o resultado (resumo + recomendações), **ou**
  "analisei, nada crítico" se não houver o que mexer.
- Confirmar o run de origem conversa:
  ```powershell
  pnpm db:q "select trigger, status from agent_runs order by created_at desc limit 3;"   # trigger = conversation
  ```
- **Colisão com run em andamento:** mande "analisa agora" 2x seguidas → a 2ª responde
  "já tem uma análise rodando" (guard de in-flight).

---

## 3. Aprovação conversacional (5b-2.3)

Pré: ter **pendentes** (rode uma análise em autonomia "sugere + OK" com uma regra que dispara —
ver `validacao-manual-5b.md` §1). Confirmar:
```powershell
pnpm db:q "select id, action_type, entity_id, status from approvals where status='pending' order by created_at desc;"
```

- **Ver pendentes:** `Send-WA "o que tá esperando minha aprovação?" "MSG-9"`
  ✅ lista numerada das pendentes (tipo + alvo + motivo).
- **Aprovar (referência clara aplica direto):** `Send-WA "aprova a 1" "MSG-10"`
  ✅ responde "tô aplicando…" e, em seguida, **empurra o desfecho** ("✅ Apliquei (…)" ou
  "Não apliquei: <motivo>" se o re-check barrar). A campanha muda de estado na Meta.
  ```powershell
  pnpm db:q "select status, resolved_reason from approvals order by created_at desc limit 3;"   # approved / blocked
  ```
- **Ambíguo → pergunta (nunca aplica no escuro):** com ≥2 pendentes,
  `Send-WA "pode aprovar aquela lá" "MSG-11"` → ✅ o agente **pergunta qual** (não aplica).
- **Rejeitar:** `Send-WA "rejeita a última" "MSG-12"` → ✅ resolve como `rejected`, nada na Meta.
- **Escrita livre NÃO existe aqui (é 5c):** `Send-WA "pausa a campanha X agora" "MSG-13"`
  ✅ o agente diz que por aqui só resolve o que já está pendente / aponta o site — **não** pausa do zero.

---

## 4. Debounce (5b-2.4) — mensagens picadas viram 1 turno

Envie **3 fragmentos em < 5s** (rápido, um atrás do outro):
```powershell
Send-WA "oi" "MSG-14a"; Send-WA "como tá" "MSG-14b"; Send-WA "a conta?" "MSG-14c"
```
- ✅ chega **UMA** resposta só (coalesceu os 3 num turno), não três.
- Confirmar que os 3 inbound foram gravados, mas o turno foi um só:
  ```powershell
  pnpm db:q "select direction, left(body,30), created_at from messages order by created_at desc limit 8;"
  ```

---

## 5. Status ao vivo (CONNECTION_UPDATE)

```powershell
$inst = "COLE_evolution_instance_AQUI"; $secret = "COLE_webhook_secret_AQUI"
$b = @{ event="CONNECTION_UPDATE"; instance=$inst; data=@{ state="close" } } | ConvertTo-Json -Depth 6
Invoke-RestMethod -Method Post -Uri "http://localhost:3333/webhooks/evolution/$inst" -Headers @{ "x-webhook-secret"=$secret } -ContentType "application/json" -Body $b
pnpm db:q "select evolution_instance, status from channel_instances;"   # status = disconnected
```
✅ o `status` do canal reflete o evento (reconecte depois p/ voltar a `connected`).

---

## 6. Ajustes do review (verificação rápida)

- **Thread estável:** todas as respostas da mesma conversa mantêm contexto (ex: pergunte
  "e a outra?" após listar campanhas) — o `thread_id` do checkpointer é determinístico.
- **Falha da Meta não deixa no vácuo:** (difícil forçar) se a Meta falhar ao aplicar uma
  aprovação, a `approval` fica **pending** e chega um aviso no WhatsApp ("não consegui aplicar
  agora…"), em vez de silêncio.
- **Fragmento durante o turno:** mande uma msg, e **durante** o ~1 min do "analisa agora"
  mande outra — ela é respondida depois (não fica represada).

---

## 7. Regressão (nada quebrou)

- **Cron/site intactos:** "Analisar agora" **pelo site** continua mostrando o resultado no
  site (sem push no zap); o push do **cron** continua enxuto (1 msg) e agora diz "responda por
  aqui pra aprovar/rejeitar, ou veja no site".
- **HITL pelo site** (aprovar/reverter em `/aprovações` e na mini-surface) segue funcionando.
- Verde: `pnpm typecheck` + `pnpm test`.

---

## SQL de apoio

```powershell
pnpm db:q "select evolution_instance, webhook_secret, status from channel_instances;"
pnpm db:q "select phone, verified from contacts;"
pnpm db:q "select direction, left(body,50), meta->>'messageId' m, created_at from messages order by created_at desc limit 12;"
pnpm db:q "select id, status, action_type, entity_id, resolved_reason from approvals order by created_at desc limit 8;"
pnpm db:q "select trigger, status, created_at from agent_runs order by created_at desc limit 5;"
pnpm db:q "select type, model, cost_usd from usage_events where type='conversation' order by created_at desc limit 5;"
```

> **Escopo do 5b-2:** conversa livre p/ **consultar + analisar + aprovar/rejeitar**. Escrita
> LIVRE do zero pelo chat ("pausa a X" sem pendente) = **5c**. Multi-conta: 1 agente → voz da
> conta; N contas → concierge (mostra/aprova pendentes de todas; consultas por-conta no site).

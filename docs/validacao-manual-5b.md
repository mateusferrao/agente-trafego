# Validação manual 5b — corte 1 (aprovação via SITE)

Percurso de ~20 min: **sugere → aprovar no site → aplica → reverter**, + os 3 gaps de
guardrail (no-op / allowedActions / barradas visíveis) + **revert endurecido** (drift + TTL)
+ expiração 24h. Comandos copy-paste (**PowerShell**, Windows). Use **1 campanha de teste**
(budget baixo). O `pnpm` só funciona em **terminal novo** (o PATH foi atualizado).

Rodar SQL: **`pnpm db:q "<SQL>"`** (carrega o `.env` sozinho — sem psql).
```powershell
pnpm db:q "select status,action_type,entity_id,expires_at from approvals order by created_at desc limit 5;"
```

---

## 0. Setup (1x)

```powershell
pnpm db:migrate    # tem que chegar na 0014 (approvals granular + drop payload_actions)
pnpm db:seed       # catálogo de tools
pnpm dev           # api + worker + web
```
- No log do worker, confirmar: `worker up: ... + action-undo + approval-apply + approval-expiry`.
- Web em **http://localhost:4200** (seu navegador, já logado). Anotar o id da rota `/accounts/<id>`.
- Conta Meta com **1 campanha ativa, budget diário, gasto > 0**.

## 1. Regra que dispara sempre + autonomia "sugere"

Em `/accounts/<id>/agente`:
- **Autonomia** (Análise e Regras) = **sugere + OK** → tudo vira sugestão (nada auto-aplica).
- **Guardrails:** dry-run **OFF**; ações permitidas inclui **pausar**.
- **Regras** → adicionar: *pausar campanhas quando gasto maior que `0.01`* → Salvar.

Garante ≥1 ação de origem `playbook` em toda análise (não depende do LLM).

---

## 2. Percurso principal (aprovação pelo site)

### 2a. A sugestão vira aprovação pendente
- **Analisar agora** no detalhe da conta.
- ✅ Campanha **continua ativa** na Meta (nada aplicado sem OK).
- ✅ Mini-surface → seção **"Sugeridas — precisam do seu OK"**: a ação com **prazo**
  (`⏳ expira em ~24h`) + botões **Aprovar** / **Rejeitar**.
- Verificar (fonte da verdade = tabela `approvals`, granular):
```powershell
pnpm db:q "select status,action_type,entity_level,entity_id,expires_at from approvals where status='pending' order by created_at desc;"
```

### 2b. Aprovar → aplica de verdade (re-check fresco)
- Clicar **Aprovar** → toast "enviado para aplicação".
- ✅ Em segundos a campanha vira **PAUSED** na Meta.
- ✅ A ação **migra** para "O que o agente fez neste run" com **Reverter**; some das Sugeridas.
- Verificar:
```powershell
pnpm db:q "select status,resolved_reason from approvals order by created_at desc limit 3;"          # approved
pnpm db:q "select tool_key,idempotency_key from agent_tool_calls order by created_at desc limit 3;"  # key termina em :apply
pnpm db:q "select action,before->>'status' b,after->>'status' a from audit_log where action like 'meta.%' order by created_at desc limit 1;"  # b=ACTIVE a=PAUSED
```

### 2c. Rejeitar não aplica nada
- Gere outra sugestão (ex: retome a campanha na Meta e rode de novo, OU baixe o limiar
  da regra) e clique **Rejeitar**.
- ✅ Nada muda na Meta; a linha some.
```powershell
pnpm db:q "select status,resolved_reason from approvals where status='rejected' order by created_at desc limit 3;"
```

### 2d. Caixa de entrada cross-conta
- Abrir **`/approvals`** (menu) → lista as pendentes **agrupadas por conta**, com prazo e
  os mesmos botões Aprovar/Rejeitar. Aprovar aqui = mesmo efeito da mini-surface.

---

## 3. Os 3 gaps de guardrail (pré-requisito do corte 1)

### 3a. No-op — não pede OK pra pausar o que já está pausado
- Com a campanha **já PAUSED** (do passo 2b) + a regra "pausar" ativa → **Analisar agora**.
- ✅ A ação **NÃO** aparece em Sugeridas; aparece em **"Barradas pelos seus limites"** com
  motivo *"entidade já está neste estado"*.
```powershell
pnpm db:q "select jsonb_array_length(coalesce(metrics_snapshot->'droppedActions','[]')) barradas from agent_runs order by created_at desc limit 1;"  # >= 1
pnpm db:q "select metrics_snapshot->'droppedActions' from agent_runs order by created_at desc limit 1;"
```

### 3b. allowedActions vale nas sugeridas
- Em Guardrails: **tirar** "ajustar orçamento" das ações permitidas → Salvar.
- Adicionar regra de budget (ex: *ajustar orçamento -20% quando gasto maior que 0.01*, escopo
  **conjunto**) → Salvar → **Analisar agora**.
- ✅ A ação de budget aparece em **"Barradas"** (*"ação adjust_budget não permitida"*),
  **nunca** em Sugeridas (antes escapava como "precisa do seu OK").

### 3c. Barradas visíveis
- Já coberto em 3a/3b: toda ação derrubada pelo guardrail (auto-aplicada **ou** sugerida)
  aparece na seção **"Barradas"** com o motivo — antes só ia pro log.

---

## 4. Revert endurecido (5b-1.5)

### 4a. Drift — reverter avisa se a entidade mudou
- Aplique uma pausa (passo 2b). Depois, **na Meta (Ads Manager)**, **retome** a campanha
  manualmente (volta a ACTIVE).
- Na mini-surface, clique **Reverter**.
- ✅ O re-check detecta drift: a ação passa a mostrar *"↩️ não revertida — a entidade mudou
  desde a ação…"* + botão **"Reverter mesmo assim"**.
- ✅ Clicar **"Reverter mesmo assim"** → confirma o aviso → reverte com `force`.
```powershell
pnpm db:q "select tool_key,result->>'reason' motivo from agent_tool_calls where tool_key='undo_blocked' order by created_at desc limit 3;"  # registro do bloqueio
pnpm db:q "select tool_key from agent_tool_calls where tool_key='undo' order by created_at desc limit 1;"                                    # após o force
```

### 4b. TTL — reverter expira por tempo
- Pegue o `toolCallId` de uma ação aplicada e **envelheça** o registro além do TTL (default 7d):
```powershell
pnpm db:q "select id from agent_tool_calls where tool_key<>'undo' and tool_key<>'undo_blocked' order by created_at desc limit 1;"
pnpm db:q "update agent_tool_calls set created_at = now() - interval '10 days' where id='<toolCallId>';"
```
- Recarregue o detalhe da conta → ✅ o botão **Reverter some** (fora do prazo). A API também
  recusa (`400 "O prazo para reverter esta ação expirou."`).

---

## 5. Expiração de aprovações (24h)

Sem esperar 24h: **envelheça** uma pendente e deixe o job varrer (roda a cada 15 min; pra
acelerar, ponha `APPROVAL_EXPIRY_CRON=* * * * *` no `.env` e reinicie o `pnpm dev`).
```powershell
pnpm db:q "update approvals set expires_at = now() - interval '1 hour' where status='pending';"
# aguardar 1 tick do job approval-expiry, então:
pnpm db:q "select status,count(*) from approvals group by 1;"   # as vencidas viram 'expired'
```
- ✅ Pendentes vencidas viram `expired` e somem da mini-surface / `/approvals`.

---

## 6. Smoke read-only (regressão)
Autonomia = **sugere + OK** → **Analisar agora** → análise + recomendações + funil/scorecard
iguais aos de antes; **zero** escrita sem aprovação. Beta read-only intacto.

---

## Se algo falhar
- **Sugestão não vira pendente:** confira autonomia = `sugere + OK`, a regra dispara (limiar),
  e a ação está em `allowed_actions` (senão vai pra "Barradas", correto).
- **Aprovar não aplica:** ver log do worker (`approval-apply`), `resolved_reason` da approval
  (`blocked` = re-check barrou; motivo na coluna), e dry-run OFF + kill-switch off.
- **Rate-limit da Meta (code 17):** cliques seguidos esgotam o orçamento de request; o cache do
  catálogo (`MetaEntityCache`) mitiga. Espere o cooldown e rode 1× (ver `validacao-manual-5a.md`).
- **`pnpm` não reconhecido:** abra um **terminal novo** (o PATH foi atualizado nesta máquina).

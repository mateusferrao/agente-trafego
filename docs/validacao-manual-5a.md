# Validação manual 5a — guia prático

Percurso direto de ~15 min: **dry-run → escrita real → undo**, + 6 checks rápidos de guardrail/segurança.
Comandos copy-paste (**PowerShell** — ambiente Windows). Use **1 campanha de teste** (budget baixo).

Rodar SQL: **`pnpm db:q "<SQL>"`** (runner via `pg`, carrega o `.env` sozinho — **não precisa de psql**).
```powershell
pnpm db:q "select id,status,partial from agent_runs order by created_at desc limit 1;"
```
> Prefere GUI? DBeaver/pgAdmin/TablePlus com o `DATABASE_URL` do `.env` — as queries abaixo são as mesmas.

---

## 0. Setup (1x)

```powershell
pnpm db:migrate    # tem que chegar na 0012 (unique index guardrail)
pnpm db:seed       # semeia catálogo de tools → "seed ok: ... · 4 tools"
pnpm dev           # api + worker + web
```
- Confirmar no log do worker: `...+ schedule-resync + action-undo`.
- Web em **http://localhost:4200**. Se o `web` aparecer como **Failed** no `pnpm dev`, é a **porta 4200 ocupada** por um processo antigo — mate-o (`Get-Process node | Stop-Process`) e rode de novo, ou suba isolado: `pnpm --filter web dev`.
- Conectar 1 conta Meta com **1 campanha ativa, budget diário, gasto > 0**. Anotar o id da rota `/accounts/<id>`.

## 1. Regra que dispara sempre (dá controle determinístico)

Em `/accounts/<id>/agente` → seção **Regras** → adicionar:
> pausar **campanhas** quando **gasto** **maior que** `0.01`  → Salvar.

Isso garante 1 ação de origem `playbook` em toda análise (não depende do LLM).

---

## 2. Percurso principal

### 2a. Dry-run não escreve (default)
Config do agente: Autonomia "Análise/Regras" = **age no seguro**; Guardrails: **dry-run LIGADO**, ações permitidas inclui **pausar**. Salvar.
- Clicar **Analisar agora** no detalhe da conta.
- ✅ Campanha **continua ativa** no Ads Manager.
- ✅ Mini-surface: ação com selo **"simulado (dry-run)"** (sem botão reverter).
- Verificar:
```powershell
pnpm db:q "select tool_key, args->>'dryRun' dry from agent_tool_calls where run_id=(select id from agent_runs order by created_at desc limit 1);"   # dry = true
pnpm db:q "select count(*) from usage_events where type='action_applied' and created_at > now()-interval '5 min';"                                   # 0 (dry-run não fatura)
```

### 2b. Escrita real
Guardrails: **dry-run DESLIGADO**. Salvar. Campanha **ativa**. **Analisar agora**.
- ✅ Campanha vira **PAUSED** no Ads Manager.
- Verificar (a query de "ações da última run" acima): `dry=false`, `b=ACTIVE`, `a=PAUSED`.
```powershell
pnpm db:q "select action,target,before->>'status' b,after->>'status' a from audit_log where action like 'meta.%' order by created_at desc limit 1;"
pnpm db:q "select idempotency_key from agent_tool_calls order by created_at desc limit 1;"   # formato runId:pause_entity:campaign:<id>
```

### 2c. Undo
Na mini-surface, clicar **Reverter** → confirmar o aviso.
- ✅ Toast "Revertendo…"; em segundos a campanha volta a **ACTIVE**.
- Verificar:
```powershell
pnpm db:q "select tool_key, idempotency_key from agent_tool_calls order by created_at desc limit 1;"   # tool_key=undo, key ...:undo
```

---

## 3. Checks rápidos (marque o que der)

- [ ] **Só sugere (não escreve):** Autonomia = **sugere + OK** → Analisar agora → nada muda na Meta; mini-surface mostra em **"Sugeridas — precisam do seu OK"**.
  `pnpm db:q "select metrics_snapshot->'suggestedActions' from agent_runs order by created_at desc limit 1;"` → não-vazio.
- [ ] **Kill-switch:** ligar trava total + autonomia "age sozinho" → Analisar agora → **nada** aplicado.
- [ ] **Tipo não permitido:** tirar "ajustar orçamento" das ações permitidas + uma regra de budget → a ação de budget é **dropada** (log `guardrail:ações barradas`).
- [ ] **Cortar budget (act_safe):** regra "ajustar orçamento −20%" + permitir adjust_budget + dry-run OFF → budget cai 20% (`10000→8000`). Aumentar (+%) **não** auto-aplica no act_safe (vira sugerida).
- [ ] **Anti-compounding:** Analisar agora 2× seguidas → o 2º run **não** corta o budget da mesma campanha de novo hoje.
- [ ] **Undo cross-org = 404** (opcional, avançado — precisa de 2 orgs logadas): pela org A, pedir undo de um `toolCallId` da org B → **404** "Ação não encontrada".

---

## 4. Smoke read-only (regressão)
Autonomia = **sugere + OK** (default) → Analisar agora → análise + recomendações + funil/scorecard iguais aos de antes; **zero** escrita. Beta read-only intacto.

---

## Rate-limit da Meta durante a validação
Rodar muitas análises seguidas numa conta real esgota o **orçamento de request** da Meta (`code 17`).
O governor degrada gracioso (run vira `partial`) — não é bug. Mitigação já no código:
- **Cache do catálogo de entidades** (`MetaEntityCache`, Redis, TTL `META_ENTITY_CACHE_TTL_SEC`=1h): o `listEntities` (a chamada pesada) é reusado entre runs. Cliques seguidos **não** re-baixam o catálogo → não estouram.
- **Invalida** só na **escrita real** (pausar/budget/undo) e no TTL. dry-run não invalida.
- Preciso de dado sempre fresco pra um teste? `META_ENTITY_CACHE_TTL_SEC=0` (desliga o cache) — mas aí volta a pressionar o rate-limit.
- Se **estourar mesmo assim:** pare os cliques, espere o cooldown (`redis-cli PTTL meta:gov:cooldown:act_<id>` → ms; `-2` = liberou), rode 1× só.

## Se algo falhar
- `partial=true` inesperado → ver log do worker (rate-limit/erro Meta) + `redis-cli PTTL meta:gov:cooldown:act_<id>`.
- Ação não aplicou → conferra os **3 gates**: autonomia (act_safe/full) **e** ação em `allowed_actions` **e** dry-run OFF **e** kill-switch off.
- Guardrail duplicado: `pnpm db:q "select agent_id,count(*) from guardrail_configs group by 1 having count(*)>1;"` deve vir **vazio**.

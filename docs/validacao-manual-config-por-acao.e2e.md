# E2E docker (DB efêmero, não-destrutivo) — Config por-ação

Valida a fatia "Config por-ação + autonomia por-ação + auto-criação" contra infra real **sem tocar**
no banco de dev (`trafego`). Cria banco **efêmero**, migra (incl. `0039`), valida schema+queries, dropa.

> Pré: `docker ps` mostra `docker-postgres-1` e `docker-redis-1`. `.env` com `DATABASE_URL`.

## 1. Criar o banco efêmero (nunca toca `trafego`)
```bash
docker exec docker-postgres-1 psql -U postgres -tc "DROP DATABASE IF EXISTS trafego_e2e_cfg;"
docker exec docker-postgres-1 psql -U postgres -tc "CREATE DATABASE trafego_e2e_cfg;"
```

## 2. Migrar o efêmero (URL derivada do .env, trocando só o nome do banco)
```bash
export DATABASE_URL="$(node -e "const u=require('fs').readFileSync('.env','utf8').match(/DATABASE_URL=(\S+)/)[1];process.stdout.write(u.replace(/\/trafego(\?|$)/,'/trafego_e2e_cfg\$1'))")"
echo "$DATABASE_URL" | sed -E 's#:[^:@/]+@#:***@#'   # deve terminar em /trafego_e2e_cfg
pnpm --filter @trafego/db exec drizzle-kit migrate
```
**Esperado:** `[✓] migrations applied successfully!` (0000 → **0039**, a última = unique
`agent_tool_bindings_agent_tool_uq`).

## 3. Verificar o schema da fatia (constraint 0039 + bindings)
```bash
docker exec docker-postgres-1 psql -U postgres -d trafego_e2e_cfg -tc \
 "SELECT conname FROM pg_constraint WHERE conname='agent_tool_bindings_agent_tool_uq';"
# → agent_tool_bindings_agent_tool_uq
docker exec docker-postgres-1 psql -U postgres -d trafego_e2e_cfg -tc \
 "SELECT column_name FROM information_schema.columns WHERE table_name='agent_tool_bindings' ORDER BY 1;"
# → agent_id, created_at, id, mode, org_id, tool_key, updated_at
```

## 4. Seed do catálogo (FK das bindings) — as 2 tools de criação têm de existir
```bash
pnpm --filter @trafego/db exec tsx src/seed.ts
docker exec docker-postgres-1 psql -U postgres -d trafego_e2e_cfg -tc \
 "SELECT key, risk_level, proposable FROM agent_tool_definitions ORDER BY key;"
```
**Esperado:** 6 linhas — `create_campaign|high|t` e `duplicate_scale|high|t` presentes (senão o
write-path de bindings FK-falha num DB não-seedado; o seed roda no deploy).

## 5. Smoke das queries net-new no PG real (tabela vazia — valida colunas/enums/SQL)
```bash
# loadEnabledTools: bindings do agente (org-scoped)
docker exec docker-postgres-1 psql -U postgres -d trafego_e2e_cfg -c \
 "SELECT tool_key, mode FROM agent_tool_bindings WHERE agent_id='00000000-0000-0000-0000-000000000000' AND org_id='00000000-0000-0000-0000-000000000000';"
# resolveEnabledTools fallback: allowedActions do guardrail
docker exec docker-postgres-1 psql -U postgres -d trafego_e2e_cfg -c \
 "SELECT allowed_actions FROM guardrail_configs LIMIT 1;"
# byAction (B): override por-ação no jsonb autonomy_policy
docker exec docker-postgres-1 psql -U postgres -d trafego_e2e_cfg -c \
 "SELECT autonomy_policy->'byAction' AS por_acao FROM agents LIMIT 1;"
```
**Esperado:** todos rodam sem erro (colunas/enums/jsonb reconhecidos). `(0 rows)`.

## 6. Suíte automatizada (lógica, externos mockados)
```bash
pnpm typecheck   # limpo
pnpm test        # inclui: resolveEnabledTools, decideActions/byAction, enabledActionTypes,
                 # autoApplyProactiveDraft (paused override + resolve), agents.service
```

## 7. Limpar (dropar o efêmero)
```bash
docker exec docker-postgres-1 psql -U postgres -tc "DROP DATABASE trafego_e2e_cfg;"
```

## Resultado desta execução (2026-08-27)
- 40 migrations (0000→**0039**) aplicaram limpo em banco novo. ✓
- Constraint `agent_tool_bindings_agent_tool_uq` (agent_id, tool_key) presente — chave do upsert do
  write-path (A3). ✓
- Seed: 6 tool defs (incl. `create_campaign`/`duplicate_scale` — FK das bindings). ✓
- Smoke das queries net-new (bindings/allowedActions/byAction) válidas no PG real. ✓
- Suíte verde + typecheck limpo (core/api/worker; testes novos: resolveEnabledTools 4 ·
  decideActions/byAction 4 · enabledActionTypes 3 · autoApplyProactiveDraft 2). ✓
- `trafego` (dev) **intocado**; efêmero dropado.

## Meta/OpenRouter reais
Fora deste E2E de DB. Contra **conta de teste**, tudo PAUSED/revertido — nunca produção. Fluxos-chave:
desligar `duplicate_scale` → CTA some + chat recusa + apply barra; `byAction[adjust_budget]=suggest`
com `bySource.llm=act_full` → orçamento pede OK e o resto auto; `byAction[duplicate_scale]=act_full` +
rascunhos proativos → duplicata criada **PAUSED** + nudge; guardrail de gasto novo baixo → auto barrado.

# E2E docker (DB efêmero, não-destrutivo) — Fatia 7 fast-follows

Procedimento reproduzível pra validar os fast-follows contra infra real **sem tocar** no banco de
dev (`trafego`). Cria um banco **efêmero** no mesmo Postgres do docker, migra, valida e dropa.

> Pré: `docker ps` mostra `docker-postgres-1` e `docker-redis-1`. `.env` com `DATABASE_URL`.

## 1. Criar o banco efêmero (nunca toca `trafego`)
```bash
docker exec docker-postgres-1 psql -U postgres -tc "DROP DATABASE IF EXISTS trafego_e2e_ff;"
docker exec docker-postgres-1 psql -U postgres -tc "CREATE DATABASE trafego_e2e_ff;"
```

## 2. Migrar o efêmero (URL derivada do .env, trocando só o nome do banco)
```bash
# derive a URL efêmera do .env (troca /trafego → /trafego_e2e_ff) e migra
export DATABASE_URL="$(node -e "const u=require('fs').readFileSync('.env','utf8').match(/DATABASE_URL=(\S+)/)[1];process.stdout.write(u.replace(/\/trafego(\?|$)/,'/trafego_e2e_ff\$1'))")"
# confirme que aponta pro efêmero antes de rodar:
echo "$DATABASE_URL" | sed -E 's#:[^:@/]+@#:***@#'   # deve terminar em /trafego_e2e_ff
pnpm --filter @trafego/db exec drizzle-kit migrate
```
**Esperado:** `[✓] migrations applied successfully!` (0000 → 0038, incl. `creative_assets`,
`campaign_drafts`, `approvals.draft_id`, default de `notify_policy`).

## 3. Verificar o schema dos fast-follows
```bash
docker exec docker-postgres-1 psql -U postgres -d trafego_e2e_ff -tc \
 "SELECT column_name FROM information_schema.columns WHERE table_name='creative_assets' ORDER BY 1;"
# deve conter: format, meta_image_hash, meta_video_id, status, storage_ref, org_id, ad_account_id
docker exec docker-postgres-1 psql -U postgres -d trafego_e2e_ff -tc \
 "SELECT to_regclass('public.campaign_drafts') IS NOT NULL, \
   EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='approvals' AND column_name='draft_id');"
# → t | t
```

## 4. Smoke das queries net-new no PG real (tabela vazia — só valida colunas/enums/SQL)
```bash
# reaper de vídeo pendente órfão
docker exec docker-postgres-1 psql -U postgres -d trafego_e2e_ff -c \
 "UPDATE creative_assets SET status='error' WHERE status='pending' AND format='video' AND created_at < now() - interval '30 minutes';"
# getCreativeBlob (org-scoped por assetId)
docker exec docker-postgres-1 psql -U postgres -d trafego_e2e_ff -c \
 "SELECT storage_ref FROM creative_assets WHERE id='<uuid>' AND org_id='<uuid>' AND ad_account_id='<uuid>' LIMIT 1;"
# dedup findReadyAsset
docker exec docker-postgres-1 psql -U postgres -d trafego_e2e_ff -c \
 "SELECT id, meta_image_hash, meta_video_id FROM creative_assets WHERE ad_account_id='<uuid>' AND storage_ref='x' AND status='ready' LIMIT 1;"
```
**Esperado:** todos rodam sem erro (colunas/enums reconhecidos). `UPDATE 0` / `(0 rows)`.

## 5. Suíte automatizada (lógica, externos mockados)
```bash
pnpm test        # 1000+ testes: core/adapters/saga/ingest/poll/dedup/escala/erro
pnpm typecheck   # limpo
```

## 6. Limpar (dropar o efêmero)
```bash
docker exec docker-postgres-1 psql -U postgres -tc "DROP DATABASE trafego_e2e_ff;"
```

## Resultado desta execução (2026-08-27)
- 39 migrations (0000→0038) aplicaram limpo em banco novo. ✓
- Schema dos fast-follows presente (creative_assets vídeo/status/storage_ref; campaign_drafts;
  approvals.draft_id; notify_policy default). ✓
- Reaper UPDATE + getCreativeBlob SELECT + dedup findReadyAsset SELECT válidos no PG real. ✓
- Suíte: shared 16 · core 391 · ads-meta 111 · creative-library 6 · storage-local 5 · storage-s3 5 ·
  channel-evolution 82 · api 103 · worker 316 (+ demais) — **tudo verde**. Typecheck limpo. ✓
- `trafego` (dev) **intocado**; efêmero dropado.

## Meta/OpenRouter reais
Fora deste E2E de DB (não-destrutivo). Use `apps/worker/e2e-real-fatia7.ts` (sessão anterior) contra
**conta de teste**, tudo PAUSED/revertido — nunca produção.

# Validação manual — Fatia 6b (prontidão pra beta real)

Gate de beta + auth self-service com email + billing owner + ops. Pré-requisitos:
`docker compose -f docker/EASYPANEL.md` (pg/redis) no ar, `.env` preenchido, api + worker
rodando (`pnpm dev` ou processos separados). Driver de email: `AUTH_EMAIL_DELIVERY_DRIVER=console`
mostra o código/link no log do **worker**; `=ses` envia de verdade (SES sa-east-1).

## 1. Ops (6b-1)
1. `GET http://localhost:3333/health` → `{status:"ok"}`.
2. `GET http://localhost:3333/ready` → `200 {status:"ready",db:true,redis:true}`. Pare o Postgres
   (`docker stop docker-postgres-1`) → `/ready` = `503 {db:false}`, mas `/health` segue `200`
   (não reinicia em loop). Suba o pg de novo.
3. `LOG_LEVEL=debug` no `.env` → logs de debug aparecem na api. CI (`.github/workflows/ci.yml`)
   roda `build` do web.

## 2. Auth self-service com email (6b-2/6b-3/6b-4)
1. **Signup:** `/signup` → nome, email novo, senha (≥8, com letra+número), org → "Criar conta".
   Vai pra `/verify-email?reason=signup`. **NÃO** logou ainda. Senha fraca (só letras) → erro inline.
2. **Código:** pegue o código no log do worker (`[mailer:console] ... 123456`) ou no email (driver ses).
   Digite → sessão criada → cai no **muro** (passo 3) se o acesso estiver pendente.
3. **Login não-verificado:** crie outra conta, feche a aba sem confirmar. `/login` com email+senha →
   redireciona pra `/verify-email?reason=verify` (código reenviado).
4. **Anti-enum:** signup com email **já existente** → mesma tela de código; o dono real recebe um
   email "você já tem uma conta" (log/inbox). Sem erro "email já existe".
5. **Reset:** `/forgot-password` → email → sempre "verifique seu email". Pegue o link
   (`/reset-password?token=...`) no log/inbox → nova senha → volta ao `/login`. As outras sessões
   do usuário caem (logue em 2 abas antes; após reset, a 1ª cai). `forgot-password` de email
   inexistente → mesma resposta (anti-enum).

## 3. Gate de beta (6b-5)
1. Usuário recém-verificado (pending) → qualquer rota do app → **muro** `/acesso-pendente`
   (estado de espera amigável + "sair"). `GET /api/dashboard` via curl → `403 access_pending`.
   `GET /api/auth/me` segue `200` (o muro lê o status por lá).
2. **Liberar:** `pnpm access:grant <email>` → `✓ acesso liberado` + email de liberação enfileirado
   (log do worker). Recarregue → entra no app.
3. **Listar/revogar:** `pnpm access:list` (tabela) · `pnpm access:revoke <email>` → volta ao muro.
4. **Cron gate:** com a org revogada, o dispatch do cron pula (`skipped_access` no log do worker) —
   não roda análise nem gasta LLM.
5. **Backfill (one-time, pré-go-live):** `pnpm backfill:access -- --confirm` → grandfather de
   users/grants pré-6b (verifica emails existentes + ativa grants pendentes). Rodar **1 vez**.

## 4. Billing owner (6b-6/6b-8)
1. Como **owner**, item **Custos** aparece na sidebar (Configurar). Como member, não aparece.
2. `/custos` → total do período + gasto vs cap (barra) + custo por conta + por tipo + não-atribuído
   (chat). Seletor de período (últimos 6 meses). Valores batem com `usage_events` (compare via
   `pnpm db:q "select type, sum(cost) from usage_events group by type"`).
3. Deixa claro que é **custo (COGS)**, não preço do cliente.

## 5. Email real por SES (opcional — driver ses)
1. `AUTH_EMAIL_DELIVERY_DRIVER=ses` + `AWS_*` no `.env` (IAM `trafego-ses-mailer`, sa-east-1).
2. Signup com email real → o código chega de `no-reply@msg.automato.pro`. Smoke direto:
   `aws sesv2 send-email --region sa-east-1 --from-email-address no-reply@msg.automato.pro ...`.

## Gate estático (antes de mergear)
`pnpm typecheck` · `pnpm test` · `pnpm --filter web tokens:check` · `pnpm --filter web build` — verdes.

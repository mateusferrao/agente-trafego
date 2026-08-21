# Validação manual 6a (Observabilidade + Painel gerencial + Frescura)

Percurso: **Painel** (home gerencial) → **frescura** (sync-only sem run + sweep + lazy + botão) →
**detalhe da conta em abas** → **Timeline** (auditoria, inclui ações por chat) → **as-of honesto**.
Comandos copy-paste (**PowerShell**, Windows). SQL via **`pnpm db:q "<SQL>"`**.

> **Sem migration nesta fatia** (Timeline/Painel = read-only sobre tabelas existentes; frescura = env).
> A maior parte é validável **no navegador** — não precisa de WhatsApp. Para provar "ação por chat na
> web" (passo 6), é bom ter ao menos 1 escrita por chat já feita (roteiro 5c) OU uma ação aplicada.

---

## 0. Setup

```powershell
docker compose -f docker/docker-compose.yml up -d   # postgres + redis
pnpm dev                                            # api (+web) + worker
```
- Env novo: `INSIGHTS_FRESH_THRESHOLD_MIN=120` (confirme no `.env`). É a fonte única do "desatualizado".
- Pré-requisitos: **1+ conta conectada** (token válido) com **1+ análise já rodada** (grade no
  `metrics_snapshot`) e **snapshots de insights** na janela. Sem análise → o painel mostra "sem nota" /
  "rode a primeira análise".
- Abra `http://localhost:<porta>/` → deve cair no **Painel** (não mais em Contas).

Estado inicial útil:
```powershell
pnpm db:q "select id, name from ad_accounts where status='active';"
pnpm db:q "select ad_account_id, max(updated_at) as as_of, count(*) from insights_snapshots group by ad_account_id;"
pnpm db:q "select count(*) from agent_runs;"   # guarde este número (passo 2 prova que refresh NÃO cria run)
```

---

## 1. Painel (home) — os 4 widgets

Abra `/` (ou clique **Painel** no menu).

- [ ] **Pendências:** com aprovações pendentes → "N ações aguardam seu OK" + **Revisar pendências**
      (→ /approvals). Sem pendências → "Nenhuma pendência — tudo em dia" (positivo, não vazio).
- [ ] **Precisam de atenção:** conta com token inválido / nota C-D / sem análise recente / pendência
      aparece com o(s) motivo(s) em badge; clicar leva ao detalhe. (Sem contas flagadas → a seção some.)
- [ ] **Suas contas (panorama):** card por conta com **nota** (+ "análise HH:MM" datada) + **gasto/CPA
      ao vivo** + **as-of** + botão **Atualizar**. Agente pausado → aviso "não atualiza sozinho".
- [ ] **Atividade recente:** ações do agente cross-conta.
- [ ] **0 contas** (org nova, se tiver como testar) → empty-state "Conecte sua primeira conta" →
      Integrações.

Cross-conta bate com o banco:
```powershell
pnpm db:q "select count(*) from approvals where status='pending';"   # = total do widget de pendências
```

## 2. Frescura — "Atualizar agora" NÃO cria run (sync-only)

Antes: anote `count(agent_runs)` (passo 0) e o as-of da conta.
No card de uma conta (Painel) OU na aba Visão geral do detalhe, clique **Atualizar**.

- [ ] Spinner no botão → após alguns segundos o **as-of muda** e os números atualizam no lugar.
- [ ] **Nenhum run novo** foi criado; só os snapshots foram tocados:
```powershell
pnpm db:q "select count(*) from agent_runs;"                          # IGUAL ao passo 0
pnpm db:q "select ad_account_id, max(updated_at) from insights_snapshots group by ad_account_id;"  # as-of avançou
```
- [ ] A **nota/grade não muda** (segue da última análise, datada) — só os números crus atualizam.

## 3. Frescura — lazy on-view

Force o dado a ficar "velho" (passa dos 120 min) e recarregue o Painel:
```powershell
pnpm db:q "update insights_snapshots set updated_at = now() - interval '3 hours';"
```
- [ ] Recarregue `/` → cada conta velha mostra **"desatualizado (HH:MM)"** (tom de alerta) e dispara
      **refresh em background**; após ~5s o Painel recarrega sozinho e o as-of volta a "atualizado".
- [ ] Repare que o disparo é **governado/com teto** (não trava a tela; máx algumas contas por load).

## 4. Frescura — sweep periódico (worker)

No log do **worker**, a cada `INSIGHTS_FRESH_THRESHOLD_MIN` sai um tick `sweep:done`.
- [ ] Envelheça os snapshots (passo 3) e aguarde o próximo tick (ou reinicie o worker p/ o boot agendar).
      Esperado: enfileira sync-only **só p/ as contas velhas** (log `sweep:tick` com `enqueued>0`); conta
      já fresca é pulada. Conta de **agente pausado** NÃO entra no sweep.
```powershell
pnpm db:q "update agents set status='paused' where id = (select id from agents limit 1);"  # opcional: testar exclusão
# ...reverter depois: update agents set status='active' ...
```

## 5. Detalhe da conta em abas

Abra uma conta (`/accounts/:id`).
- [ ] Cabeçalho persistente: nome + badge **Agente ativo/pausado** + **Analisar agora** + **Pausar**.
- [ ] Abas **Visão geral · Agente · Timeline**. "Visão geral" é a default (cai nela ao abrir).
- [ ] **Visão geral:** faixa de KPIs ao vivo (com as-of + Atualizar) + resultado da análise (idêntico ao
      de antes) + mini-surface acionável.
- [ ] **Agente:** a configuração abre **dentro** da conta (a URL vira `/accounts/:id/agente`, sem sair
      do cabeçalho). ⚠️ **Regressão a checar:** salvar a config funciona e o `id` **não** está vazio
      (o fix de herança de rota) — as chamadas devem ir p/ `/accounts/<id>/...`, nunca `/accounts//...`.
- [ ] **Timeline:** abre em `/accounts/:id/timeline` (idem, `id` preenchido).
- [ ] `/accounts/:id/runs/:runId` (clicar num run pela Timeline) abre o detalhe do run **fora** das abas.

## 6. Timeline (auditoria) — inclui ações por chat

Na aba **Timeline**:
- [ ] Feed **agrupado por dia** (rótulo "Hoje" correto no fuso BR) com: **análise concluída** (nota +
      headline, **expansível** → recomendações aninhadas), **erro** (run falho), **ação aplicada/
      revertida**, **aprovação** (pedida/aprovada/rejeitada/expirada).
- [ ] Uma **ação feita por chat** (`run_id` null) aparece com o badge **"chat"** / "via WhatsApp"
      (prova do coalesce + LEFT JOIN). Confirmar que existe uma:
```powershell
pnpm db:q "select tool_key, run_id, agent_id, created_at from agent_tool_calls where run_id is null order by created_at desc limit 5;"
```
- [ ] Filtros: **Tipo** (Análises/Ações/Aprovações) + **Período** (7/30/90/tudo) recarregam o feed;
      **Carregar mais** pagina. Runs linkam pro detalhe do run.
- [ ] **Erro ≠ vazio:** desligue a API (Ctrl+C no processo) e abra a Timeline → estado de erro com
      **"Tentar de novo"** (não "nada por aqui"). Religue a API depois.

## 7. As-of honesto (split ao-vivo × datado)

- [ ] Todo número ao vivo mostra **"atualizado HH:MM"**; passando de 120 min vira **"desatualizado
      (HH:MM)"** com tom de alerta.
- [ ] A **avaliação** (nota) fica rotulada como da última análise (no card do panorama: "análise HH:MM"),
      distinta dos números crus ao lado — o gestor entende que a nota pode estar atrás dos números.

## 8. Estático (gate antes do merge)

```powershell
pnpm typecheck
pnpm --filter web tokens:check
pnpm --filter web build
pnpm test
```
- [ ] Todos verdes. Testes-chave: core (`shouldSync`/`computeLiveTotals`/`resolveWindows`), worker
      (`sweep`), api (`dashboard`/`timeline`).

---

## Checklist
- [ ] `/` abre no Painel; 4 widgets corretos cross-conta; estados positivos/quietos; 0 contas = onboarding
- [ ] "Atualizar agora" atualiza os números **sem criar run** (só bumpa `updated_at`); nota não muda
- [ ] lazy on-view: dado velho → refresca sozinho, governado
- [ ] sweep: tick enfileira só contas velhas; pula fresca e agente pausado
- [ ] abas Visão geral · Agente · Timeline; **id não vazio** nas abas (fix de rota); run-detail fora do chrome
- [ ] Timeline: eventos por dia, análise expansível, **ação por chat visível**, filtros + carregar mais, erro≠vazio
- [ ] as-of honesto (número atualizado HH:MM × nota datada)
- [ ] estático verde (typecheck · tokens:check · build · test)

> **Cleanup:** o passo 3 envelheceu todos os snapshots; rode uma análise ou um "Atualizar" p/ voltar ao real.

# Validação manual — Fatia 6a (Observabilidade + Painel + Frescura)

Pré: api + worker + Postgres + Redis de pé; ao menos 1 conta conectada com análise já rodada.
Login no site. (Frescura real da Meta exige token válido na conexão.)

## 1. Painel (home)
- [ ] `/` redireciona para **Painel** (não mais para Contas). Item "Painel" no topo de "Operar".
- [ ] **Pendências:** com aprovações pendentes → mostra a contagem + "Revisar pendências" (→ /approvals).
      Sem pendências → "Nenhuma pendência — tudo em dia" (estado positivo, não vazio).
- [ ] **Contas em atenção:** conta com token inválido / nota C-D / sem análise recente / pendência aparece
      na faixa com o(s) motivo(s) em badge; clicar leva ao detalhe.
- [ ] **Panorama:** card por conta com nota (datada), gasto/CPA ao vivo, as-of, e botão "Atualizar".
      Agente pausado → aviso "não atualiza sozinho".
- [ ] **Atividade recente:** lista ações do agente cross-conta; uma ação feita por **chat** aparece com o
      badge "chat" (prova do coalesce/LEFT JOIN).
- [ ] **0 contas** (org nova) → empty-state "Conecte sua primeira conta" → Integrações.

## 2. Frescura
- [ ] Abrir o Painel com dado velho (as-of > ~2h) → dispara refresh em background; após alguns segundos os
      números/as-of atualizam sozinhos (lazy on-view).
- [ ] "Atualizar" num card → spinner → `insights_snapshots` atualiza **sem** criar um novo run (conferir:
      nenhuma linha nova em `agent_runs`; `updated_at` dos snapshots muda). Grade/recomendações NÃO mudam
      (seguem da última análise, datadas).
- [ ] Sweep: no worker, após ~`INSIGHTS_FRESH_THRESHOLD_MIN`, contas velhas recebem sync-only; conta já
      fresca é pulada (log `sweep:done`).

## 3. Detalhe da conta em abas
- [ ] `/accounts/:id` mostra cabeçalho (nome + status + Analisar agora + Pausar) + abas
      **Visão geral · Agente · Timeline**.
- [ ] **Visão geral** (default): faixa de KPIs ao vivo (com as-of + "Atualizar agora") + resultado da
      análise (idêntico ao de antes) + mini-surface acionável.
- [ ] **Agente**: a configuração abre **dentro** da conta (não sai da tela). Salvar continua funcionando.
- [ ] **Timeline**: feed por dia com análises (expansível → recomendações), ações (inclui chat),
      aprovações e erros; filtros por tipo/período; "Carregar mais"; runs linkam pro detalhe do run.
- [ ] `/accounts/:id/runs/:runId` (detalhe de um run) segue abrindo (fora do chrome de abas).

## 4. As-of honesto
- [ ] Todo número ao vivo mostra "atualizado HH:MM"; passando do limite vira "desatualizado (HH:MM)".
- [ ] A avaliação (nota/headline) fica rotulada como da última análise (datada), distinta dos números.

## Estático
- [ ] `pnpm typecheck` verde · `pnpm --filter web tokens:check` verde · `pnpm --filter web build` sem erro.
- [ ] `pnpm test` verde (core: shouldSync/computeLiveTotals/resolveWindows; worker: sweep; api:
      dashboard/timeline).

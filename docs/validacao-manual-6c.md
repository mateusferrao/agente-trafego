# Validação manual — Fatia 6c (Qualidade do agente + verificações)

Pré: `pnpm db:migrate` (aplica `0019` — `usage_events.ad_account_id`) e, opcionalmente,
`pnpm backfill:usage-account` (preenche a conta dos runs antigos). Conta Meta conectada
e sincronizada.

## 1. Core de qualidade (automático)
- `pnpm --filter @trafego/core test` — verde (benchmarks, tiers, fadiga/significância,
  guard de escala, fixture-ouro Steticos end-to-end).
- `pnpm typecheck` — limpo.

## 2. Análise real (tiers + diagnóstico + guard)
Dispare uma análise on-demand numa conta ativa (botão do site ou "analisa agora" no chat).
Confira no resultado / detalhe da conta:
- [ ] Recomendações citam número real + causa provável (diagnóstico por padrão de métrica).
- [ ] Entidade com gasto e 0 conversão aparece como candidata a **pausar** (zombie).
- [ ] Recomendação de **escalar** entidade sem base estatística vem rebaixada p/ "investigar"
      com a nota "sem base estatística ainda (N)".
- [ ] Campanha com CTR caindo + frequência alta + custo subindo → sinal de **fadiga**.

## 3. Visão HD + multi-frame (verificação pedida)
- [ ] Rode a análise numa conta com criativos de **vídeo**. Nos logs/trace de visão,
      confirme que o poster é o frame **HD** (não o selo 64px) e que há **múltiplos frames**.
- [ ] Custo de `vision` só no **1º run**; no 2º run o cache acerta (chave por id estável do
      criativo, não pela URL do fbcdn). Confira em `usage_events` (`type='vision'`).

## 4. Custo do chat via POST simulado (verificação pedida)
Com api+worker+pg+redis no ar e um contato verificado:
1. Envie um POST ao webhook inbound simulando uma mensagem do contato (mesmo formato do
   Evolution `MESSAGES_UPSERT`, com o secret da instância no header). Ex.:
   `curl -X POST "$API_ORIGIN/webhooks/evolution/<instancia>" -H "<secret-header>" -d @payload.json`
2. Aguarde o turno do Grafo B rodar.
3. Confira em `usage_events`:
   - [ ] linha `type='conversation'` com `input_tokens`/`output_tokens` e **`cost`** preenchido
         (o custo pode chegar via patch assíncrono alguns segundos depois — `bindTools` suprime
         o usage; o fallback busca a generation).
   - [ ] `ad_account_id` = a conta em foco da conversa (não nulo, salvo concierge sem foco).
   - [ ] `payload_json.conversationId` presente.
4. No painel de **Custos** (owner): o custo do chat aparece **atribuído à conta** (não mais em
   "sem conta"), e o tipo **Revisão** aparece quando houve análise com revisor (D1).

## 5. Arquétipos + UI avançada
- [ ] Na config do agente, os 3 arquétipos aparecem com **descrição** + "quando usar".
- [ ] Trocar p/ **Guardião de Lançamento** semeia cadência 2×/dia (se a cadência estava no
      padrão do sistema); trocar p/ **Otimizador** deixa playbook "age no seguro".
- [ ] "Opções avançadas" mostra os knobs (revisão/top-N/frames/significância/learning/fadiga
      + toggle de cold-start) com **tooltips** amigáveis; "usar padrão do sistema" quando vazio.
- [ ] Tag de **tier** (rótulo PT: campeã/ok/abaixo da meta/parada) nas recomendações e no
      detalhe da conta.

# Validação manual — Fatia 6c (Qualidade do agente + verificações)

Pré: `pnpm db:migrate` (aplica **`0019`** `usage_events.ad_account_id` **e `0020`** `entity_analyses.tier`)
e, opcionalmente, `pnpm backfill:usage-account` (preenche a conta dos runs antigos). Conta Meta
conectada e sincronizada; api+worker+pg+redis no ar.

> Marcações **[✓ sessão]** = já validado ao vivo na sessão de implementação (conta real Steticos).

## 1. Core de qualidade (automático)  **[✓ sessão]**
- `pnpm --filter @trafego/core test` — verde (benchmarks, tiers, fadiga/significância, **sinal de
  vida do zumbi**, guard de escala, fixture-ouro Steticos e2e). (194 testes)
- `pnpm typecheck` — limpo (todos os packages). Web: `pnpm --filter web typecheck` + `tokens:check`.

## 2. Análise real — tiers, diagnóstico e guard  **[✓ sessão]**
Dispare uma análise on-demand (botão do site ou "analisa agora" no chat). Confira:
- [ ] Recomendações citam número real + **causa provável** (árvore de diagnóstico por métrica).
- [ ] **Tier** classificado por campanha (winner/performer/underperformer/zombie) coerente com meta+conta.
- [ ] **Zumbi só sem NENHUM sinal de vida** (regra nova, pós-review): campanha que gera **conversas**
      (funil) ou tem proxy **NÃO** é zumbi, mesmo com 0 conversão de negócio; e campanha **em learning**
      (sem baseline) nunca é zumbi. Só é zumbi quem gastou ≥ mínimo, sem conversão/proxy/conversa, fora de learning.
- [ ] **Winner que piorou vs baseline continua winner** (não é rebaixado a underperformer por bater a meta).
- [ ] Recomendação de **escalar/reativar** entidade sem base estatística (ou em learning) vem rebaixada
      p/ **investigar** com nota "sem base estatística ainda (N)". (Guard cobre origem **LLM**; regra de
      **playbook** não passa pelo veto — intencional, o guardrail de blast-radius é a rede lá.)
- [ ] Campanha com CTR caindo + frequência alta + custo subindo → sinal de **fadiga**.

## 3. Visão HD + multi-frame + decomposição  **[✓ sessão — 16 criativos, $0,0174]**
- [ ] Conta com criativos de **vídeo**: confirme frames **HD** (não o selo 64px) e **múltiplos frames**
      por criativo (via `usage_events type='vision'` com custo por criativo maior que o de 1 frame).
- [ ] O resultado da visão traz **decomposição** (hook/angle/format/cta) além de strengths/weaknesses/score.
- [ ] Cache: no **2º run** da mesma conta o custo de `vision` cai a ~0 p/ criativos inalterados
      (chave por **id estável** do criativo, não a URL fbcdn). *(não re-executado na sessão — por design.)*

## 4. Custo do chat via POST simulado  **[✓ sessão]**
1. POST no webhook inbound simulando `MESSAGES_UPSERT` do contato verificado, com o secret da instância
   no header `x-webhook-secret`:
   `curl -X POST "$API_ORIGIN/webhooks/evolution/<instancia>" -H "x-webhook-secret: <secret>" -d @payload.json`
2. Aguarde o debounce (~5s) + o turno do Grafo B.
3. Confira em `usage_events`:
   - [ ] `type='conversation'` com `input_tokens`/`output_tokens` e **`cost`** preenchido (pode chegar
         via patch assíncrono — `bindTools` suprime o usage; o fallback busca a generation).
   - [ ] `payload_json.conversationId` **e** `contactId` presentes.
   - [ ] `ad_account_id` = conta **em foco/sole**; **concierge** (multi-conta sem foco) → `ad_account_id`
         **nulo** (correto — cai em org-only).
4. **Painel de Custos (owner):** custo do chat **atribuído à conta** (COALESCE), some do "sem conta";
   tipo **Revisão** aparece (D1 — o revisor agora emite `usage_event`).

## 5. Atribuição de custo por conta + backfill  **[✓ sessão]**
- [ ] Eventos de **run** (unit/vision/synthesis/review/message) têm `run_id`; a atribuição por conta usa
      **COALESCE(ad_account_id direto, run→agente→conta)** — chat usa o direto, run usa o join.
- [ ] `pnpm backfill:usage-account` (idempotente) preenche `ad_account_id` dos eventos de run antigos;
      re-rodar não muda nada.
- [ ] Billing byAccount não dupla-conta e o `unattributedCostUsd` = total − atribuído.

## 6. Contrato + endpoint de arquétipos
- [ ] `pnpm api:generate` sem drift (contrato inclui `ArchetypeCatalogOutput`, `modelConfig`, `tier`).
- [ ] `GET /api/agents/archetypes` responde os 3 arquétipos (key/label/description/whenToUse).

## 7. UI — arquétipos, opções avançadas, tier  (web em `localhost:4200`)
- [ ] Config do agente: seletor mostra os 3 arquétipos com **descrição** + "quando usar" (do catálogo).
- [ ] Trocar p/ **Vigia Intensivo** semeia cadência 2×/dia (se estava no padrão); **Otimizador**
      deixa playbook "age no seguro". Ambos trazem "criativo é o novo público" na metodologia (A4).
- [ ] **"Opções avançadas"** (recolhida): knobs (modelos/revisão/top-N/tokens/significância/learning/
      fadiga + toggle cold-start) com **tooltips**; "padrão do sistema" quando vazio. **Salvar um override**
      persiste em `agents.model_config` e reflete no próximo run (força 1 deep). Campos de mínimo **não
      aceitam 0** (alinhado ao contrato `exclusiveMinimum`).
- [ ] Tag de **tier** (PT: campeã/ok/abaixo da meta/parada) no **detalhe da conta** e nas **recomendações**
      que miram campanha; não renderiza quando `tier` é null. `entity_analyses.tier` persiste (histórico).

## Observações
- Custo real de rodar 2+4 ao vivo ≈ centavos–dezenas de centavos (1 run completo + turnos de chat).
- Ativar um agente p/ testar atribuição/análise → **restaurar o status original** ao fim.

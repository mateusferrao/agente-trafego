# Roteiro de validação manual — Pivô B2B/B2C

Cobre as 4 frentes do pivô: posicionamento/copy, arquétipo Vigia Intensivo, referência de mercado configurável (currency-aware), multi-moeda cross-conta e contas zeradas (dormância + reativação). Caminhos felizes **e** tristes.

Pré: `pnpm install` · `pnpm db:migrate` · `pnpm db:seed` · `pnpm dev` (api+worker+web). Rodar os backfills uma vez: `pnpm backfill:archetype` e `pnpm backfill:notify-reactivation`.

---

## 0. Estático (gate antes do manual)
- [ ] `pnpm typecheck` limpo (todos os packages).
- [ ] `pnpm test` verde (core/api/worker).
- [ ] `pnpm --filter web typecheck` + `cd apps/web && node scripts/validate-design-tokens.mjs` (tokens ok).
- [ ] `pnpm api:generate` sem drift (git status limpo nos gerados).

## 1. Posicionamento & copy (sem nicho)
- [ ] grep de nicho limpo nos arquivos visíveis: `grep -rniE "saúde|clínica|clinica|médic|infoproduto" apps/web/src apps/worker/src/modules apps/worker/src/graphs docs/plan.md README.md CLAUDE.md` → só falsos-positivos (health-check de conexão), nenhum de vertical.
- [ ] Login: placeholder do nome da org = "Sua agência ou empresa".
- [ ] Config do agente: placeholders/help sem "médicos"/"lançamento"; cadência fala "momentos críticos".
- [ ] (triste) Nenhuma tela quebra por copy trocada (render normal).

## 2. Arquétipo Vigia Intensivo
- [ ] Catálogo de arquétipos na config mostra: Conservador, Otimizador, **Vigia Intensivo** (não "Guardião de Lançamento").
- [ ] Selecionar Vigia Intensivo → reseed semeia cadência 2×/dia (8h/18h), alerta sensível (high, throttle 3) e reativação ON.
- [ ] (triste/migração) Agente legado com `archetype='guardiao_lancamento'`: após `pnpm backfill:archetype`, vira `vigia_intensivo` (query no DB). Antes do backfill, `archetypeDefaults` cairia em conservador (fallback) — confirmar que o backfill corrige.

## 3. Referência de mercado configurável (currency-aware)
### Feliz
- [ ] Configurações (org): seção "Referência de mercado". Escolher moeda (ex: BRL), preencher custo por venda min/max → Salvar → toast de sucesso. Recarregar: valores persistem.
- [ ] Opções avançadas: CTR bands + frequência + zumbi + baseline aparecem sob "opções avançadas" (divulgação progressiva); custo é o primário.
- [ ] Config do agente (conta BRL): seção "Referência de mercado desta conta" na moeda da conta; vazio herda a org. Sobrescrever só o custo de venda → Salvar → só esse campo diverge da org.
- [ ] Rodar análise numa conta em cold-start (com gasto, SEM meta e SEM histórico): a referência de custo aparece no brief/recomendações rotulada como referência (nunca meta).
### Triste / moeda
- [ ] Org-default em BRL + conta em **USD**: a faixa de custo do org **não** aplica na conta USD (custo omitido); CTR/frequência ainda aplicam. Preencher override em USD no agente → custo passa a aplicar.
- [ ] Conta sem `currency` (null): nenhum custo casa (só CTR/freq); não quebra.
- [ ] Toggle "Usar referência de mercado" OFF → nenhuma referência entra, mesmo com tabela preenchida.
- [ ] Tabela toda vazia → `benchmarkFor` não injeta faixa de custo; zombie/baseline caem no fallback do sistema.
- [ ] (permissão) Membro (não-owner) não consegue salvar a referência da org (403).

## 4. Multi-moeda cross-conta
- [ ] Org com contas BRL **e** USD, ambas com desperdício: widget "Dinheiro sem retorno" do painel mostra **totais por moeda** ("R$ X em N contas · US$ Y em M contas") — NUNCA um total somando moedas.
- [ ] Cada conta na lista de desperdício formata o valor na SUA moeda.
- [ ] Concierge no WhatsApp (org multi-conta): `list_accounts` traz a moeda por conta; o agente não compara/soma gastos de moedas diferentes.
- [ ] Custos (Billing/`/costs`) seguem em US$ (infra) — inalterado.
- [ ] (triste) Org só-BRL: manchete mostra um único grupo BRL (sem "· " sobrando).

## 5. Contas zeradas — dormância + reativação
### Empty-state no chat
- [ ] "Analisar agora" (site, on-demand) numa conta zerada (spend=0 e impressions=0): chega no WhatsApp a mensagem amigável de empty-state + oferta "quer que eu avise quando voltar a rodar?" (só se reativação OFF).
- [ ] Mesma conta com reativação já ON: empty-state sem a oferta (evita redundância).
- [ ] (triste) Cron numa conta zerada: silêncio (sem push), run fecha com o resumo neutro.
### Dormância (backoff)
- [ ] Conta ativa que para de gastar: após `DORMANT_AFTER_DAYS` (default 7) sem atividade, o próximo sweep/sync marca `activity_state=dormant`, remove os schedules de análise e pulso (checar no DB + logs "dormancy:conta dormante").
- [ ] Card de panorama (dashboard + Contas) da conta dormante mostra "conta parada — vigiando o retorno" (tom+texto).
- [ ] Sweep: conta dormante é varrida na cadência lenta (`DORMANT_SWEEP_INTERVAL_MIN`, default 1440min), não a cada `INSIGHTS_FRESH_THRESHOLD_MIN`.
- [ ] (triste) Conta recém-conectada e nunca ativa: NÃO vira dormante antes de `DORMANT_AFTER_DAYS` desde a conexão (graça por `createdAt`).
- [ ] (triste) Conta com token inválido: NUNCA vira dormante (o remédio é recolar o token; o card mostra "Token expirado").
### Reativação
- [ ] Conta dormante volta a gastar: o próximo sweep sync-only detecta atividade → `activity_state=active`, recria schedules → se `reactivation.enabled`, dispara run `trigger=signal` e empurra a 1ª análise no WhatsApp.
- [ ] Reativação com `reactivation.enabled=false`: recria schedules mas NÃO dispara/avisa.
- [ ] (triste) Não há duplicidade: a reativação dispara o run de reativação e o gate de alerta normal é pulado no mesmo tick.
### Config da reativação (UI + chat)
- [ ] Config do agente → notificações: toggle "avisar quando a conta voltar a rodar" salva e persiste.
- [ ] WhatsApp: pedir "me avisa quando a conta voltar a rodar" → o agente chama `set_notifications` (reactivationEnabled) sob eco+confirma (de X → para Y). Confirmar liga; recusar não muta.
- [ ] Kill-switch por chat (`autonomy_policy.autoConfigViaChat` OFF): a config via chat é barrada (só pelo site).

## 6. Regressão (não quebrou o que existia)
- [ ] Análise normal (conta ativa, com meta): fluxo cron→brief→recomendações→push inalterado.
- [ ] Pulso e alerta de mudança material seguem funcionando (agora com moeda correta no texto).
- [ ] Aprovação conversacional e via site inalteradas.

---

## Execução E2E — resultado (2026-08-26)

Ambiente do container: Postgres 16 + Redis 7 nativos, API real no boot. Serviços externos (Meta, Evolution, OpenRouter) **não** disponíveis aqui — os passos que dependem deles ficam para a stack completa do usuário (`pnpm dev` com credenciais). A lógica determinística desses passos é coberta pela suíte automatizada (core 358 · api 100 · worker 289).

### ✅ Verificado ao vivo (infra + API real)
- **§0 Gate estático:** `pnpm typecheck` (17/17), `pnpm test` (core/api/worker), `tokens:check`, `pnpm --filter web build` (AOT), `pnpm api:generate` sem drift.
- **Migrations (ao vivo):** `pnpm db:migrate` limpo (35 migrations). `orgs.market_reference jsonb` ✓; `ad_accounts.activity_state` (enum `active|dormant`, default `active`) + `last_activity_at timestamptz` ✓; enum `activity_state` = {active, dormant} ✓; default de `agents.notify_policy` já inclui `reactivation:{enabled:false}` ✓.
- **§2 Backfill de arquétipo (ao vivo):** agente semeado com `guardiao_lancamento` → `pnpm backfill:archetype` → `vigia_intensivo` (1 migrado); rerun migra 0 (**idempotente**) ✓.
- **§5 Backfill de reativação (ao vivo):** agente legado com `notify_policy` sem `reactivation` → `pnpm backfill:notify-reactivation` (1 normalizado) → todos com `reactivation:{enabled:false}`; rerun 0 (**idempotente**) ✓.
- **Boot da API (ao vivo):** composition root sobe, auto-migrate roda, `/health` ok, `/ready` `{db:true, redis:true}` ✓.
- **§3 Referência de mercado (round-trip HTTP real):** rota registrada (401 sem auth, não 404) + presente no `openapi.json` com o schema `MarketReference` ✓. Fluxo signup→verify→login→sessão real: `GET` inicial `{marketReference:null}` (vazio = não usa como contexto) ✓; `PUT` (org BRL: custo `sale`/`lead`, CTR bands, frequência, zombie/baseline) persiste e `GET`/DB confirmam ✓; **caminho triste:** chave de custo inválida (`purchase`) é **descartada** pela validação zod (só `conversation|lead|sale`) ✓; gate de acesso beta retorna 403 com mensagem amigável ("conta em análise") ✓.
- **§4 Multi-moeda cross-conta (round-trip HTTP real):** org com conta BRL (waste 1200) + conta USD (waste 300) → `GET /dashboard` retorna `waste.byCurrency = [{BRL,1200,1},{USD,300,1}]` — **nunca soma** as moedas (não vira 1500); cada conta formatada na sua moeda ✓.

### ⏳ Requer a stack completa do usuário (worker + Meta + Evolution + OpenRouter)
Lógica determinística coberta por testes automatizados; a validação de ponta a ponta exige os serviços externos:
- **§2** reseed de arquétipo pela UI (lógica em `agent-config/apply.test.ts`).
- **§3** referência de custo aparecendo num brief de análise real cold-start (core: `benchmarks`/`market-reference` tests).
- **§5** transição de dormância após sync real da Meta + dispatch de reativação + push no WhatsApp (core `dormancy` 8 tests; gate no `insights-sync`); auto-config de reativação via chat (grafo do worker + Evolution).
- **§6** regressão da análise completa (OpenRouter + Meta) e textos de pulso/alerta com a moeda correta.

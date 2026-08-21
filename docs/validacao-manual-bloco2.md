# Validação manual — Bloco 2 (qualidade + auto-config por chat)

Roteiro **executável e completo**. Cada passo tem: **ação** → **resultado esperado** →
**como verificar** (query/UI/log) → **aceite (PASSA)**. Cobre S1.1–S2.8, as correções
da revisão e os casos negativos/edge. Substitui os docs `-qualidade`/`-autoconfig`.

> Legenda de verificação: `DB` = query via `pnpm db:q "<SQL>"`; `UI` = tela; `LOG` =
> log do worker (pino); `TEST` = já coberto por teste automatizado (evidência sem
> ambiente). Onde um cenário depende de dados que a conta real pode não ter, o passo
> traz o fallback `TEST` + o que observar se aparecer ao vivo.

---

## 0. Mapa slice → cobertura (checklist)

| Slice | O que validar | Passo |
|---|---|---|
| S1.1 público neutro | `AudienceProfile` no adset; tag de estágio no cartão | A1 |
| S1.2 freq por estágio | prospecção satura antes; remarketing tolera | A2 (TEST+obs) |
| S1.3 tracking furado | nota de conta + caveat na pausa `target`; não em `proxy`/conversa | A3 |
| S1.4 não-matar-em-learning | pausar LLM em learning → investigar | A4 (TEST+obs) |
| S1.5 desperdício/Pareto | `waste` no snapshot; freed-spend; money-shot; finding não-dropado | A5 |
| S1.6 visão body/proof | `body`/`proofStrength` no cache; recusto 1x; 2º run cacheia | A6 |
| S1.7 redator money-shot | mensagem abre pelo dinheiro | A7 |
| S1.8 UI + contrato | cards/ressalva/tag/widget/knobs; SQL do widget | A8 |
| S2.1/2.2 camada compartilhada | config pelo site = idêntico (round-trip) | B0 |
| S2.4 tools por intenção | set_goal/autonomy/guardrail/cadence | B1–B3 |
| S2.4 reseed + fix revisão | reseed avisa afrouxamento de autonomia | B4 |
| S2.5 playbook por chat | add/toggle/remove org-scoped + audit | B5 |
| S2.6 identidade | persona/tom/prompt (aviso de metodologia) | B6 |
| S2.3 kill-switch | OFF → config só pelo site | B7 |
| S2.7 describe_capabilities | reflete allow/autonomia/kill-switch | B8 |
| foco troca config | próximo turno usa a conta focada | B9 |
| correções revisão | mixed-turn, guard de frescura, collectBriefNumbers | E1–E4 |
| segurança/tenancy | eco+confirma sempre; audit; org-scoping | S |

---

## 1. Pré-requisitos / setup

### 1.1 Infra + boot
```bash
docker ps           # postgres + redis de pé (o .env aponta pra localhost:5432/6379)
pnpm db:migrate     # idempotente
pnpm db:seed        # semeia o catálogo de tools
pnpm dev            # api (+web estático) + worker + web, em paralelo
```
`.env` precisa de: `OPENROUTER_API_KEY` (custo do LLM), `EVOLUTION_*`, e uma
`platform_connections` com `token_status='valid'` (token Meta que **lê** a conta).

### 1.2 Descobrir os valores reais (substitua nos comandos abaixo)
```bash
# Conta + agente com token válido + histórico (p/ a Parte A):
pnpm db:q "select a.id agent_id, ac.id account_id, ac.name, ac.currency, a.goals, pc.token_status from agents a join ad_accounts ac on ac.id=a.ad_account_id join platform_connections pc on pc.id=ac.connection_id where a.status='active' and pc.token_status='valid' order by (select count(*) from insights_snapshots i where i.ad_account_id=ac.id) desc limit 5"

# Contato verificado + instância + secret (p/ a Parte B — chat):
pnpm db:q "select c.org_id, c.phone, ci.evolution_instance, ci.webhook_secret from contacts c join channel_instances ci on ci.org_id=c.org_id where c.verified=true limit 1"
```
Anote: `AGENT_ID`, `ACCOUNT_ID`, `ORG_ID`, `PHONE` (formato `+55...`), `INSTANCE`
(ex: `org-<orgId>`), `SECRET`. Garanta que o agente tem **meta de negócio** (senão o
tracking/tiers não têm base): se `goals` vier vazio, defina pelo site (`/accounts/:id/agente`)
ou `pnpm db:q "update agents set goals='{\"conversionGoal\":\"purchase\",\"targetCPA\":120}'::jsonb where id='AGENT_ID'"`.

### 1.3 Disparar um inbound de chat simulado (curl real)
O worker faz **debounce ~5s** e **dedupe por messageId** — use um `id` novo a cada msg
e aguarde ~6s pela resposta. `remoteJid` = `PHONE` sem o `+` + `@s.whatsapp.net`.
```bash
MSG="muda a meta pra custo por venda de R$ 120"          # troque por cada teste
curl -s -X POST "http://localhost:3333/webhooks/evolution/INSTANCE" \
  -H "content-type: application/json" -H "x-webhook-secret: SECRET" \
  -d '{"event":"MESSAGES_UPSERT","instance":"INSTANCE","data":{"key":{"remoteJid":"55XXXXXXXXXXX@s.whatsapp.net","fromMe":false,"id":"T-'"$(cat /proc/sys/kernel/random/uuid 2>/dev/null || echo $RANDOM$RANDOM)"'"},"message":{"conversation":"'"$MSG"'"}}}'
# 200 rápido. A RESPOSTA do agente sai via Evolution (WhatsApp real) E fica gravada:
pnpm db:q "select direction, body, created_at from messages order by created_at desc limit 6"
```
**Aceite do setup:** o inbound de um número **não-verificado** deve ser **ignorado em
silêncio** (nada em `messages`, nada de resposta) — teste com um `remoteJid` aleatório
e confirme que não gravou nada.

---

## 2. Parte A — Qualidade (S1.1–S1.8)

### A0. (pré-req) Rodar uma análise nova pós-Bloco-2
Os runs antigos não têm `waste`/`trackingHealth`/`stage` (predam o Bloco 2) — **é preciso
um run novo**.
- **Ação:** botão "Analisar agora" no detalhe da conta **ou** `curl -X POST .../accounts/ACCOUNT_ID/runs` (com sessão) **ou** "analisa agora" pelo chat.
- **Verificar (DB):** `pnpm db:q "select id, status, (metrics_snapshot ? 'waste') has_waste, (metrics_snapshot ? 'trackingHealth') has_tracking from agent_runs where agent_id='AGENT_ID' order by created_at desc limit 1"`
- **Aceite:** `status=succeeded`; o run recente é o alvo das checagens A1/A3/A5. Anote `RUN_ID`.
- **Custo/efeito:** lê a Meta + gasta LLM. Sem escrita.

### A1. Público neutro + tag de estágio (S1.1)
- **Verificar (DB):** `pnpm db:q "select metrics_snapshot->'campaigns' from agent_runs where id='RUN_ID'"` → cada cartão de campanha tem (ou não) `stage` (prospecting/remarketing).
- **Verificar (UI):** run detail → cartão de campanha mostra a **tag de estágio** (prospecção/remarketing/público indefinido) ao lado do tier.
- **Aceite:** campanhas cujos adsets têm público custom de retargeting → `remarketing`; só amplo/interesses/lookalike → `prospecting`. **stage `null` na visão AO VIVO da conta é esperado** (não-bug: `entity_analyses` não congela público — fast-follow).

### A2. Frequência por estágio (S1.2)
- **TEST:** `pnpm --filter @trafego/core exec vitest run src/quality` — casos "prospecção satura a 2,6; remarketing não".
- **Ao vivo (obs):** se a conta tiver adset de prospecção com frequência >2,5, ele deve carregar `audience_saturation` em `healthSignals` (`metrics_snapshot->'campaigns'` / `entity_analyses`). Override: "Qualidade e limiares" (frequência frio/quente).
- **Aceite:** teste verde; observação coerente se houver o dado.

### A3. Tracking furado (S1.3) — caso Steticos
- **Ação:** conta com **meta de venda/lead** e muito funil de conversas + poucas conversões rastreadas.
- **Verificar (DB):** `pnpm db:q "select metrics_snapshot->'trackingHealth' from agent_runs where id='RUN_ID'"`
- **Verificar (UI/mensagem):** run detail mostra "A medição de **resultados** parece incompleta" (copy **neutra** — não "vendas"); a mensagem do WhatsApp ressalva antes de sugerir corte.
- **Verificar (rationale):** uma recomendação de **pausar** em entidade base `target` traz `[tracking]` no `rationale`; base `proxy` **não** traz.
- **Aceite:** `suspect=true` só quando meta off-platform + funil>>conversões; meta de **conversa** (messaging) **não** dispara (`trackingHealth` ausente). `TEST`: `src/tracking` + `src/analysis-guards/guard-tracking`.

### A4. Não-matar-em-learning (S1.4)
- **TEST:** `src/analysis-guards/guard-kill` (pausar em learning → investigate; playbook explícito passa).
- **Ao vivo (obs):** se houver entidade nova (sem baseline) com recomendação LLM de pausa, ela vira `investigate` com nota "em aprendizado". Verificar `recommendations` do `RUN_ID`.
- **Aceite:** teste verde; observação coerente.

### A5. Desperdício + Pareto + money-shot (S1.5)
- **Verificar (DB):** `pnpm db:q "select metrics_snapshot->'waste' from agent_runs where id='RUN_ID'"` → `wastedSpend` (R$ + %), `zombies[]`, `pareto.misallocated[]`.
- **Verificar (rationale):** recomendações de **pausa** trazem "[impacto] pausar libera ~R$X no período".
- **collectBriefNumbers (correção da revisão):** o finding de desperdício que cita um **agregado** (ex: wastedSpend) **não é descartado** pelo guard. Verificar: `metrics_snapshot->'findings'`/recomendações mencionam o valor de desperdício e sobrevivem. `TEST`: `src/analysis-guards`.
- **Aceite:** `wastedSpend` = só zumbis; Pareto por base de conversão (não mistura conversa com venda); o money-shot aparece.

### A6. Visão: body + proofStrength (S1.6)
- **1º run pós-bump:** recusta a visão (cache invalidado por `analyzerVersion`→3). **2º run:** não recusta.
- **Verificar (DB):** `pnpm db:q "select analyzer_version, result->'body' body, result->'proofStrength' proof from creative_vision_analyses order by created_at desc limit 5"`
- **Verificar (custo):** `pnpm db:q "select type, count(*), round(sum(cost)::numeric,4) from usage_events where type in ('vision') and created_at > now() - interval '1 hour' group by type"` → custo de `vision` no 1º run, ~0 no 2º.
- **Aceite:** `analyzer_version=3`; `body`/`proofStrength` presentes (proofStrength ∈ weak/medium/strong); 2º run não recusta.

### A7. Redator lidera pelo money-shot (S1.7)
- **Ação:** um run via **cron** ou **"analisa agora"** (que empurra mensagem) numa conta com desperdício material.
- **Verificar:** a mensagem (WhatsApp / `messages`) **abre pelo dinheiro** ("R$ X em campanhas paradas...") antes do diagnóstico; ressalva de tracking quando `suspect`.
- **Aceite:** money-shot no topo quando `wastedSpend>0`. `TEST`: `src/message` (fallback determinístico).

### A8. UI + contrato + dashboard (S1.8)
- **Run detail (UI):** card "Dinheiro sem retorno" (R$/% + zumbis + má alocação "consome X% e entrega Y%"); ressalva de tracking (copy neutra); tag de estágio; impacto liberado na pausa.
- **Painel (UI + SQL):** widget de desperdício cross-conta. Verificar o SQL (corrigido na revisão) retorna: `pnpm db:q "select agent_runs.metrics_snapshot #>> '{waste,wastedSpend}' from agent_runs where status='succeeded' order by finished_at desc limit 5"` (não pode dar erro de operador).
- **Config (UI):** "Qualidade e limiares" tem os 4 knobs novos (frequência frio/quente; conversas por conversão p/ suspeitar; mínimo de conversas) com **placeholder = default real** e tooltip neutra (sem "venda"/"pixel/CAPI").
- **Aceite:** telas renderizam com dados; empty states quando ausente; `pnpm --filter web run tokens:check` verde.

---

## 3. Parte B — Auto-config por chat (S2.1–S2.7)

Setup: contato verificado + agente em contexto (1 conta ativa OU foco); kill-switch ON
(default). Cada passo = inbound simulado (§1.3), aguardar ~6s, confirmar "sim" num 2º inbound.

### B0. Camada compartilhada — round-trip pelo site (S2.1/S2.2)
- **Ação:** salvar a config pelo site (`PUT /accounts/:id/agent/config`, ou a tela).
- **Aceite:** comportamento idêntico ao de antes (testes de agents verdes: `pnpm --filter @trafego/api exec vitest run src/modules/agents`). A escrita agora passa pela camada compartilhada.

### B1. Mudar meta (S2.4)
- **msg1:** "muda a meta pra custo por venda de R$ 120" → **eco**: "meta de custo por venda: R$X → R$120" + oferta de análise.
- **msg2:** "sim".
- **Verificar (DB):** `pnpm db:q "select goals from agents where id='AGENT_ID'"` → `targetCPA=120`; `pnpm db:q "select actor, action, target from audit_log order by created_at desc limit 3"` → `actor='contact:...'`, `action` de config.
- **Aceite:** persistiu + audit com o contato + oferta de rodar análise (não disparou sozinho).

### B2. Afrouxar guardrail — aviso de afrouxamento
- **msg1:** "afrouxa o limite de mudança de budget pra 30%" → eco com **"⚠️ Isso afrouxa sua segurança"** + "limite de budget: X% → 30%".
- **msg2:** "sim". **Verificar (DB):** `pnpm db:q "select max_budget_change_pct from guardrail_configs where agent_id='AGENT_ID'"` → 30.
- **Aceite:** o ⚠️ apareceu; persistiu.

### B3. Lote (multi-campo)
- **msg1:** "muda a meta pra R$ 100 e a cadência pra 2x por dia" → eco lista **as duas** mudanças.
- **msg2:** "sim". **Aceite:** ambas persistem (`goals` + `agents.cadence` = `{kind:"twice_daily",...}`) num único "sim".

### B4. Reseed de arquétipo (S2.4 + correção da revisão)
- **msg1:** "vira o arquétipo Otimizador" → eco: reseta persona/tom/metodologia/autonomia; **se a autonomia SOBE** (ex: conservador `só avisa` → otimizador `age no seguro`), o eco traz **"⚠️ Isso afrouxa sua segurança"** + a linha `autonomia (regras): só avisa → age no seguro`.
- **msg2:** "sim". **Verificar (DB):** `pnpm db:q "select archetype, autonomy_policy, persona, tone, system_prompt from agents where id='AGENT_ID'"` → archetype trocado, autonomy = defaults do preset, persona/tone/system_prompt `null`, **goals/contexto preservados**.
- **Aceite:** aviso de afrouxamento presente quando sobe autonomia (era o gap da revisão); meta/textos preservados.

### B5. Playbook por chat (S2.5)
- **msg1:** "pausa anúncio que custa mais de R$ 50 por venda" → eco em linguagem de gente ("pausar anúncio quando o custo por venda passar de R$ 50").
- **msg2:** "sim". **Verificar (DB):** `pnpm db:q "select scope, when_json, then_json, then_action_type, enabled, priority from playbook_rules where agent_id='AGENT_ID' order by priority desc"` → regra criada (org-scoped, prioridade = fim da fila); `audit_log` com `action` de playbook + contato.
- **listar/desligar/remover:** "lista minhas regras" (numeradas com id) → "desliga a regra 1" (eco+confirma) → "remove a regra 1" (eco+confirma).
- **Aceite:** CRUD por chat com eco+confirma; org-scoped; bump de `config_changed_at`.

### B6. Identidade (S2.6)
- "seu tom passa a ser mais direto e objetivo" → eco de mudança de tom → "sim" → `agents.tone` atualizado.
- "usa esse prompt: <texto>" (`set_system_prompt`) → eco avisa **"isso substitui a metodologia do arquétipo"**.
- texto vazio ("limpa a persona") → volta ao arquétipo (`null`).
- **Aceite:** persiste; o aviso de substituição de metodologia aparece.

### B7. Kill-switch (S2.3)
- **Ação:** `pnpm db:q "update agents set autonomy_policy = jsonb_set(coalesce(autonomy_policy,'{}'), '{autoConfigViaChat}', 'false') where id='AGENT_ID'"`.
- **msg:** "muda a meta pra R$ 90" → o agente responde que **config é pelo site** (a tool de config nem entra na allowlist).
- **Verificar:** operação segue funcionando — "qual o status da conta?" responde normal; "analisa agora" dispara.
- **Reverter:** setar de volta `'true'` (ou remover a chave).
- **Aceite:** OFF bloqueia config por chat (inclui listar playbook), não bloqueia operação.

### B8. describe_capabilities (S2.7)
- **msg:** "o que você consegue fazer?" → resposta reflete o **contexto real**:
  - leitura sempre; **mexer nas campanhas** só se `guardrail_configs.allowed_actions` permitir (senão "desligado nos guardrails");
  - **config por chat** só se kill-switch ON (senão "pelo site");
  - autonomia por origem em PT ("com o playbook eu ...; com sugestões de IA eu ...");
  - "ainda não: criar campanhas".
- **Concierge** (org com ≥2 contas ativas, sem foco): resposta geral + pede pra focar.
- **Aceite:** honesto ao estado (cruze com `guardrail_configs.allowed_actions` + kill-switch do `AGENT_ID`).

### B9. Foco troca a config (multi-conta)
- Org com ≥2 contas: "foca na <Conta B>" → **no próximo turno** a voz/`allowedActions`/kill-switch passam a ser os do agente da Conta B (ex: `describe_capabilities` muda).
- **Aceite:** a config acompanha o foco a partir do turno seguinte.

---

## 4. Casos negativos / edge (correções da revisão + §8)

- **E1. Ambíguo → pergunta.** "melhora a config" / "deixa mais agressivo" → o agente **pergunta** o que mudar; **não** aplica nada. `messages` sem confirmação/escrita.
- **E2. Pendência expirada (TTL ~30 min).** Proponha uma mudança, espere >30 min, responda "sim" → "não tenho nada pendente / expirou"; nada persiste.
- **E3. Config + escrita Meta no MESMO turno (fix C).** "muda a meta pra R$120 e pausa a Campanha X" → o agente responde **"me peça uma de cada vez"** — a ação na campanha **não** é engolida em silêncio.
- **E4. Guard de frescura (fix D).** msg1: "afrouxa o blast radius pra 40%" (não confirme ainda) → em outra aba, mude o guardrail pelo site (ex: ligue o kill-switch de budget/entidades) → msg2: "sim" → o agente **aborta**: "sua configuração de segurança mudou desde que preparei isso — me pede de novo". (Também: desligar `autoConfigViaChat` entre propor e confirmar → aborta.)
- **E5. `custom` sem id.** "usa uma conversão personalizada como meta" (sem dizer qual) → o agente pede **qual** conversão (não inventa).
- **E6. Arquétipo inválido.** "vira o arquétipo turbo" → lista os arquétipos válidos.
- **E7. No-op.** "muda a meta pra <valor atual>" → "isso já está assim — não mudei nada".

---

## 5. Segurança / multi-tenancy (transversal)

- **S1. Eco+confirma sempre.** Nenhuma escrita de config/playbook/Meta aplica sem o "sim". Reveja `messages`: todo apply foi precedido de um eco.
- **S2. Auditoria.** Toda escrita de config/playbook gravou `audit_log` com `actor='contact:<id>'` + `metadata.channel='whatsapp'`.
- **S3. Org-scoping.** Toda query de config/playbook filtra por org. Cross-tenant: um `ruleId` de outra org em toggle/remove → "não achei essa regra" (não vaza / não altera).
- **S4. Config ≠ escrita Meta.** As tools de config **não** passam por `allowed_actions` (config funciona mesmo com a escrita Meta desabilitada nos guardrails).

---

## 6. Evidência automatizada (determinística) — já verde

`pnpm typecheck` (17 pacotes) + `pnpm test` cobrem minuciosamente as camadas puras:
- core: `quality`, `tracking`, `waste`, `benchmarks`, `analysis-guards` (scale/kill/tracking),
  `agent-config` (+ `config-echo`), `message`, `brief`, `funnel` — inclui o caso Steticos,
  o money-shot, a frequência por estágio, o eco de config e o afrouxamento.
- ads-meta: `meta-audience-map` (público neutro).
- worker: `whatsapp-conversation` (tools/nodes/turn), `conversation/config-writes`, `vision/resolver`.
- api: `modules/agents` (paridade da camada compartilhada), `runs`, `dashboard`.
Total ~636 testes verdes. Estes são o "passo a passo determinístico" sem custo/efeito externo.

---

## Apêndice — comandos úteis

```bash
# custo do período (LLM) por tipo:
pnpm db:q "select type, count(*), round(sum(cost)::numeric,4) usd from usage_events where created_at > now() - interval '2 hours' group by type order by usd desc"
# últimas mensagens da conversa:
pnpm db:q "select direction, left(body,140) body, created_at from messages order by created_at desc limit 10"
# estado de config do agente:
pnpm db:q "select archetype, goals, autonomy_policy, persona, tone from agents where id='AGENT_ID'"
pnpm db:q "select * from guardrail_configs where agent_id='AGENT_ID'"
# trilha de auditoria recente:
pnpm db:q "select actor, action, target, metadata, created_at from audit_log order by created_at desc limit 10"
```

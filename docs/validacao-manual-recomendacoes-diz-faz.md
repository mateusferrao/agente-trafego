# Validação manual — Iniciativa "qualidade das recomendações + gap diz×faz"

> Roteiro **integrado** das Fatias **A→E** (branch `claude/recomendacoes-qualidade-diz-faz`). Objetivo:
> confirmar que a análise virou **honesta e acionável** — o que o agente **diz** que dá pra fazer, ele
> **faz** (aprovável por site+chat), e o que não dá, ele é honesto. Cada seção tem **pré**, **passos** e
> **✅ esperado** (UI + banco). Banco de verificação abaixo; conta de referência = a que você conecta.
>
> **Regra de ouro (§8):** NADA de escrita real na Meta auto-aplica sob risco — ressalva de escala e
> `adjust_audience` **sempre** exigem OK humano, mesmo em `act_full`.

## 0. Setup

1. `pnpm install && pnpm db:migrate` (DB local — **nunca** apontar pro Postgres de produção).
2. `pnpm dev` (api + worker + web). Conecte uma conta Meta **ativa** (token System User) via onboarding.
3. Crie um agente (arquétipo **Otimizador** ou **Vigia** — já vêm proativos). Deixe a cadência on-demand.
4. Rode uma análise (chat "analisa agora" **ou** botão on-demand no site).

Queries úteis (psql):
```sql
-- último run + recomendações agrupadas por formato
select id, status, trigger, created_at from agent_runs order by created_at desc limit 3;
select kind, title, tool_key, risk_level, ressalvas is not null as tem_ressalva
  from recommendations where run_id = '<RUN_ID>' order by created_at;
-- pendências aprováveis (fonte da verdade do inbox)
select id, action_type, status, (payload_actions->0->'ressalvas') as ressalvas
  from approvals where org_id = '<ORG>' and status = 'pending';
```

---

## Fatia A — Ressalva de escala (aprovável-com-ressalva, nunca auto)

**Pré:** conta com um vencedor escalável cujo escalar tenha algum risco (fadiga de criativo, sem base
estatística, teto de audiência, CPA marginal piorando, ou hipótese não-confirmada).

**Passos:** rode a análise numa conta com um vencedor que dispare um dos 5 gates de escala.

**✅ Esperado:**
- A recomendação de escalar **NÃO** é rebaixada pra "investigar" — ela **continua aprovável** (`kind='platform_action'`, `tool_key='adjust_budget'`), mas com **`ressalvas` preenchido** (`recommendations.ressalvas` não-nulo).
- No **card** (site) e no **push** (WhatsApp), a ação aparece com o aviso **⚠️** (ex: "⚠️ público pode estar saturado").
- **Nunca auto-aplica**, mesmo com autonomia `act_full`: a ação vai pra `approvals(status='pending')`, não pra `agent_tool_calls` aplicado. (Escala **limpa**, sem ressalva, segue a autonomia normal.)
- Os **2 guards de SEGURANÇA** ainda rebaixam pra "investigar" (hard): matar-em-aprendizado e corte por CPA de venda com tracking suspeito.

---

## Fatia B — Push detalha TODAS as sugestões + oferece as aprováveis

**Pré:** um run que gerou recomendações de vários tipos (aprováveis + direções + observações).

**Passos:** deixe o push do run chegar no WhatsApp (ou leia a mensagem do run).

**✅ Esperado:** a mensagem detalha TODAS agrupadas, com cabeçalhos:
- **"Posso fazer agora — responda 'pode' (ou aprove no site):"** → as aprováveis (com ⚠️ nas com ressalva).
- **"Sua direção (você aplica):"** → `human_direction` (ex: revisar criativo).
- **"Observei:"** → `insight` (leituras sem ação).
- Mesmo num run **só-playbook** ou com **LLM degradado**, se há aprovável ele oferece "responde pode" (não some).

---

## Fatia C — Editar público (`adjust_audience`) end-to-end

### C-gate — opt-in default OFF (honestidade)

**Pré:** agente recém-criado (sem ligar nada extra).

**Passos:** rode a análise numa conta cujo analista sugira revisar o público de um adset.

**✅ Esperado (capacidade OFF):** a recomendação `review_audience` fica **consultiva** (`kind='human_direction'`) — o agente **não** promete editar. Em **Ações permitidas** (site) `adjust_audience` aparece **desligado** por padrão.

### C-on — vira ação real quando ligada

**Pré:** em **Ações permitidas** (site) OU no chat, **ligue** `adjust_audience` (opt-in). Conta com adset de público "errado" (amplo/desalinhado).

**Passos:** rode a análise de novo.

**✅ Esperado:**
- A recomendação vira **`platform_action`** com `tool_key='adjust_audience'`, `proposedAction` carregando o público novo (`params.targeting` = `explicit`), `risk_level='high'`.
- Só vale pra **adset** (público mora no adset); `review_audience` de campanha/anúncio segue consultivo.
- Aparece no inbox de **Aprovações** (`approvals kind='action' action_type='adjust_audience'`).

### C-edit — editável antes de aprovar

**Passos:** no card de aprovação do `adjust_audience`, clique **"Editar público"**.

**✅ Esperado:** abre o **editor completo** (geo/idade/gênero/interesses/comportamentos/públicos salvos, com busca na Meta) semeado com o público **proposto**; um **aviso** de que editar **reinicia o aprendizado** da Meta. Editar + **"Salvar público"** → o card reflete o novo público (a ação segue pendente).

### C-approve — aprovar por site OU chat (nunca auto)

**Passos:** aprove (site: "Aprovar"; ou chat: "pode"/`approve <id>`).

**✅ Esperado:**
- O apply-service re-checa fresco + escreve o `targeting` do adset na Meta; `agent_tool_calls` grava o **before_state** com o targeting **cru** anterior (revert fiel).
- **Nunca** auto-aplica: mesmo com autonomia `act_full`, `adjust_audience` sempre exige OK (confirme que sem aprovar nada é escrito).
- **Revert** (dentro do TTL) reposta o público anterior. *(Aviso: o reset de aprendizado em si é irreversível — o Roy avisa; o revert coarse não detecta edição concorrente de público — fast-follow.)*

---

## Fatia D — Criação proativa sempre detectada (sem config)

**Pré:** um agente **Conservador** (que antes NÃO recebia criação proativa) — a config `proactiveDrafts` foi removida.

**Passos:** rode a análise numa conta com um vencedor claro (escalar) OU sem campanha ativa (cold_start).

**✅ Esperado:**
- Mesmo no **Conservador**, o agente detecta a oportunidade e **propõe** (card aprovável: escalar/duplicar/criar) — `recommendations kind='platform_action'` + rascunho/approval.
- **Nunca auto-aplica** sem autonomia: Conservador (autonomia conservadora) só gera o **card**; nada é criado/ativado sozinho. Throttle: **1 proposto proativo pendente por conta**.
- Em **Notificações** (site) **não existe mais** o toggle "Propor campanhas por conta própria" (removido).
- No chat, pedir "desliga a proposta de campanha" → o agente NÃO oferece esse toggle (não existe).

### D-editar×duplicar (regra determinística, C5)

**✅ Esperado:** **underperformer com público errado → editar** (`adjust_audience`, adset); **vencedor que saturou o público → duplicar** para expansão (nova campanha, criativo reusado). Gatilhos distintos, não colidem; **nunca pausa a campanha original em silêncio**.

---

## Fatia E — Qualidade do squad na análise

**Passos:** leia o texto da análise (síntese) + o mapa por campanha de um run.

**✅ Esperado (qualidade, não regressão):**
- **Escala:** quando propõe escalar um vencedor, o raciocínio segue o método (vertical em passos ~20%/48–72h, não subir demais de uma vez; horizontal p/ público novo; teto por público). Não escala o não-provado nem sem criativo pronto.
- **Refresh de criativo:** a direção de fadiga cita cadência (público pequeno ~5–7 dias / grande ~14–21 dias; trocar com 2+ sinais).
- **Scorecard 8-dim (interno):** a recomendação de topo prioriza pelo **maior vazamento** da conta (o `headline`/`biggestLeak` lidera por ele) — **sem** um placar dimensão-a-dimensão novo na UI (schema inalterado).
- **Revisor = editor-chefe:** a saída revista é mais enxuta/segura (corta o inseguro, respeita os vetos), sem inventar achado novo. Degradação graciosa se o revisor falhar (usa o analista + nota parcial).
- **Benchmarks:** CTR/frequência de cold-start usam o default de plataforma fiel ao squad (CTR 0,9/1,5/2,5%; freq 2,5) — nunca declarados como "meta batida".

---

## E2E REAL executado (IA + Meta de produção)

Além dos testes automatizados, a iniciativa foi validada com **LLM de produção + Meta real** (conta de
teste "Org de Teste 366" / BM Automato), DB local isolado (docker), revertendo toda mudança real.

**Fixtures reusáveis** (`apps/worker/e2e-dizfaz-*.ts`, rodar com `npx tsx --env-file=<env> <fixture>.ts`):
- `e2e-dizfaz-analysis.ts` — análise real (My QuickStart): qualidade, grounding, **anti-alucinação**
  (todo alvo de recomendação cruzado contra as 1290 entidades reais), ressalva, criação proativa (D).
- `e2e-dizfaz-chat.ts` — chat real (Grafo B): não-alucinação, faz-o-que-fala, direção/clareza, erro
  amigável em entidade inexistente, "aprova" vazio sem inventar aprovação, escrita redirecionada.

**Resultado:** análise de **qualidade exemplar + honesta** (identifica gargalos reais com números
reais, nunca alucina alvo); chat **honesto** (redireciona/nega o que não faz, não inventa). Escrita
real na Meta **confirmada** persistindo + revertendo fielmente: `adjust_budget` (R$50→R$60→revert) e
`adjust_audience` (idade 18-65 → 33-58 → **revert fiel** do público cru).

**Achados corrigidos** (revelados só pelo stack real de produção):
- **Revisor (gemini-3.7-flash) exige reasoning** e rejeitava nosso `reasoning:{enabled:false}` → o passe
  do editor-chefe falhava sempre e a análise degradava pra parcial. **Fix:** retry sem o param.
- **Unit model degenerava em JSON lixo** sem fallback de parse (só de rede) → campanha descartada.
  **Fix:** fallback pro modelo reserva em falha de parse.
- **Fast-follow documentado:** auto-retry de escrita no rate-limit #613 (hoje degrada gracioso).

## Encerramento

- `pnpm test` (todos os packages) + `pnpm typecheck` + `pnpm --filter web build` **verdes**.
- Fast-follows registrados em `docs/ROADMAP.md`; decisões em `CLAUDE.md`; conhecimento do squad em `docs/referencia-traffic-masters.md`.

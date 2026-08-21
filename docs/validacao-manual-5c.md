# Validação manual 5c (escrita livre + leitura rica + foco pelo WhatsApp)

Percurso: **pedir uma mudança em linguagem natural** → o agente ecoa o que vai fazer →
**confirmar** → aplicar inline → conferir a trilha → **desfazer** → leitura rica → **foco
multi-conta**. Comandos copy-paste (**PowerShell**, Windows). SQL via **`pnpm db:q "<SQL>"`**.

> **Inbound:** use **(A) POST simulado** (local, recomendado) ou **(B) mensagem real** (exige a
> Evolution alcançar a `API_ORIGIN` — túnel local) — igual à `docs/validacao-manual-5b-2.md §0`.
> O **outbound (resposta) é REAL** no WhatsApp do contato verificado.

⚠️ **Escreve na Meta de verdade.** Faça numa conta de teste. Ligue `dry_run` (passo 4) se quiser
ensaiar sem impacto.

---

## 0. Setup

```powershell
pnpm db:migrate
pnpm db:seed
pnpm dev
```
- Migrations novas: `0015` (agent_tool_calls: run_id nullable + agent_id) e `0016`
  (conversations.focused_account_id).
- Pré-requisitos (fatias 3b/5b-2): instância Evolution conectada, **contato verificado**, e a
  conta com **1+ campanha ativa já analisada** (rode uma análise antes — o agente resolve a
  campanha pelo nome via `get_campaign_analysis`, que lê `entity_analyses`).
- Guardrail do agente com as ações permitidas (Agente → Guardrails → "ações permitidas"):
  ```powershell
  pnpm db:q "select allowed_actions, max_budget_change_pct, dry_run, kill_switch from guardrail_configs;"
  ```

---

## 1. Escrita livre — pausar (eco + confirma + aplica inline)

No WhatsApp (ou POST simulado), mande: **"pausa a campanha <NOME>"**.

- ✅ O agente responde com o **eco concreto**: `Vou pausar a campanha *<NOME>*. Confirma?`
- Responda **"sim"** → resposta **na mesma conversa**: `✅ Pausei <NOME>.`
- Conferir a trilha (sem linha em `approvals`; com `agent_tool_calls` + `audit_log`):
  ```powershell
  pnpm db:q "select tool_key, run_id, agent_id, (args->>'dryRun') dry from agent_tool_calls order by created_at desc limit 3;"
  pnpm db:q "select action, target from audit_log order by created_at desc limit 3;"
  ```
  Esperado: `run_id` **null**, `agent_id` preenchido, `tool_key='pause_entity'`.
- Conferir na Meta (Ads Manager) que a campanha ficou pausada.
- Mande **"desfaz isso"** (guardado p/ o passo 5) OU reative manualmente antes de seguir.

## 2. Escrita livre — budget absoluto ("põe em R$X")

Mande: **"põe o budget da <NOME> em R$200 por dia"** (use um valor DENTRO do teto de % — ver §4
p/ o clamp).

- ✅ O eco mostra o **antes → depois** real: `...budget da campanha *<NOME>*: R$ 100,00 → R$ 200,00/dia. Confirma?`
- "sim" → aplicado; conferir no Ads Manager o valor exato.

## 3. Lote (várias ações, 1 confirmação)

Mande: **"pausa a <A> e reduz 10% o budget da <B>"**.
- ✅ Eco em lista numerada + `Confirma as 2?`. Um **"sim"** aplica as duas.
- Se uma falhar, a resposta diz **✅ numa / ❌ na outra** (falha parcial explícita).

## 4. Guardrail + shadow (dry-run)

- **Enforcement por allowedActions:** desmarque "ajustar budget" nas ações permitidas do agente
  (site) e mande "aumenta o budget da <NOME>". Esperado: o agente **recusa na hora** ("não faço
  isso por aqui" / não oferece a ação) — não ecoa uma ação que não pode cumprir.
- **Clamp de budget:** com teto de 20%, mande "põe o budget da <NOME> em R$1000" (bem acima).
  Esperado: o eco diz que **passou do limite** e propõe o valor clampado.
- **Shadow:** ligue `dry_run` (Agente → Guardrails). Mande "pausa a <NOME>" → "sim". Esperado:
  `🧪 Simulei ... (dry-run, não apliquei de verdade)` e **nada muda** na Meta.
  ```powershell
  pnpm db:q "select tool_key, (args->>'dryRun') dry from agent_tool_calls order by created_at desc limit 1;"
  ```
  Desligue `dry_run` depois.

## 5. Desfazer (revert por chat)

Depois de aplicar algo real (passo 1/2), mande **"desfaz isso"** (ou "desfaz a pausa da <NOME>").
- ✅ O agente usa `find_recent_actions`, ecoa `Vou desfazer a pausa de *<NOME>* (volta ao estado anterior). Confirma?`
- "sim" → `✅ Desfeito.` Conferir no Ads Manager que voltou ao estado anterior.
- **Drift:** mude a campanha manualmente no Ads Manager e tente desfazer → o agente avisa que a
  entidade mudou e **não sobrescreve** (pede confirmação explícita "mesmo assim").
- **Honestidade:** peça pra desfazer algo que você fez **direto no Ads Manager** (não pelo agente)
  → esperado: "não achei uma ação minha nessa campanha pra desfazer".

## 6. Recusa a ambiguidade / mudança de ideia

- Mande "pausa a campanha" (sem nome, com 2+ campanhas) → o agente **pergunta qual** (não age).
- Peça uma ação, receba o eco, e responda **"não"** → `Ok, não mexi em nada.`
- Peça uma ação, receba o eco, e mude de assunto ("quanto gastei ontem?") → o agente **larga a
  pendência** e responde a nova pergunta (não aplica).

## 7. Leitura rica

- "como foi essa semana vs a passada?" → `compare_periods` (gasto atual × anterior + variação %).
- "como o gasto da <NOME> evoluiu?" → `get_entity_detail` (tendência diária).
- "como você tá configurado?" → `get_agent_config` (objetivo/autonomia/guardrails).
- "por que você sugeriu <recomendação>?" → `explain_recommendation` (motivo + risco).

## 8. Foco multi-conta (só se a org tiver 2+ contas ativas)

- Sem foco, mande "pausa a campanha X" → o agente pede pra **focar numa conta**.
- "foca na <CONTA Y>" → `Ok, foquei na conta <Y>...`
  ```powershell
  pnpm db:q "select focused_account_id from conversations order by created_at desc limit 1;"
  ```
- Agora "pausa a campanha X" → o eco **nomeia a conta**: `Vou pausar a campanha *X* (<Y>). Confirma?`
- Peça algo de outra conta → o agente pergunta se quer focar nela (nunca age cross-conta em silêncio).

## 9. Custo (metering)

Cada turno do chat gera `usage_events` type `conversation` (custo pode chegar assíncrono):
```powershell
pnpm db:q "select type, model, cost, created_at from usage_events where type='conversation' order by created_at desc limit 3;"
```

---

## Checklist
- [ ] pausar/reativar/status por chat com eco+confirma, aplicado inline
- [ ] budget %-e-absoluto; clamp honesto no eco
- [ ] lote com 1 confirmação + falha parcial
- [ ] enforcement por allowedActions (recusa upfront) + shadow (dry_run)
- [ ] desfazer (última + por nome) + drift + honestidade
- [ ] ambiguidade pergunta; "não"/mudança larga a pendência; TTL (~30 min)
- [ ] leitura rica (4 tools)
- [ ] foco multi-conta (eco nomeia a conta; cross-conta pergunta)
- [ ] trilha: agent_tool_calls (run_id null, agent_id set) + audit_log, SEM approvals

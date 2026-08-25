# Validação manual — Postura de comunicação + narrativa no site + pulso "resumo do dia"

Fatia: 3 eixos de postura (diretividade/volume/profundidade) + preset de experiência,
voz única (push/chat/pulso/site), rótulo de CPA honesto e pulso P2. Cobre caminhos
felizes **e** tristes. Marcações: ✅ = executado automaticamente no E2E docker desta
sessão; 🧑 = requer credenciais reais (Meta/OpenRouter/Evolution) — operador roda.

## Pré-requisitos
- `docker compose -f docker/docker-compose.yml up -d` (postgres + redis).
- `pnpm db:migrate` (aplica `0031_*` posture + `0032_*` narrative).
- `.env` com `DATABASE_URL`/`REDIS_URL` locais + (p/ passos 🧑) token Meta, `OPENROUTER_API_KEY`, Evolution.
- `pnpm dev` (api+worker+web) ou `pnpm --filter @trafego/api start`.

## E2E automatizado nesta sessão (resultados)
- ✅ Migrations aplicam limpo; `agents.posture` jsonb NOT NULL default conservador
  (`{directiveness:consultative, volume:balanced, didacticDepth:explanatory, experienceLevel:null}`)
  e `agent_runs.narrative` text presentes no Postgres real.
- ✅ API sobe contra pg+redis reais (`/ready` → `{db:true, redis:true}`); composição wira todo o código novo.
- ✅ `/openapi.json` expõe `posture`, `postureAxes`, `experienceLevels`, `postureIsCustom`,
  `cpaLabel`, `narrative` e os enums (`consultative`/`directive`/`comprehensive`/`explanatory`).
- ✅ Suíte completa verde: core 337, worker 287, api 100, agent-config 9, demais pacotes.
- ✅ `tokens:check` do web sem token hardcoded.

### Executado AO VIVO (LLM OpenRouter real + leitura Meta real; sem push, sem escrita na Meta)
Script efêmero via `buildComposition()` do worker (removido após rodar).
- ✅ **Postura muda a voz (push, LLM real)** — mesmos dados de análise, posturas opostas:
  - *consultivo·abrangente·didático*: texto longo, 5 pontos numerados, explica termos, tom "sugiro/recomendo… como prefere seguir?".
  - *diretivo·enxuto·direto*: curto, imperativo ("Pausar imediatamente a CAMP-Z"), sem básico.
  → volume, diretividade e profundidade **visivelmente** diferentes com a MESMA base.
- ✅ **Leitura Meta real** (`getFreshMetricsData`, ontem+hoje) — token da conexão (DB) descriptografado; conta de dev sem gasto no período → **erro amigável** ("não tenho dados de … entre …"), sem crash: valida o **caminho triste (Meta sem dado)** + a degradação.
- ✅ **Pulso P2 voiceado** (LLM real) — declara o período + ressalva "dados de hoje ainda consolidando", lidera pelos números (gasto/CPA/CTR/Δ%), traz as recs que seguem valendo, na voz/postura escolhida.
- ✅ **Config de postura por HTTP autenticado** (Postgres real): `GET /agents/archetypes` traz postureAxes/experienceLevels; `GET agent` traz posture+postureIsCustom; `PUT posture experienceLevel=advanced` semeia os 3 eixos (consultivo/enxuto/direto, custom=false); `PUT volume=comprehensive` → custom=true; `GET` confirma persistência.
- ✅ **Auto-config de postura por CHAT (LLM real, Grafo B, entrega stubbed):** comando explícito → `set_volume` → eco "volume: Abrangente → Enxuto — Confirma?" → "sim" → aplica (DB=concise). Queixa VAGA ("sugestão demais") → após o fix, dispara a tool + eco+confirma (aplica), estável em 2 rodadas.
- ✅ **Fluidez de entrega (pipeline F4, sanitize+split+typing):** balões escaneáveis; nudge "Tem mais N — quer ver?" coerente no enxuto.

### Achados do E2E ao vivo — CORRIGIDOS (foco em qualidade)
1. **Redator em parede de texto** (push abrangente = parágrafo corrido de ~520c): `VOICE_RULES` reforçado (uma sugestão por linha, condicional à quantidade). Verificado: vira lista escaneável; enxuto = 1 bullet coerente com o nudge.
2. **Auto-config afirmava mudança sem chamar a tool** (queixa vaga → "já ajustei" com DB inalterado = mentira): system-prompt endurecido (config só muda via tool; proibido afirmar sem tool+confirmação; queixa de comunicação → chama a tool ou pergunta). Verificado ao vivo.
3. `metering:falhou` no 1º script: `orgId` não-uuid — bug do script de teste, não do produto.

### Bloqueado por infra (não por código)
- 🧑 **Envio real no WhatsApp**: a instância Evolution está `state:"close"` (número offline — reconectar exige QR humano). A pipeline F4 (o que define *como chega*) foi validada; só o hop de rede da Evolution não roda aqui.

---

## 1. Config de postura no site (Slice 6)
Rota `/accounts/:id/agente`, seção **"Como o agente se comunica com você"**.

**Feliz:**
1. 🧑 Abrir a seção → ver a linha "Definido pelo arquétipo…" e os 3 presets (Iniciante/Intermediário/Avançado).
2. 🧑 Clicar **Avançado** → modal de preview aparece descrevendo o que muda (diretividade→consultivo, volume→enxuto, profundidade→direto) → **Usar perfil** → toast "Perfil de comunicação salvo"; a linha vira "Perfil Avançado".
3. 🧑 Abrir **"Personalizar cada eixo"** → mudar Volume p/ Abrangente → **Salvar ajustes** → toast; a linha vira "Perfil Avançado (com ajustes)".
4. 🧑 Recarregar a página → o estado persiste (Avançado + com ajustes; Volume=Abrangente).

**Triste:**
5. 🧑 Clicar um preset e **Cancelar** no modal → nada muda (sem toast, sem save).
6. 🧑 Trocar o **arquétipo** → modal menciona que reseta persona/tom/método/autonomia/notificações **e a postura**; confirmar → a postura volta ao default do arquétipo (perfil "definido pelo arquétipo").
7. 🧑 Derrubar a API e tentar salvar → erro amigável (sem stack), Save reabilita.

## 2. Voz no push da análise + volume determinístico + nudge (Slice 3)
🧑 Requer run real (Meta+LLM).
1. 🧑 Agente com Volume=**enxuto** → "analisa agora" numa conta com ≥2 recomendações materiais → o push **lidera com 1** sugestão + linha "Tem mais N sugestão(ões) — quer ver?".
2. 🧑 Volume=**abrangente** → o push lidera com até 5.
3. 🧑 Profundidade=**direto** → a mensagem usa CPA/adset sem explicar; **didático** → explica os termos.
4. 🧑 Diretividade=**diretivo** → "faça X"; **consultivo** → apresenta opções.
5. 🧑 Sobrescrever o `system_prompt` (metodologia) → a **postura continua valendo** (bloco à parte).

## 3. Voz no chat + auto-config + describe_capabilities (Slice 5)
🧑 Requer Evolution + LLM.
1. 🧑 No WhatsApp: "o que você faz?" → `describe_capabilities` lista a linha "🗣️ Como eu falo com você agora (perfil …): diretividade …, volume …, profundidade …".
2. 🧑 "tá me dando sugestão demais" → o agente **OFERECE** deixar mais enxuto (não muda sozinho); ao confirmar, eco+confirma → aplica (Volume=enxuto).
3. 🧑 "me diz o que fazer, não sei decidir" → oferece subir a diretividade.
4. 🧑 "configura como iniciante" → `set_experience_level` → eco antes→depois dos 3 eixos → confirma → aplica.
5. 🧑 Kill-switch `autoConfigViaChat` OFF → o agente diz que config é pelo site (não aplica).

**Triste:** 6. 🧑 Pedido ambíguo ("muda teu jeito") → o agente pergunta antes (não chama tool no escuro).

## 4. Narrativa voiceada no site (Slice 4)
1. 🧑 Após um run, abrir o detalhe da conta → o topo mostra a **narrativa voiceada** (fala do agente), com os cards estruturados neutros abaixo.
2. 🧑 Run **on-demand pelo site** também gera narrativa (render sempre).
3. Fallback: em run antigo sem `narrative`, o site cai no `summary` neutro (✅ lógica coberta por teste; 🧑 visual).

## 5. Rótulo de CPA honesto (Slice 2.5)
1. 🧑 Agente com conversão de negócio = **venda** → faixa da conta e cards mostram "Custo por venda".
2. 🧑 Conversão = **lead** → mostra "Custo por lead" (não "venda").
3. 🧑 Sem conversão de negócio mensurável → "Custo por resultado" (genérico) — nunca "venda" mentiroso.

## 6. Pulso P2 "resumo do dia" (Slice 7)
🧑 Requer Meta+LLM+Evolution; pulso ligado (`notify_policy.pulse`).
1. 🧑 Disparo do pulso **de manhã** → o resumo cobre "ontem (fechado) + hoje até agora" (não vazio), ressalvando que hoje ainda consolida.
2. 🧑 Voz/postura aplicadas (ex: enxuto → curto; didático → explica).
3. 🧑 Recs que "seguem valendo" do último run aparecem (capadas pelo volume).
4. **Triste — conta nova (sem run):** 🧑 o pulso mostra os números frescos + "me peça uma análise pra recomendações".
5. **Triste — Meta fora:** 🧑 degrada pra narrativa persistida do último run (ou recap determinístico), com nota.
6. **Dedupe:** 🧑 se o cron acabou de empurrar (<6h), o pulso pula (não cola dois avisos).
7. **Alerta intocado:** 🧑 o alerta de mudança material continua D-1 (não vira intradiário).

## 7. Regressão / zero-config
- 🧑 Agente **sem tocar em nada** → postura = conservador (consultivo/equilibrado/didático) → mensagens seguem "sem jargão" como antes (não regride o ICP não-técnico).
- ✅ Agentes existentes (linhas pré-migração) → `DEFAULT_POSTURE` de coluna (fallback defensivo no summary/worker).

## Comandos de verificação estática
```bash
pnpm typecheck && pnpm test && pnpm --filter web tokens:check && pnpm api:generate
```

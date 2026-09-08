# Roteiro de validação manual — Gestor autossuficiente no chat

> Fatia "gestor autossuficiente no WhatsApp": paridade recomendação→chat + qualidade + flip da
> escrita conversacional (`TRAFEGO_CHAT_ADS_WRITES` default ON). Cobre **caminhos felizes** e
> **caminhos tristes** (estressando o eco+confirma, guardrails e as falhas parciais). Use uma
> **conta de teste Meta** (entidades PAUSED, reverta o que aplicar). O agente é o **Roy**.

## Pré-requisitos
- Org beta com conexão Meta válida (token System User), 1 conta ativa com campanhas/adsets/anúncios.
- Instância Evolution conectada (QR), 1 contato **verificado** (número que já mandou 1ª msg).
- Worker + api rodando; `pnpm dev`. Redis + Postgres de pé.
- Env: `TRAFEGO_CHAT_ADS_WRITES` **ausente** (default ON) para os testes de escrita; setar `=false`
  no teste do freio de emergência (D1-6).
- Bindings do agente: para os testes de **editar público** (A1) e **realocar** (A4), ligar
  `adjust_audience` e `adjust_budget` na tela "Ações permitidas" do agente (opt-in).

---

## Slice 0 — Vídeo inbound (o bug que motivou a fatia)

| # | Passo | Esperado (feliz) |
|---|-------|------------------|
| 0.1 | Mandar um **vídeo normal** no DM do Roy, sem legenda | Vídeo entra na **biblioteca de criativos** (aparece no site); log `media_enqueued kind:"video"` → `intake:saved`. Nenhum silêncio. |
| 0.2 | Mandar um vídeo **view-once** (visualização única) | Idem 0.1 — entra na biblioteca. |
| 0.3 | Mandar uma **nota redonda** (PTV / vídeo curto redondo) | Idem — reconhecido como vídeo. |
| 0.4 | Mandar um vídeo **como documento** (anexo mp4) | Idem — `documentMessage` com mimetype `video/*` tratado como vídeo. |

**Caminhos tristes:**
| # | Passo | Esperado |
|---|-------|----------|
| 0.5 | **Reagir** com emoji a uma mensagem do Roy (`reactionMessage`) | **Silêncio total** — nenhuma resposta, nenhum job de mídia. |
| 0.6 | Evento de protocolo (recibo de leitura, `pollUpdate`) | Silêncio. Log de diagnóstico `inbound:ignored (unparseable)` com as **chaves** de `message` (sem conteúdo) — observabilidade, não resposta. |
| 0.7 | Vídeo corrompido/sem mídia baixável | Sem crash; degrada com log; não trava a fila. |

## Slice 0b — Reasoning mandatório (LLM)
| # | Passo | Esperado |
|---|-------|----------|
| 0b.1 | Rodar 2 turnos de chat com um modelo que **exige reasoning** | 1ª chamada auto-cura (retry sem o param); 2ª chamada **omite `reasoning` upfront** (sem 400 + WARN repetidos). Log só 1× o WARN. |

---

## Bloco B — Criativo / mídia por chat

| # | Passo | Esperado (feliz) |
|---|-------|------------------|
| B.1 | Mandar uma **imagem com legenda** "o que acha desse criativo?" | Imagem **salva na biblioteca** E dispara um **turno multimodal**: o Roy responde analisando o criativo (método do squad — gancho/clareza/prova), texto natural, não formulário. Síncrono. |
| B.2 | Mandar um **vídeo com legenda** "analisa esse" | Roy responde "recebi, tô processando"; quando o poll fecha (`ready`), a análise/oferta sai de volta (assíncrono). Vídeo na biblioteca. |
| B.3 | Pedir explicitamente "analisa meu criativo" (sem mídia nova, referindo a um enviado) | `analyze_creative_media` roda direto (pedido explícito). |
| B.4 | Mandar imagem **sem legenda** | Salva na biblioteca; sem turno de análise (não perturba). |

**Caminhos tristes:**
| # | Passo | Esperado |
|---|-------|----------|
| B.5 | Mandar um **print de dashboard** (não-criativo) com pergunta | Roy responde à pergunta sem decompor como criativo (não força análise de anúncio). |
| B.6 | Mandar imagem, e no turno seguinte mandar texto | A imagem do turno anterior **não** é reenviada ao modelo (stripHistoricalImages) — sem custo/erro de checkpointer. |

---

## Bloco A — Paridade recomendação → chat

### A1 — Editar público de adset vivo (`edit_audience`, opt-in)
| # | Passo | Esperado (feliz) |
|---|-------|------------------|
| A1.1 | Com `adjust_audience` LIGADO no binding: "muda o público do conjunto X pra BH e região, 25-45, interesse em corrida" | Roy resolve os nomes→ids, **ecoa o novo público** ("vou trocar o público de *X* para: …") + **aviso de reset de aprendizado** + "Confirma?". Nada aplicado ainda. |
| A1.2 | Responder "sim" | Aplica na Meta (ou simula se dry-run). Aviso de mudança real no WhatsApp. |
| A1.3 | "desfaz isso" (revert) | Reposta o público cru anterior (se ninguém editou no meio — ver D4). |

**Caminhos tristes:**
| # | Passo | Esperado |
|---|-------|----------|
| A1.4 | Com `adjust_audience` **DESLIGADO** no binding: pedir a edição | Roy recusa honesto ("editar público está desligado para este agente") — a tool nem chega ao modelo, ou o guardrail barra. |
| A1.5 | Pedir edição de público **ambígua** ("público melhor") sem especificar | Roy **pergunta** o essencial, não aplica em incerteza. |
| A1.6 | Interesse que não resolve na Meta ("interesse em xyzabc") | Eco lista "(não achei: xyzabc)"; aplica o que resolveu; honesto. |
| A1.7 | Responder "sim" 40 min depois (TTL expirou) | Não aplica às cegas; pede reconfirmação. |

### A4 — Realocar orçamento A→B (saga com compensação)
| # | Passo | Esperado (feliz) |
|---|-------|------------------|
| A4.1 | Com `adjust_budget` ligado: "tira R$ 50/dia da campanha A e põe na B" | Roy ecoa: A cai pra X, B sobe pra Y + "Confirma?". |
| A4.2 | "sim" | Aplica as duas pernas; reporta os dois novos orçamentos. |

**Caminhos tristes:**
| # | Passo | Esperado |
|---|-------|----------|
| A4.3 | Pedir mover um valor que **estoura o teto** de blast-radius (ex: 50% com teto 20%) | Roy avisa que respeitando o teto só move o máximo seguro (clamp balanceado), ecoa o valor reduzido. |
| A4.4 | Pedir mover um valor que **esvaziaria a origem** | Recusa: "isso esvaziaria *A*… me diz um valor menor". |
| A4.5 | Origem sem orçamento no nível (CBO) | "não consegui ler o orçamento diário de *A*… pode estar em outro nível". |
| A4.6 | **Falha parcial** (simular: destino falha após origem descer — ex: token perde escopo no meio, ou rate-limit no destino) | Roy **devolve** o orçamento da origem e diz "não consegui aumentar *B*, devolvi o de *A*, no fim nada mudou". |
| A4.7 | **Falha dupla** (destino falha E devolução falha) | Roy reporta **estado parcial explícito** com ⚠️: "*A* está com R$X/dia agora — dá uma olhada no site". Nunca silêncio. Log `realloc:compensação falhou`. |

### A2/A3 — Oportunidades + consultivas acionáveis
| # | Passo | Esperado |
|---|-------|----------|
| A2.1 | "onde tem oportunidade?" logo após um run | Roy surfa as oportunidades de CRIAÇÃO/escala do **último run** (não re-roda detector). |
| A2.2 | "onde tem oportunidade?" com a conta sincronizada DEPOIS do último run | Roy oferece "analisa agora" (`trigger_analysis`) — o dado está velho. |
| A3.1 | Recomendação consultiva `review_audience` no chat | Roy aponta o `edit_audience` (se ligado) como próximo passo. |

---

## Bloco C — Lookup de criativo (C3)
| # | Passo | Esperado |
|---|-------|----------|
| C3.1 | "me mostra o criativo 'promo natal'" (por nome) | Roy resolve por nome (`resolveNamedMatch`) e mostra a leitura curada. |
| C3.2 | Nome ambíguo (2 criativos parecidos) | Roy desambigua ou lista as opções. |
| C3.3 | Nome inexistente | Empty-state honesto ("não achei um criativo com esse nome"). |

---

## Bloco D — Robustez

### D2 — Dedupe atômico de messageId
| # | Passo | Esperado |
|---|-------|----------|
| D2.1 | Forçar entrega dupla do mesmo webhook (mesmo `messageId`) | Processa **1 vez só** (SET NX no Redis); a 2ª é descartada. 1 resposta do Roy. |
| D2.2 | Redis indisponível no claim | Degrada com log; não duplica silenciosamente nem trava (verificar o comportamento definido). |

### D3 — Auto-retry rate-limit
| # | Passo | Esperado |
|---|-------|----------|
| D3.1 | Aprovar uma ação numa conta com **throttle estrito** (rate-limit #613) | O apply-job re-lança `rate_limited` → BullMQ retenta com backoff; a idempotency_key evita duplo-apply. Auto-recupera sem intervenção. |

### D4 — Drift fino de público no revert
| # | Passo | Esperado |
|---|-------|----------|
| D4.1 | Editar o público (A1), **ninguém mais mexe**, depois "desfaz" | Reverte (o público que escrevemos continua no ar — contenção OK, apesar da Meta enriquecer o read-back). |
| D4.2 | Editar o público, **editar de novo no Gerenciador** (concorrente), depois "desfaz" | **Barra por drift**: "o público do conjunto mudou desde a edição". Não sobrescreve em silêncio. |
| D4.3 | Após D4.2, "desfaz mesmo assim" (force) | Reverte forçado. |

### D1 — Eco+confirma + freio de emergência
| # | Passo | Esperado |
|---|-------|----------|
| D1.1 | Qualquer escrita ("pausa a X") | SEMPRE eco + "Confirma?" antes de tocar na Meta. |
| D1.2 | Responder "não"/"deixa" | "Ok, não mexi em nada." |
| D1.3 | "sim" sem nada pendente | "Não tenho nada pendente pra confirmar (ou já expirou)." |
| D1.4 | Referência **ambígua** ("pausa a campanha") com várias campanhas | Roy pergunta qual, não aplica. |
| D1.5 | Ação com **ressalva de escala** (ex: escalar com fadiga de criativo) | Fica aprovável mas **nunca auto-aplica**, mesmo em autonomia alta — sempre pede OK. |
| D1.6 | Setar `TRAFEGO_CHAT_ADS_WRITES=false` e pedir uma escrita | **Nenhuma** tool de escrita/criação/refino no toolset — Roy diz que mexer na campanha é no site. Consulta + approve/reject + revert + auto-config seguem. |

### Guardrails (sempre, mesmo com escrita ON)
| # | Passo | Esperado |
|---|-------|----------|
| G.1 | Ação de um tipo **não permitido** no binding | Recusa honesta com motivo. |
| G.2 | `killSwitch` ligado | Nada passa. |
| G.3 | `dryRun` ligado | Eco avisa "Modo simulação"; não escreve de verdade. |
| G.4 | Mudança de budget acima do **blast radius** | Clampa ao teto, eco honesto ("você pediu X, seu teto é Y%"). |
| G.5 | 2ª mudança de budget na mesma entidade no mesmo dia | Barra (anti-compounding "budget já ajustado hoje"). |

---

## Vídeo no WhatsApp — 413 + análise dos bytes + memória (Slices 1-3)

> Iniciativa que fechou o bug de produção do **413** (mídia > 1 MB rejeitada no webhook) e somou:
> Roy analisa o vídeo **dos nossos bytes** (sem o desvio pela Meta) e **lembra** do criativo por
> descrição depois. Pré: além do padrão, um **grupo** configurado (espelho do número) p/ o teste de
> @menção, e os envs `OPENROUTER_VIDEO_MODEL` (um modelo video-capable — **verificar ao vivo**) +
> `WHATSAPP_VIDEO_MODEL_MAX_MB` (default 20) e `CREATIVE_MAX_WHATSAPP_VIDEO_MB` (default 50).

### S1 — Fix do 413 (webhook aceita mídia base64)
| # | Passo | Esperado (feliz) |
|---|-------|------------------|
| S1.1 | Mandar um **vídeo ~5–10 MB** no DM do Roy | Webhook responde **200** (não 413); o vídeo entra na biblioteca. Antes: `statusCode:413` na api, worker sem logs. |
| S1.2 | Mandar uma **imagem grande** (~3 MB) e um **áudio longo** | Ambos passam (200) e são processados. |

**Caminhos tristes:**
| # | Passo | Esperado |
|---|-------|----------|
| S1.3 | Mandar um vídeo **acima de `CREATIVE_MAX_WHATSAPP_VIDEO_MB`** (ex: 80 MB, se o limite é 50) | Webhook ainda aceita o corpo (o `bodyLimit` = limite × inflação base64 + folga), mas o intake **recusa honesto** ("grande demais… sobe pela biblioteca no site"). Nunca 413 nem silêncio. |
| S1.4 | Payload maior que o `bodyLimit` derivado (bem acima do teto) | 413 legítimo (proteção); as **demais rotas** seguem no 1 MB default (superfície pública menor). |

### S2 — Roy analisa o vídeo dos nossos bytes (sem esperar a Meta)
| # | Passo | Esperado (feliz) |
|---|-------|------------------|
| S2.1 | No **grupo**, mandar um vídeo **marcando o Roy** (@menção ou reply) | Ack imediato "analisando seu vídeo…"; em seguida o Roy responde de fato (movimento/áudio/gancho — vídeo COMPLETO ao modelo, não frames), **sem esperar** o upload pra Meta. Vídeo entra na biblioteca em paralelo. |
| S2.2 | No **DM**, mandar um vídeo **com legenda** ("o que acha desse?") | Idem — a legenda vira a pergunta; resposta dos nossos bytes. |
| S2.3 | Vídeo entre `WHATSAPP_VIDEO_MODEL_MAX_MB` e `CREATIVE_MAX_WHATSAPP_VIDEO_MB` (ex: 30 MB) | Grande p/ análise ao vivo, mas o intake salva → Roy diz "**guardei na biblioteca** e a análise sai por lá" (promessa honesta). |

**Caminhos tristes:**
| # | Passo | Esperado |
|---|-------|----------|
| S2.4 | Vídeo **acima de `CREATIVE_MAX_WHATSAPP_VIDEO_MB`** marcando o Roy | Roy **não** promete biblioteca (o intake rejeita) → "grande demais… sobe pela biblioteca no site". |
| S2.5 | Vídeo no grupo **sem** marcar o Roy | Silêncio (só responde quando dirigido — §9). |
| S2.6 | Modelo de vídeo indisponível / falha ao analisar | Aviso honesto ("tive um problema pra analisar agora — guardei na biblioteca"); nunca silêncio. **Verificar ao vivo** que o `OPENROUTER_VIDEO_MODEL` de fato consome `video_url`. |

### S3 — Memória / recuperação por descrição
| # | Passo | Esperado |
|---|-------|----------|
| S3.1 | Depois de mandar um vídeo (S2), perguntar "**o que você achou daquele vídeo da praia?**" | Roy casa pela **descrição** (visão cacheada) e traz a decomposição (gancho/ângulo/corpo/CTA/prova/forças/fraquezas). |
| S3.2 | "e **o último** criativo que te mandei?" | Traz o mais recente da conta (recência). |
| S3.3 | Referência que **não bate** com nada ("o vídeo do foguete", sem ter mandado) | Empty-state honesto ("não achei um criativo que bata com isso — descreve melhor?"); **não** traz o errado. |
| S3.4 | Vídeo cuja análise de **chat degradou** (grande/sem bytes) mas a **biblioteca** analisou | O recall **ainda acha** (busca as duas chaves de visão — chat + biblioteca). |
| S3.5 | Conta **sem** criativos guardados | "você ainda não tem criativos guardados nessa conta — me manda um que eu analiso." |

### S6b — Foco por menção explícita (escrita em grupo multi-conta num turno só)
> Pré: org com **≥2 contas ativas**, grupo configurado, `resume_entity`/`set_status` ligados em
> "Ações permitidas" do agente + `dryRun` off. Sem foco salvo no fio (ou expirado).

| # | Passo | Esperado |
|---|-------|----------|
| S6b.1 | "@Roy ativa a campanha CaquiAI - Lead da **conta Automato**" (conta nomeada, inequívoca) | Num turno só o Roy **ecoa** "vou ativar *CaquiAI - Lead* na conta *Automato* — confirma?" (SEM o ida-e-volta "confirme a conta"); "sim" aplica. Antes: caía em concierge e oferecia recomendação. |
| S6b.2 | Depois do eco, responder "**sim**" | Aplica (o foco ficou salvo → o turno de confirmação opera in-context). |
| S6b.3 | Org com 2 contas cujos nomes **ambos aparecem** na frase | **Ainda pergunta** qual conta (ambíguo → concierge; trava preservada). |
| S6b.4 | Nome de conta **inexistente**/nenhum citado | Concierge honesto (pede a conta) — comportamento atual. |
| S6b.5 | Conta nomeada existe mas **sem agente ativo** | Não foca; segue no concierge (não opera numa conta sem agente). |
| S6b.6 | `TRAFEGO_CHAT_ADS_WRITES=false` + conta nomeada | **Nenhuma** escrita entra mesmo focando (freio de emergência intacto). |
| S6b.7 | Conta de nome curto/palavra comum (ex.: "Vendas") + frase que só menciona a palavra ("budget de vendas") | **Não** foca automaticamente (defere pro `set_focus`/LLM) — evita focar a conta errada por uma palavra qualquer. Nome distintivo/multi-palavra/id → foca. |

### S7 — Ativação em cadeia + entrega efetiva (a Meta não cascateia status)
> Pré: conta com escrita ligada (`resume_entity`/`set_status`), `dryRun` off, uma campanha **pausada** com conjuntos/anúncios também pausados.

| # | Passo | Esperado |
|---|-------|----------|
| S7.1 | "ativa a campanha X" (campanha com 2 conjuntos + 5 anúncios pausados) | Eco: "Vou reativar a campanha *X*" + "Também vou ligar 2 conjuntos e 5 anúncios pausados dela — senão ela não veicula" + "Confirma?". "sim" → liga a árvore inteira → **veicula**. Antes: ligava só a campanha e não rodava. |
| S7.2 | "ativa só o conjunto Y" | Liga só Y + os anúncios pausados dele (granularidade por nó). |
| S7.3 | "pausa só o anúncio Z" | Pausa **só** ele (pausar não cascateia). |
| S7.4 | Árvore acima do teto de nº-de-entidades/dia | Eco avisa "são M entidades, acima do seu teto de N/dia — como você confirma, ligo todas" e liga tudo (ativação confirmada é intenção única; teto segue valendo só pro automático). |
| S7.5 | "como está a campanha X?" com a campanha ativa mas filhos pausados | "ativa, mas **não está entregando** (conjuntos/anúncios pausados)" — não diz só "ativa". Oferece ligar a cadeia. |
| S7.6 | Campanha **sem anúncio** nenhum → "ativa a campanha X" | ⚠️ "não vai veicular assim (essa campanha não tem anúncio) — mesmo ligada, não roda até ter anúncio ativo". |
| S7.7 | Leitura da árvore falha (Meta lenta) | Degrada: liga só o nó pedido (não trava a ação); status sem afirmar entrega. |

---

## Teste simulado E2E (passo a passo, traçado no código)

> Cada cenário abaixo foi **traçado pelo código real** (funções + retornos por passo), simulando o
> percurso ponta-a-ponta. `✓` = comportamento confirmado no trace. Não substitui o teste manual com
> Meta/Evolution ao vivo (§acima), mas prova a coerência do fluxo.

### E2E-1 — Vídeo inbound (o bug que motivou a fatia)
Entrada: webhook `MESSAGES_UPSERT` com `message.viewOnceMessageV2.message.videoMessage`.
1. `webhook-inbound` valida o secret por-instância → enfileira o payload cru. ✓
2. `parseInbound(raw)` → `unwrapMessage` desce por `viewOnceMessageV2` (depth 1, < cap 6) → acha `videoMessage` → `extractVideo` (`videoMessage ?? ptvMessage`) → `{kind:"video", messageKey, caption}`. **Antes: `null` → silêncio.** ✓
3. `claimInbound(redis, inst, msgId)` (`SET NX`) → `true` (1ª vez) → segue. ✓
4. Branch `kind==="video"` → `recordMessage` + `mediaIntakeQueue.add` (sem `suppressNotice` — vídeo não é asQuestion) → log `media_enqueued kind:"video"`. ✓
5. `whatsapp-media-intake` grava na **biblioteca** + sobe pra Meta. Vídeo aparece no site. ✓
- **Ruído (`reactionMessage`)**: `unwrapMessage` não casa nenhum `WRAPPER_NODES` → `extractVideo/Image/Audio`=null → `detectMediaType`=null → `parseInbound`=null → **silêncio**. ✓ (teste `reactionMessage → null`).
- **Patológico (12 wrappers)**: unwrap para em `depth>=6` → nó ainda embrulhado → sem mídia conhecida → `null` → silêncio (sem loop). ✓ (teste novo).

### E2E-2 — Imagem-pergunta (B3, síncrona)
Entrada: `imageMessage` + `caption:"o que acha desse criativo?"` + base64 inline.
1. `parseInbound` → `{kind:"image", caption, image:{base64}}`. ✓
2. `asQuestion = image && caption>0 && base64>0` → `true`. ✓
3. `mediaIntakeQueue.add({suppressNotice:true})` → a imagem **é salva na biblioteca** (o `ingest` roda antes do `return` de suppressNotice — sem oferta). ✓
4. `stashPendingMedia(redis, conv, {dataUrl})` + `pushInbound(caption)` + `scheduleConversationFlush`. ✓
5. Flush → `buildTurnMessage` monta `HumanMessage` multimodal (texto + `image_url` data-url) → `MEDIA_QUESTION_SECTION` (kernel de criativo) injetada no prompt → o Roy responde analisando (o modelo vê a imagem). ✓
6. Turno seguinte (texto): `stripHistoricalImages` remove o conteúdo de imagem das HumanMessages anteriores → não reenvia a imagem. ✓

### E2E-3 — A1 editar público (feliz + opt-in OFF)
Pré: binding `adjust_audience` LIGADO, flag ON. "muda o público do conjunto Alpha pra BH, 25-45, corrida".
1. `allowedChatWriteTools`: `enabled.has("adjust_audience")` → `edit_audience` no toolset. ✓
2. LLM chama `edit_audience({adsetId, adsetName:"Alpha", geo:["BH"], ageMin:25, ageMax:45, interests:["corrida"]})`.
3. `routeConversation` → `confirm` (é `EDIT_AUDIENCE_TOOL_NAME`). ✓
4. `confirmWriteGate` branch `editCall`: `loadWriteContext` → `resolveProposedExplicitTargeting` resolve nomes→ids (corrida→id via `searchInterests`) → monta `Action{type:"adjust_audience", params:{targeting}}`, `riskForAction("adjust_audience")="high"` → `applyGuardrails` (allowed) → `mutate(dryRun:true)` → **eco** "vou trocar o público de *Alpha* para: … ⚠️ reinicia o aprendizado … Confirma?" + `pendingWrite:{actions:[clamped]}`. Nada escrito. ✓
5. "sim" → `applyWrite` (não-saga) → `applyCheckedAction` (re-check guardrail fresco) → aplica/simula → aviso de mudança real. ✓
- **Opt-in OFF**: binding `adjust_audience` desligado → `edit_audience` **não** entra no toolset → o Roy não oferece; se forçado, `applyGuardrails` dropa ("ação adjust_audience não permitida"). ✓

### E2E-4 — A4 realocação A→B (feliz + falha parcial)
Pré: binding `adjust_budget` ON. "tira R$ 12/dia da Alpha (R$100) e põe na Beta (R$60)", teto 20%.
1. `reallocate_budget` no toolset (`enabled.has("adjust_budget")`). `routeConversation`→confirm. ✓
2. Gate `reallocCall`: `loadWriteContext` → `fromCur=10000, toCur=6000` (centavos). `requestedMinor=1200`. `maxMovableMinor = floor(0.2·min(10000,6000)) = 1200`. `moveMinor=1200` (não clampa). `legFrom=set 8800`, `legTo=set 7200`. `applyGuardrails([legFrom,legTo])` → ambas allowed & `unchanged` → dry-run → eco "Alpha cai pra R$ 88,00; Beta sobe pra R$ 72,00. Confirma?" + `pendingWrite.saga={sourceKey:"campaign:Alpha", sourceRestoreMinor:10000}`. ✓
3. "sim" → `applyWrite` → `pending.saga` → `runReallocationSaga`:
   - `applyLeg(legFrom, baseCtx)` → applied. ✓
   - `applyLeg(legTo, ctxTo={touchedToday+Alpha})` → applied → `{kind:"done"}` → reporta os 2 novos orçamentos. ✓
- **Falha parcial (destino falha)**: `legTo`→`failed` (rate-limit no destino) → saga monta `compensation=set 10000` com `compCtx{budgetAmountByEntity[Alpha]=10000}` (clamp 0%) e `touchedToday` sem Alpha (anti-compounding não barra) → `applyLeg(compensation)` → applied → `{kind:"compensated"}` → "não consegui aumentar *Beta*, devolvi o de *Alpha*, no fim nada mudou". ✓ (teste `reallocation-saga`).
- **Falha dupla**: `legTo` e `compensation` falham → `{kind:"partial"}` → ⚠️ "*Alpha* está com R$ 88,00/dia agora — olhe no site" + `logger.error`. Nunca silêncio. ✓
- **Teto**: pedir mover R$ 50 → `maxMovableMinor=1200` → `moveMinor=1200<requested` → eco com nota "respeitando seu teto de 20%, movo R$ 12,00". ✓
- **Esvaziaria**: `requestedMinor≥fromCur` → "isso esvaziaria *Alpha*… valor menor". ✓

### E2E-5 — D4 revert de público com drift
1. Editou o público (A1) → tool_call `adjust_audience` com `result.after.targeting={geo_locations:{countries:["BR"]}}`. ✓
2. "desfaz" → `revert` → `detectRevertDrift`: `toolKey==="adjust_audience"` → `readAdSetTargeting` (current). 
   - **Sem drift**: current = read-back enriquecido `{countries:["BR"], location_types:[…]}` → `targetingChanged(current, after)` = `false` (contenção: "BR" ∈ current) → **reverte**. ✓ (não falso-positiva pela normalização da Meta — o fix da revisão).
   - **Com drift** (editaram pra US): current `{countries:["US"]}` → "BR" ∉ current → `true` → **barra** `blockedByDrift`. ✓
   - **force**: pula o re-check → reverte. ✓

### E2E-6 — D1 eco+confirma + freio de emergência
1. Qualquer escrita → `routeConversation`→confirm → eco+"Confirma?" (bateria prova: TODA write/create/refine/edit/realloc/revert→confirm; só confirm/cancel→apply). ✓
2. "sim" sem pendência → `applyWrite`: sem `pendingDraft/config/revert/write/saga` → "Não tenho nada pendente pra confirmar". ✓
3. `TRAFEGO_CHAT_ADS_WRITES=false` → `buildInContextAllow` com `chatAdsWrites:false` → `writeTools=[]`, refino fora → só consulta+approve/reject+revert+config. ✓ (teste turn.ts). 
4. Config + edição no mesmo turno ("muda a meta e edita o público") → `alsoMetaWrite` agora inclui `edit_audience` → "me peça uma de cada vez" (não some com a edição). ✓ (fix da revisão).

### E2E-7 — Fix do 413 (Slice 1)
Entrada: Evolution POSTa `/webhooks/evolution/:instanceId` com a mídia em **base64 no corpo JSON** (ex: vídeo 6 MB → ~8 MB de corpo).
1. A rota tem `bodyLimit: WEBHOOK_BODY_LIMIT_BYTES = webhookBodyLimitBytes(env.CREATIVE_MAX_WHATSAPP_VIDEO_MB)`. Default 50 → `ceil(50·4/3 + 4) = 71 MB`. O corpo de 8 MB < 71 MB → Fastify **bufferiza + parseia** (antes: default 1 MB → **413 antes do handler**, worker sem logs). ✓
2. `evolutionWebhookBody.parse` + secret por-instância no service → enfileira o cru. 200. ✓
3. Demais rotas **não** recebem o override → seguem no 1 MB (superfície pública menor). ✓ (teste `body-limit`: dimensionamento por MB + inflação + folga).

### E2E-8 — Vídeo-pergunta analisado dos NOSSOS bytes (Slice 2)
Entrada: no grupo, `videoMessage` + `contextInfo` com @menção ao bot (ou reply), `fileLength=6 MB`.
1. `parseInbound` → `{kind:"video", group:{...}, caption}`; roteador de grupo confirma que é **dirigido**. `claimInbound` (`SET NX`) → 1ª vez. ✓
2. `webhook-inbound`: `videoQuestion = kind==="video" && (ref.kind==="group" || caption>0)` → `true` → enfileira `buildCreativeVideoAnalyzeJob({orgId, ref, messageKey, mimetype, caption, fileLength})` **e** o intake com `suppressNotice:true` (Meta em background p/ biblioteca) + **ack** `VIDEO_ANALYZING_NOTICE`. ✓
3. `creative-video-analyze` (`makeVideoAnalyze`): probe `fileLength(6MB) ≤ videoModelMaxBytes(20MB)` → não degrada. `fetchMediaBase64` → bytes → `contentHash = mediaBytesContentHash(bytes)`. ✓
4. `vision.resolve({videoUrl:"data:video/mp4;base64,…", contentHash, meta:{orgId}})` → cache-miss → `completeStructured` roteado ao `videoModel` (input tem `videoUrl`), `meta:{orgId,type:"vision"}` (metrado — fix da revisão) → grava a decomposição sob `contentHash`. ✓
5. `llm.complete` (messageModel, `meta:{orgId,type:"message"}`) redige na voz do Roy → `sendToConversation`. ✓
6. Em paralelo o intake `ingestCreativeVideo` grava `creative_assets.vision_content_hash = mediaBytesContentHash(bytes)` (**mesma chave** do passo 4) → o asset fica ligado à decomposição p/ o recall. ✓
- **20–50 MB**: `oversizeNotice(size)` → `size ≤ libraryMaxBytes` → `NOTICE.tooBigForModel` ("guardei na biblioteca…") — honesto, o intake salva. ✓ (teste).
- **> 50 MB**: `size > libraryMaxBytes` → `NOTICE.tooLargeForLibrary` ("…sobe pela biblioteca no site") — o intake rejeita, não promete biblioteca. ✓ (teste). Probe por `fileLength` aponta o site **antes** de baixar. ✓
- **Sem bytes / visão null / erro do LLM**: `NOTICE.noBytes` / `NOTICE.failed`. Nunca silêncio. ✓ (testes).

### E2E-9 — Memória: recall por descrição (Slice 3)
Entrada (dias depois): "o que você achou daquele vídeo da praia?".
1. LLM chama `recall_creative({reference:"o vídeo da praia"})`. ✓
2. `recallCreativeData`: `select` os 30 assets mais recentes da conta (`orgId + adAccountId + isNull(archivedAt)`, ordem recência). ✓
3. Por asset, `candidateHashes = [visionContentHash (bytes, se ≠ lib), libraryCreativeContentHash(id)]` → `select creative_vision_analyses in (todos os hashes)` → `visionFor(a)` usa a que existir (prefere a de chat, mais rica). **Dual-hash** cobre o vídeo cuja análise de chat degradou mas a biblioteca fez. ✓ (teste `recallCreativeData`).
4. `enriched` = assets COM análise. `pickCreativeByReference(llm, messageModel, "o vídeo da praia", candidates, {orgId, type:"message"})` (metrado — fix Slice-3) casa pela descrição; **-1 → null** (não chuta). ✓
5. Retorna a decomposição (`summary/hook/angle/body/cta/proofStrength/persuasionSignals/strengths/weaknesses/score`) → o Roy responde. ✓
- **"o último"** (sem referência clara) → `reference=null` → recência (1º asset com análise). ✓
- **Nada casa / erro do matcher** → `match:"none"` honesto. ✓
- **Sem asset / sem análise** → empty-states distintos ("me manda um que eu analiso"). ✓

## Critérios de aceite (resumo)
- Mídia (vídeo/imagem grande/áudio) nunca mais retorna 413; o webhook aceita o base64 e as demais rotas seguem em 1 MB.
- Vídeo-pergunta é analisado dos NOSSOS bytes (vídeo completo), sem esperar a Meta; degradação sempre com aviso honesto (nunca promete biblioteca quando o intake não salva).
- A análise do criativo é durável e recuperável depois por descrição/recência (dual-hash: chat + biblioteca).
- As chamadas de LLM da iniciativa (visão do vídeo + matcher de recall) são metradas por org (§11).
- Vídeo inbound nunca fica em silêncio; ruído de protocolo nunca gera resposta.
- Toda escrita na Meta passa por eco+confirma; nenhuma auto-aplica sob risco.
- A realocação A→B nunca deixa a conta num estado parcial silencioso.
- O revert de público nunca sobrescreve uma edição concorrente sem avisar.
- O freio de emergência (`TRAFEGO_CHAT_ADS_WRITES=false`) desliga toda a escrita conversacional.
- `pnpm typecheck` + `pnpm test` verdes; `reviewing-trafego-changes` sem bloqueadores.

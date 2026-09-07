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

## Critérios de aceite (resumo)
- Vídeo inbound nunca fica em silêncio; ruído de protocolo nunca gera resposta.
- Toda escrita na Meta passa por eco+confirma; nenhuma auto-aplica sob risco.
- A realocação A→B nunca deixa a conta num estado parcial silencioso.
- O revert de público nunca sobrescreve uma edição concorrente sem avisar.
- O freio de emergência (`TRAFEGO_CHAT_ADS_WRITES=false`) desliga toda a escrita conversacional.
- `pnpm typecheck` + `pnpm test` verdes; `reviewing-trafego-changes` sem bloqueadores.

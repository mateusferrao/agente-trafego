# Duplicação de campanha grande (limite síncrono da Meta) — design

> Design/spec. PT-BR, foco reuso/desacoplamento/SoC (CLAUDE.md §13). Corrige o
> `duplicate_scale` que falha em campanhas reais.

## Problema

`duplicateEntity` (packages/ads-meta/src/creation.ts:102) duplica campanha via
`POST /{id}/copies` com **`deep_copy=true` SÍNCRONO**. A Meta limita a cópia
síncrona a **< 3 objetos** (campanha+conjuntos+anúncios). Uma campanha real tem
≥3 → falha **sempre** (`code 100, subcode 1885194`). O `duplicate_scale` só
funciona pra campanhas mínimas.

## Descobertas do spike (Meta v26 real, BM-Automato — confirmado empiricamente)

1. `/copies` `deep_copy=true` síncrono → `subcode 1885194` ("cópia muito grande") pra ≥3 objetos.
2. **Sem opt-in async direto** no `/copies` (`async`/`is_async`/`async_deep_copy` ignorados).
3. `async_batch_requests` (o que a mensagem da Meta sugere) **NÃO aceita `/copies`** como
   `relative_url` (`subcode 1815379`) — caminho async descartado.
4. **`deep_copy=false` (casca) copia FUNCIONA** (1 objeto, síncrono) — retorna
   `copied_campaign_id`/`id` (o `copiedIdOf` já parseia).
5. **Reparent via `campaign_id`** no copy do conjunto **é aceito** pela Meta.
6. Criativo legado (`standard_enhancements`, `subcode 3858504`) → o `not_duplicable`
   que o código **já degrada** (creation.ts:49,122) — ortogonal ao tamanho.
7. `DELETE /{campaign}` reverte limpo (cascata).

## Objetivo

Duplicar campanhas de qualquer tamanho via **cópia rasa recursiva** (cada chamada
= 1 objeto, sempre < 3), reusando a saga `apply-draft` existente e a degradação
`not_duplicable` para criativos legados.

## Não-objetivos (YAGNI)

- Não usar async (`async_batch_requests` não suporta `/copies` — spike confirmou).
- Não mudar o gating/aprovação (o card + saga já existem).
- Não resolver o criativo legado (`not_duplicable` já degrada; fora do escopo).

## Design — cópia rasa recursiva

O `duplicateEntity` de CAMPANHA passa a reconstruir a árvore com cópias RASAS
(`deep_copy=false` = 1 objeto por chamada), reparenteando por id:

1. **Casca da campanha:** `POST /{sourceCampaign}/copies` `deep_copy=false&status_option=PAUSED`
   → `newCampaignId`.
2. **Por conjunto** (enumera `GET /{sourceCampaign}/adsets?fields=id`): `POST /{sourceAdset}/copies`
   `deep_copy=false&status_option=PAUSED&campaign_id={newCampaignId}` → `newAdsetId`.
3. **Por anúncio** (enumera `GET /{sourceAdset}/ads?fields=id`): `POST /{sourceAd}/copies`
   `deep_copy=false&status_option=PAUSED&adset_id={newAdsetId}` → `newAdId`.

(O param de reparent do ANÚNCIO — `adset_id` — espelha o `campaign_id` do conjunto,
confirmado; a 1ª task de impl valida com 1 chamada.)

Cada `/copies` copia 1 objeto → **nunca** encosta no limite < 3. Falha em qualquer
nó (criativo legado, transitório, etc.) → **aborta a duplicação inteira e reverte**
(uma campanha copiada sem seus anúncios não é uma cópia útil) — ver §Tratamento de
erro. Nunca pula nó silenciosamente.

### Onde vive

- **Adapter `creation.ts` (vocabulário Meta):** `duplicateEntity` de campanha vira o
  algoritmo recursivo raso acima. `duplicateEntity` de ADSET/AD (níveis folha) já é o
  mesmo `/copies` raso — extrai um helper `shallowCopy(sourceId, reparentParam)`.
  Mantém o `DuplicateResult` neutro (`copiedId`, `childAdsetIds`, `childIds`).
- **Saga `apply-draft` (worker):** já tem os passos + `campaign_drafts.created_ids`
  pra retomada idempotente. O `created_ids` passa a rastrear o progresso da árvore
  (casca criada + conjuntos criados + anúncios criados) → um retry não re-copia o
  que já foi. Budget override + ativação seguem no `newCampaignId` (inalterados).
- **Core/shared:** contrato `DuplicateEntityInput`/`DuplicateResult` inalterado (o
  algoritmo é detalhe do adapter). `deep_copy` deixa de ser hardcoded.

### Governor / rate-limit

N cópias (1 + #adsets + #ads) por duplicação. O `MetaGovernor` (token-bucket
por conta) + jitter já cobrem; a saga é assíncrona (BullMQ), não bloqueia HTTP.

## Tratamento de erro (avisar + reverter)

Cópia recursiva pode falhar no meio da árvore. Regra: **sempre reverter os
parciais + avisar honesto por TIPO de erro** (nunca deixa campanha meio-montada,
nunca fica silencioso). O adapter **classifica** o erro num kind NEUTRO; a casca
escolhe a copy (voz do Roy) e a ação.

**1. Determinístico (não-reprocessável)** — `not_duplicable` (criativo legado,
`subcode 3858504`), entidade inválida:
- **Reverte** os parciais (DELETE da nova campanha, cascata) + roteia pro degrade
  `not_duplicable` que o código já tem ("2 saídas: recriar / subir budget").
- **Avisa:** "não consegui duplicar (o criativo é antigo e a Meta não deixa copiar)
  — dá pra recriar do zero ou subir o orçamento do vencedor." NUNCA "tenta de novo"
  (é determinístico — seria mentira).

**2. Transitório** — rate-limit (#613), 5xx, timeout:
- A saga (BullMQ) **retoma de onde parou** — `created_ids` por-nó garante que o
  retry NÃO re-copia o que já foi criado (§8 idempotência). Esgotou as tentativas →
  vira caso 3.

**3. Falha dura após parcial:**
- **SEMPRE reverte** (DELETE da nova campanha) → nada meio-montado na conta.
- **Avisa** via desfecho `failed` (Fatia 2): card + push no WhatsApp.
- **Borda:** se o DELETE de limpeza falhar → aviso honesto "criei parcialmente e não
  consegui limpar — tem a campanha X pausada, apague na plataforma" (nunca silencioso).

**Copy `failed` distingue determinístico × transitório:** hoje o `describeDraftOutcome`
`failed` diz genérico "tenta de novo" — mente pro caso 1. O adapter devolve o kind
(`not_duplicable` × `transient` × `failed`) e a casca escolhe a frase certa.

## Fatiamento

- **Fatia 1 — adapter:** `shallowCopy` helper + `duplicateEntity` de campanha
  recursivo (casca→conjuntos→anúncios) + abort-e-degrada no `not_duplicable`. Testes
  com o client mockado (fixtures das respostas `/copies` reais capturadas no spike).
- **Fatia 2 — saga:** `apply-draft` rastreia o progresso da árvore em `created_ids`
  (retomada idempotente) + revert dos parciais. Testes da saga com fixtures.

Cada fatia: typecheck + test + (revisar antes de commitar) + commit.

## Testes

- **adapter:** `shallowCopy` monta o `/copies` certo (deep_copy=false + reparent);
  `duplicateEntity` recursivo monta a árvore (mock: casca→2 conjuntos→1 anúncio cada);
  erro num nó → aborta + reverte (DELETE) + classifica o kind (`not_duplicable` ×
  `transient` × `failed`).
- **saga:** `created_ids` rastreia parciais; retry transitório não re-copia (resume);
  falha dura → revert (DELETE da nova campanha); DELETE de limpeza falho → aviso honesto.
- **core:** `describeDraftOutcome` `failed` distingue determinístico × transitório (copy certa por kind).

## Riscos / cuidados

- **Idempotência (crítico):** `/copies` não é idempotente — um retry SEM rastrear o
  progresso duplicaria objetos. O `created_ids` por-nó é a rede (§8 idempotência).
- **Reparent do anúncio (`adset_id`):** confirmado análogo ao `campaign_id`; validar
  com 1 chamada na 1ª task (o spike confirmou o do conjunto).
- **Criativo legado:** campanhas com `standard_enhancements` seguem `not_duplicable`
  (não é regressão — já era assim no deep_copy).

## Questões em aberto

Nenhuma — mecânica confirmada no spike; recursão-rasa-total decidida (previsível >
híbrido); abort-e-degrada no criativo legado decidido.

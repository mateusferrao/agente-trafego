# Transparência da aprovação — "diz × faz" no card de aprovação

> Design/spec. Fonte da verdade das DECISÕES de produto/UX desta feature. A
> implementação segue um plano derivado deste doc (writing-plans). PT-BR, foco
> reuso/desacoplamento/SoC (CLAUDE.md §13).

## Problema

Quando o usuário aprova uma recomendação no site (`/approvals`), o sistema:

1. **Não avisa ANTES** que, com a configuração atual do agente, aprovar pode
   **não ter efeito real** — o agente pode estar em **modo ensaio** (`dry_run`),
   a ação pode **não estar nas permitidas** (`allowed_actions`/bindings), a
   **trava total** (kill-switch) pode estar ligada, ou a **conta indisponível**.
2. **Não fecha o laço DEPOIS**: a API `resolve` só **enfileira** o apply
   (assíncrono); o site mostra um toast otimista ("aprovado, aplico em
   instantes") e o card some. O desfecho real (`applied` / `simulated` /
   `blocked` / `noop` / `failed`) é computado depois no worker
   (`apps/worker/src/workers/approval-apply.ts`) e empurrado **só pro WhatsApp**.
   Quem aprovou pelo site **nunca descobre** o que aconteceu.

Isso contradiz o princípio "diz × faz" (o agente deve ser honesto sobre o que
faz e não faz) e a UX do projeto (CLAUDE.md §13 — "sempre mostrar o que está
acontecendo" + "sempre o próximo passo").

Contexto que motivou: cards semeados em produção na conta BM-Automato
(`dry_run=true`, `allowed_actions=["pause_entity"]`) — aprovar `adjust_budget`/
`adjust_audience` seria **barrado** (não permitido) e um draft seria **simulado**
(ensaio), sem nada disso ficar claro na tela.

## Objetivo

O card de `/approvals` fica honesto nos **dois momentos**:

- **Antes:** avisa (ou bloqueia o botão, conforme a condição) sobre o que
  aconteceria ao aprovar.
- **Depois:** o card acompanha a aplicação (`aplicando…`) e mostra o **desfecho
  real** no próprio lugar.

Toda copy segue a **voz da marca** (Roy) — `docs/DESIGN.md §5`
(`BRAND_VOICE_KERNEL`) + `apps/web/DESIGN.md`: sentence case, "o que aconteceu +
próximo passo", status por tom+texto (nunca só cor), sem jargão.

## Não-objetivos (YAGNI)

- Não muda a **lógica de aplicação** nem o guardrail (só passa a **expor** o que
  já existe).
- Não adiciona re-proposta automática de aprovações expiradas (fast-follow
  existente).
- Não toca no fluxo de WhatsApp além de **reusar** as frases de desfecho como
  fonte única (o push já existe).
- Não cobre o resultado do RUN (a ação barrada aparecendo como "sugerida" +
  "barrada" no resultado da análise) — é um gap real, mas de outra superfície;
  fica fora deste escopo.

## Mapa dos bloqueios (fonte: código)

Ao aprovar (manual, site/WhatsApp), o `approval-apply.ts` chama
`applyConfirmedAction` (re-check fresco + guardrail atual + executor). Desfechos:

**Grupo 1 — conhecível ANTES (dá pra sinalizar no card):**
| Condição | Desfecho | Fonte |
|---|---|---|
| `dry_run` ligado | `applied` com `dryRun=true` → **simula**, sem escrita | `guardrails/index.ts:152` (aplicado na casca) |
| kill-switch ligado | `blocked` "kill switch ativo" | `guardrails/index.ts:90` |
| ação não permitida | `blocked` "ação X não permitida" | `guardrails/index.ts:100` |
| conta indisponível | `blocked` "conta indisponível" | `apply-confirmed-action.ts:97` |

**Grupo 2 — só no apply (vira desfecho DEPOIS):**
| Condição | Desfecho |
|---|---|
| entidade já no estado-alvo | `blocked` "já está neste estado" (`guardrails:108`) |
| `adjust_budget` em nível sem budget (CBO) | `blocked` "budget não está neste nível" (`guardrails:115`) |
| budget já ajustado hoje | `blocked` "budget já ajustado hoje" (`guardrails:121`) |
| cap de entidades/dia | `blocked` "limite de entidades/dia" (`guardrails:142`) |
| escrita real sem mudança | `noop` (`apply-confirmed-action.ts:69`) |
| token inválido / rate-limit / erro Meta | `failed` (executor lança) |
| teto de % de budget | **clampa** (aplica menos que o card diz), não bloqueia |

**Fora:** aprovação expirada (24h) → sai da lista.
**Nota:** a **ressalva** (Fatia A) trava só o AUTO-apply; aprovação manual
aplica normalmente (se permitido e fora do ensaio).

## Decisões de UX (batidas com o usuário)

**Antes — "misto por condição", todas explicadas:**
- `dry_run` ligado → **botão ATIVO** + aviso (dá pra testar o fluxo/registrar a
  simulação).
- ação não permitida / kill-switch / conta indisponível → **botão
  DESABILITADO** + motivo + próximo passo.

**Depois — "card vira aplicando… e mostra o resultado":**
- ao aprovar, o card **não some** → estado `aplicando…` → **polling** até o
  desfecho fechar → mostra o resultado no lugar.

## Arquitetura

### 1. Dado — desfecho persistido por aprovação (peça central)

Hoje o `approval-apply.ts` mapeia o desfecho pra `approvals.status`, mas de forma
**insuficiente pro site**: `applied` real e `simulated` (ensaio) viram os dois
`status="approved"` (indistinguíveis na linha); `failed` **mantém `pending`**
(parece nunca aprovada); `noop` vira `blocked` com motivo textual.

**Mudança:** nova coluna **`apply_outcome`** na `approvals` (enum, nullable):
`applied | simulated | noop | blocked | failed`. Semântica:
- Nula enquanto não aplicou (pendente sem tentativa OU aplicando).
- O worker grava em **cada ramo** do apply de AÇÃO (e análogo em draft/ativação).
- `failed` grava `apply_outcome="failed"` **mantendo `status="pending"`** (a
  aprovação continua reaprovável); reaprovar **zera** `apply_outcome` (nova
  tentativa) — o enfileiramento reseta o campo.
- `resolved_reason` continua guardando o motivo (barrado/erro).

Migration via `pnpm db:generate` (nunca SQL à mão — CLAUDE.md §13).

### 2. Copy de desfecho — fonte única (SoC / reuso-primeiro)

As frases de desfecho hoje vivem **inline** no `approval-apply.ts` (ex.: "Não
apliquei (X): {motivo}.", "Simulei a ação (X) (dry-run).", `appliedActionLine`).
Extrair um helper **puro** — `describeActionOutcome(action, outcome)` → texto na
voz do Roy — em `@trafego/core` (ou `@trafego/shared`), reusado por:
- `approval-apply.ts` (push WhatsApp — comportamento atual preservado),
- a API (devolve a mensagem pronta pro card).

Assim a "voz" fica **idêntica** nos dois canais e num só lugar.

### 3. API

`apps/api/src/modules/approvals/`:

- **Pending list** (`service.ts` / `schema.ts`) ganha, por item, os sinais do
  "antes" (derivados da guardrail config + enabled tools do agente da conta, já
  carregados por-conta no serviço):
  - `dryRun: boolean`
  - `killSwitch: boolean`
  - `actionAllowed: boolean` (o `type` está em `enabledActionTypes`?)
  - `accountAvailable: boolean` (`ad_accounts.status === "active"`)
- **Desfecho:** o card, após aprovar, precisa reler UMA aprovação já resolvida.
  `GET /approvals/:id` devolve `{ status, applyOutcome, resolvedReason,
  outcomeMessage }` (mensagem via `describeActionOutcome`). (Se já existir um
  getById na rota, estender; senão adicionar.)
- zod → OpenAPI → kubb (`pnpm api:generate`) — tipos Angular sem drift.

Fronteira: esses sinais são **informativos** (o gating real continua no apply —
o "antes" é honestidade, não autoridade). O botão desabilitado no front é UX; a
segurança segue no guardrail do apply.

### 4. Web

`apps/web/src/app/features/approvals/approvals-page.ts` (+ `action-format.ts`):

- **Antes (por card):**
  - `dryRun` → faixa de aviso (tom "warning" suave, texto claro), botão ATIVO.
  - `!actionAllowed | killSwitch | !accountAvailable` → botão **desabilitado** +
    linha de motivo + próximo passo (link pra config quando fizer sentido).
- **Depois:** ao aprovar, o item entra em estado local `applying` → o componente
  faz **polling** de `GET /approvals/:id` (~1,5s, teto ~30s) até `applyOutcome`
  não-nulo (ou `status` terminal):
  - `applied` → "Feito — {outcomeMessage}."
  - `simulated` → "Simulado (ensaio) — mostrei o que faria, sem mexer na conta."
  - `blocked` → "Não apliquei: {resolvedReason}."
  - `noop` → "Não precisei mexer — já estava assim."
  - `failed` → "{outcomeMessage} Dá pra tentar de novo." + botão volta a "Aprovar".
  - timeout → "Ainda aplicando — te aviso no WhatsApp." (fallback honesto).
- Rótulos/estados reusam `action-format.ts` (fonte única, já usado por
  mini-surface + timeline).

Verificação AOT obrigatória: `pnpm --filter web build` (não só typecheck).

### 5. Worker

`apps/worker/src/workers/approval-apply.ts`: em cada ramo, além do push atual,
gravar `apply_outcome` (+ reusar `describeActionOutcome`). Lógica de aplicação
**inalterada**. `failed` grava outcome mantendo `pending`.

## Copies (voz do Roy — rascunho, validar em `docs/DESIGN.md`)

**Antes:**
- Ensaio: "Modo ensaio ligado — aprovar aqui simula, não altera a conta. Desligue
  em limites de segurança quando quiser valer."
- Não permitida: "Essa ação não está nas ações permitidas deste agente —
  aprovar não teria efeito. Habilite em ações permitidas."
- Kill-switch: "Trava total ligada — o agente está impedido de agir nesta conta.
  Desligue em limites de segurança pra aprovar."
- Conta indisponível: "Esta conta está indisponível agora — não dá pra aplicar.
  Recheque a conexão."

**Depois:** ver §4 (reusa `describeActionOutcome`, mesma voz do WhatsApp).

## Fatiamento (sugerido pro plano)

- **Fatia 1 — "Antes":** API expõe os 4 sinais + web (faixa de ensaio, botão
  condicional) + toast honesto. Rápida, mata metade da confusão, sem migration.
- **Fatia 2 — "Depois":** migration `apply_outcome` + helper `describeActionOutcome`
  (extração + reuso no worker) + `GET /approvals/:id` com desfecho + web
  (`aplicando…` + polling + estados).

Cada fatia: `pnpm typecheck` + `pnpm test` (+ `pnpm --filter web build`) + commit;
ao fim, skill `reviewing-trafego-changes` + corrigir apontamentos.

## Testes

- **core/shared:** `describeActionOutcome` puro — um caso por desfecho/ação.
- **api:** pending list carrega os 4 sinais corretos (ensaio on/off, ação
  fora/dentro das permitidas, conta ativa/indisponível); `GET /:id` devolve o
  desfecho.
- **worker:** cada ramo grava o `apply_outcome` certo (`failed` mantém pending).
- **web:** card desabilita/ativa o botão por condição; estado `aplicando…` →
  desfecho (mock do polling).

## Riscos / cuidados

- **Deploy:** feature de 6 camadas + migration — precisa de deploy da branch pra
  valer em produção. O fatiamento reduz o blast por entrega.
- **Polling:** teto de tempo + fallback honesto evitam card preso em "aplicando…"
  se o worker atrasar (rate-limit #613).
- **Consistência de gates:** os sinais do "antes" DEVEM sair da MESMA fonte do
  gate do apply (`enabledActionTypes` + guardrail config) — senão o card promete
  diferente do que o apply faz.

## Questões em aberto

Nenhuma — decisões de UX batidas; arquitetura de dados definida.

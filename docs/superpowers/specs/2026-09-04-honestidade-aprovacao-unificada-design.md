# Honestidade da aprovação unificada nas 3 superfícies — design

> Design/spec. Fonte da verdade das DECISÕES desta feature. PT-BR, foco
> reuso/desacoplamento/SoC (CLAUDE.md §13). Continuação do trabalho "diz×faz"
> ([transparência da aprovação](2026-09-04-transparencia-aprovacao-design.md)).

## Problema

Existem **três superfícies** que renderizam aprovação, cada uma reimplementando o
card. As features de honestidade entraram uma de cada vez → **drift**:

| Superfície | Aviso ensaio/bloqueio (antes) | "Aplicando…"/desfecho (depois) | Ressalva (Fatia A) |
|---|:-:|:-:|:-:|
| `/approvals` — card de **ação** (`ApprovalOutput`) | ✅ | ✅ | ❌ |
| `/approvals` — card de **rascunho/ativação** (`draftApprovalOutput`) | ❌ | ❌ (otimista) | — |
| **Mini-surface** da conta (`agent-actions`, `LastRunActionsOutput.suggested`) | ❌ | ❌ (otimista) | ✅ |

Consequência concreta: o card de **rascunho** sob `dry_run` **só simula** a criação
mas **não avisa**; a mini-surface aprova otimista e nunca mostra se simulou/barrou/
falhou; e a ressalva aparece na mini-surface mas não no card de ação.

**Causa-raiz:** não há contrato nem componente único de aprovação. Cada feature
nova pousa só onde foi implementada.

## Objetivo

Padronizar a honestidade nas 3 superfícies via:
1. **Contrato:** o SERVIDOR decide "o que aprovar faz" uma vez (`applyPreview`) e
   expõe `ressalvas` em todos os outputs de aprovação.
2. **Desfecho pra todos:** `apply_outcome` também nos ramos de rascunho/ativação.
3. **Peças web compartilhadas** (não um card monolítico — os 3 layouts diferem):
   um callout, um estado-de-apply e a lógica aprovar+pollar, compostas por cada
   superfície no seu próprio layout.

## Não-objetivos (YAGNI)

- Não unificar os 3 cards num **componente único** (layouts genuinamente
  diferentes: card rico × linha compacta × card de rascunho). Só as PEÇAS.
- Não fiar o link "habilitar/desligar" pra config nesta fatia (o `message` do
  preview é texto; link = fast-follow).
- Não mexer no gating real (guardrail/binding) — o `applyPreview` é INFORMATIVO,
  derivado da mesma fonte do apply (consistência, não autoridade).
- Não cobrir o resultado do RUN (recomendações) — não é superfície de aprovação.

## Arquitetura

### 1. Contrato — `applyPreview` (servidor decide uma vez)

Helper PURO em `@trafego/core` (ou `@trafego/shared` se precisar do tipo no port):

```ts
type ApplyEffect = "real" | "simulated" | "blocked";
interface ApplyPreview { readonly effect: ApplyEffect; readonly message: string | null; }

// Entrada NEUTRA (a casca resolve os dados; o core decide). `capabilityEnabled` = o
// tipo/tool está habilitado (mesma fonte do apply: resolveEnabledTools/allowedActions).
function computeApplyPreview(input: {
  dryRun: boolean; killSwitch: boolean; accountAvailable: boolean;
  capabilityEnabled: boolean; kind: "action" | "draft" | "activation";
}): ApplyPreview;
```

Regras (prioridade dos bloqueios primeiro, ensaio depois):
- `!accountAvailable` → `blocked`, message "Esta conta está indisponível agora — não dá pra aplicar. Recheque a conexão."
- `killSwitch` → `blocked`, "Trava total ligada — o agente está impedido de agir nesta conta. Desligue em limites de segurança."
- `!capabilityEnabled` → `blocked`, message por kind: ação = "Esta ação não está nas ações permitidas deste agente — aprovar não teria efeito. Habilite em ações permitidas."; criação = "Criar/duplicar não está habilitado neste agente — habilite em ações permitidas."
- `dryRun` → `simulated`, message por kind: ação = "Modo ensaio ligado — aprovar aqui simula, não altera a conta."; criação = "Modo ensaio ligado — aprovar aqui simula a criação, não cria de verdade."
- senão → `real`, message `null`.

Copy na voz do Roy (fonte única — o front NÃO recomputa). Onde `capabilityEnabled`
vem: ação = `enabledActionTypes(resolveEnabledTools(...)).includes(type)` (o que o
`signalsByAgent` já calcula); criação = `resolveEnabledTools(...).has(toolKey)` (o
`duplicate_scale`/`create_campaign`) — MESMA fonte do `apply-draft.ts:130`.

**Exposição:** `applyPreview: ApplyPreview` entra em:
- `ApprovalOutput` (approvals/schema) — substitui os 4 booleans `dryRun/killSwitch/
  actionAllowed/accountAvailable` (o card passa a ler `applyPreview`). Migração do
  que a Fatia 1 de transparência criou.
- `draftApprovalOutput` (drafts/schema) — `capabilityEnabled` = criação habilitada;
  o `toolKey` do draft vem de `campaign_drafts.kind` (duplicate→duplicate_scale,
  from_scratch→create_campaign).
- `suggestedActionOutput` (agents/schema, `LastRunActionsOutput.suggested`).

**Ressalvas:** adicionar `ressalvas` ao `ApprovalOutput` (já existe em `suggested`
e no run). O card de ação passa a mostrar.

### 2. Worker — `apply_outcome` em rascunho/ativação

Hoje só o ramo de AÇÃO grava `apply_outcome` (Fatia 2 de transparência). Estender
os ramos `draft`/`activation` de `approval-apply.ts`:
- `created` real → `applied`; `created` dryRun → `simulated`; `blocked`/`unsupported`
  → `blocked`; `failed` → `markApplyOutcome("failed")` (mantém pendente).
- Copy do desfecho de criação (hoje inline no worker) → helper `describeDraftOutcome`
  (análogo ao `describeActionOutcome`; reusa `describeCreatedDraft`), pra o site e o
  WhatsApp lerem a MESMA frase.

`getOutcome` (api) passa a aceitar `kind` action|draft|activation e usar o describe
certo (hoje barra `kind !== "action"`).

### 3. Web — peças compartilhadas

- **`<app-ui-callout tone icon>`** (`apps/web/src/app/shared/ui`): a caixinha de
  aviso — ícone + `role="status"` + tokens. `tone`: `warning` (ensaio/ressalva),
  `neutral`/`locked` (bloqueio). Substitui os `<span class="border-2 border-warning
  …">` inline (hoje duplicados em ≥4 telas: approvals ×2, analysis-detail, agent-actions).
- **`ApprovalApplyStateService`** (injetável): dono do `applyState` (map por id) +
  a lógica `approve(id) → "Aplicando…" → polling getOne → desfecho` + `applyingLabel`/
  `isResolvedNonFailed`. Extraído do `approvals-page` (Fatia 2 de transparência) pra
  as 3 superfícies reusarem o MESMO comportamento.
- Cada superfície compõe: renderiza `applyPreview.message` num `<app-ui-callout>`
  (tone por `effect`), desabilita Aprovar quando `effect === 'blocked'`, e usa o
  serviço pro estado pós-aprovação. Layout de cada tela permanece.

Superfícies a converter: card de ação (`/approvals`), card de rascunho/ativação
(`/approvals`), mini-surface (`agent-actions`). Ressalva renderizada via callout nas
três.

## Fatiamento

- **Fatia 1 — contrato + worker:** `computeApplyPreview` (core, puro) + `applyPreview`
  nos 3 outputs + `ressalvas` no `ApprovalOutput` + `apply_outcome` em draft/activation
  (worker + `describeDraftOutcome`) + `getOutcome` kind-aware + kubb regen.
- **Fatia 2 — peças web + aplicar:** `<app-ui-callout>` + `ApprovalApplyStateService`
  + refatorar o card de ação (booleans → applyPreview) + aplicar em rascunho/ativação
  e mini-surface. Ressalva via callout nas três. Build AOT + tokens:check.

Cadência por fatia: typecheck + test (+ `pnpm --filter web build`) + commit; ao fim,
skill `reviewing-trafego-changes` + corrigir.

## Testes

- **core:** `computeApplyPreview` — um caso por efeito × kind (blocked por conta/
  trava/capacidade; simulated ação×criação; real).
- **api:** os 3 outputs carregam `applyPreview` certo (ensaio on/off, capacidade
  on/off, conta ativa/indisponível); `ApprovalOutput` carrega `ressalvas`;
  `getOutcome` devolve desfecho de draft.
- **worker:** ramos draft/activation gravam `apply_outcome` (failed mantém pending).
- **web:** callout renderiza tone+role certo; o serviço leva applying→desfecho;
  botão desabilita por `effect==='blocked'`; as 3 superfícies usam as peças.

## Riscos / cuidados

- **Refatorar o que a transparência criou:** os 4 booleans do `ApprovalOutput` viram
  `applyPreview`. É evolução, não retrabalho — mas o card de ação e seus testes
  mudam junto. Fazer no mesmo passo pra não deixar dois modelos.
- **Consistência de fonte:** `capabilityEnabled` DEVE sair da mesma fonte do apply
  (`resolveEnabledTools`) — senão o preview promete diferente do que o apply faz.
- **Deploy:** feature de várias camadas + regen de contrato — precisa de deploy.

## Questões em aberto

Nenhuma — decisões batidas (peças compartilhadas, não card único; applyPreview no
servidor; ressalva em todos; link como fast-follow).

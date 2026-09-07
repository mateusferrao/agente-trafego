# Honestidade da aprovação unificada — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unificar a honestidade da aprovação nas 3 superfícies (card de ação, card de rascunho/ativação, mini-surface) via um `applyPreview` computado no servidor + peças web compartilhadas.

**Architecture:** O servidor decide "o que aprovar faz" uma vez (`computeApplyPreview`, core puro) e expõe em todos os outputs de aprovação; o worker grava `apply_outcome` também em rascunho/ativação; o web ganha peças compartilhadas (`<app-ui-callout>` + `ApprovalApplyStateService`) que cada superfície compõe no seu layout.

**Tech Stack:** core puro (vitest), Fastify+zod→OpenAPI→kubb, BullMQ worker, Angular 21.

## Global Constraints

- Copy na voz do Roy — `docs/DESIGN.md §5` + `apps/web/DESIGN.md`: sentence case, "o que aconteceu + próximo passo", status por **tom+texto** (nunca só cor).
- Rótulo do estado carregando = **"Aplicando…"** (maiúscula inicial).
- `applyPreview` é INFORMATIVO; o gating real segue no apply, e `capabilityEnabled` DEVE sair da mesma fonte (`resolveEnabledTools`).
- Sem string mágica/cor hardcoded; cor só via token (`tokens:check`).
- Contrato: zod (fonte) → `pnpm api:generate` (kubb). O client gerado é gitignored.
- Mudança em `apps/web` verifica com `pnpm --filter web build` (AOT).
- **Revisar ANTES de commitar:** por fatia, implementar (TDD, verde) → rodar `reviewing-trafego-changes` no diff → corrigir → só então commitar.
- Todo commit termina com `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## Mapa de arquivos

**Fatia 1 — contrato + worker:**
- Modify: `packages/shared/src/types/index.ts` — `ApplyEffect`/`ApplyPreview`.
- Modify: `packages/shared/src/schemas/index.ts` — `applyPreviewSchema`.
- Create: `packages/core/src/apply-preview/index.ts` — `computeApplyPreview` (puro).
- Modify: `packages/core/src/apply-outcome/index.ts` — `describeDraftOutcome` + move de `describeCreatedDraft`.
- Modify: `apps/worker/src/modules/apply/draft-summary.ts` — re-exporta `describeCreatedDraft` do core.
- Modify: `apps/api/src/modules/approvals/{schema,service}.ts` — `applyPreview` + `ressalvas` (remove os 4 booleans).
- Modify: `apps/api/src/modules/drafts/{schema,service}.ts` — `applyPreview`.
- Modify: `apps/api/src/modules/agents/{schema,service}.ts` — `applyPreview` no `suggestedActionOutput`.
- Modify: `apps/worker/src/workers/approval-apply.ts` — `apply_outcome` em draft/activation.
- Modify: `apps/api/src/modules/approvals/service.ts` (`getOutcome`) + `routes.ts` — kind-aware.

**Fatia 2 — peças web:**
- Create: `apps/web/src/app/shared/ui/ui-callout.ts` + barrel.
- Create: `apps/web/src/app/features/approvals/approval-apply-state.service.ts` (ou shared).
- Modify: `apps/web/src/app/features/approvals/approvals-page.ts` — card de ação + rascunho/ativação.
- Modify: `apps/web/src/app/features/account-detail/agent-actions.ts` — mini-surface.

---

# FATIA 1 — contrato + worker

### Task 1: `computeApplyPreview` (core puro) + tipo + schema

**Files:**
- Modify: `packages/shared/src/types/index.ts`
- Modify: `packages/shared/src/schemas/index.ts`
- Create: `packages/core/src/apply-preview/index.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/apply-preview/index.test.ts`

**Interfaces:**
- Produces:
  - `type ApplyEffect = "real" | "simulated" | "blocked"` + `interface ApplyPreview { readonly effect: ApplyEffect; readonly message: string | null }` (`@trafego/shared`).
  - `applyPreviewSchema` (zod, `@trafego/shared/schemas`).
  - `computeApplyPreview(input: { dryRun: boolean; killSwitch: boolean; accountAvailable: boolean; capabilityEnabled: boolean; kind: "action" | "draft" | "activation" }): ApplyPreview` (`@trafego/core`).

- [ ] **Step 1: Test falho** — `packages/core/src/apply-preview/index.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { computeApplyPreview } from "./index.js";

const base = { dryRun: false, killSwitch: false, accountAvailable: true, capabilityEnabled: true, kind: "action" as const };

describe("computeApplyPreview", () => {
  it("tudo ok → real, sem mensagem", () => {
    expect(computeApplyPreview(base)).toEqual({ effect: "real", message: null });
  });
  it("conta indisponível → blocked (prioridade máxima)", () => {
    const p = computeApplyPreview({ ...base, accountAvailable: false, killSwitch: true });
    expect(p.effect).toBe("blocked");
    expect(p.message).toContain("indisponível");
  });
  it("kill-switch → blocked", () => {
    expect(computeApplyPreview({ ...base, killSwitch: true }).message).toContain("Trava total");
  });
  it("capacidade off (ação) → blocked com copy de ação", () => {
    expect(computeApplyPreview({ ...base, capabilityEnabled: false }).message).toContain("ações permitidas");
  });
  it("capacidade off (criação) → blocked com copy de criação", () => {
    expect(computeApplyPreview({ ...base, kind: "draft", capabilityEnabled: false }).message).toContain("habilite");
  });
  it("ensaio (ação) → simulated", () => {
    const p = computeApplyPreview({ ...base, dryRun: true });
    expect(p.effect).toBe("simulated");
    expect(p.message).toContain("simula");
  });
  it("ensaio (criação) → simulated com copy de criação", () => {
    expect(computeApplyPreview({ ...base, kind: "draft", dryRun: true }).message).toContain("simula a criação");
  });
});
```

- [ ] **Step 2: Rodar → falha**

Run: `pnpm --filter @trafego/core test -- --run apply-preview`
Expected: FAIL (módulo inexistente).

- [ ] **Step 3: Tipo em shared** — em `packages/shared/src/types/index.ts` (perto de `ApplyOutcome`):

```ts
/** Preview do que APROVAR faz (Fatia unificação): `real` (vale), `simulated` (ensaio, não altera),
 *  `blocked` (não permitido/trava/conta). `message` = a linha honesta (voz do Roy) ou null em `real`. */
export type ApplyEffect = "real" | "simulated" | "blocked";
export interface ApplyPreview {
  readonly effect: ApplyEffect;
  readonly message: string | null;
}
```

- [ ] **Step 4: Schema em shared** — em `packages/shared/src/schemas/index.ts`:

```ts
export const applyPreviewSchema = z.object({
  effect: z.enum(["real", "simulated", "blocked"]),
  message: z.string().nullable(),
});
```

- [ ] **Step 5: Core** — `packages/core/src/apply-preview/index.ts`:

```ts
import type { ApplyPreview } from "@trafego/shared";

/** Decide o preview de aprovação (PURO). Prioridade: conta > trava > capacidade > ensaio > real.
 *  Copy na voz do Roy — fonte única (o front NÃO recomputa). */
export function computeApplyPreview(input: {
  readonly dryRun: boolean;
  readonly killSwitch: boolean;
  readonly accountAvailable: boolean;
  readonly capabilityEnabled: boolean;
  readonly kind: "action" | "draft" | "activation";
}): ApplyPreview {
  const isCreation = input.kind !== "action";
  if (!input.accountAvailable) return { effect: "blocked", message: "Esta conta está indisponível agora — não dá pra aplicar. Recheque a conexão." };
  if (input.killSwitch) return { effect: "blocked", message: "Trava total ligada — o agente está impedido de agir nesta conta. Desligue em limites de segurança." };
  if (!input.capabilityEnabled)
    return {
      effect: "blocked",
      message: isCreation
        ? "Criar/duplicar não está habilitado neste agente — habilite em ações permitidas."
        : "Esta ação não está nas ações permitidas deste agente — aprovar não teria efeito. Habilite em ações permitidas.",
    };
  if (input.dryRun)
    return {
      effect: "simulated",
      message: isCreation
        ? "Modo ensaio ligado — aprovar aqui simula a criação, não cria de verdade."
        : "Modo ensaio ligado — aprovar aqui simula, não altera a conta.",
    };
  return { effect: "real", message: null };
}
```

Export em `packages/core/src/index.ts`:

```ts
export * from "./apply-preview/index.js";
```

- [ ] **Step 6: Rodar → passa**

Run: `pnpm --filter @trafego/core test -- --run apply-preview && pnpm --filter @trafego/shared typecheck`
Expected: PASS + limpo.

(commit ao fim da Fatia 1, após revisão)

---

### Task 2: `describeDraftOutcome` (core) + mover `describeCreatedDraft`

O desfecho de criação precisa da MESMA copy no worker (push) e na api (`getOutcome`). Move o summary puro pro core e adiciona o describe.

**Files:**
- Modify: `apps/worker/src/modules/apply/draft-summary.ts` (mover a função)
- Modify: `packages/core/src/apply-outcome/index.ts` (recebe `describeCreatedDraft` + `describeDraftOutcome`)
- Test: `packages/core/src/apply-outcome/index.test.ts` (estender)

**Interfaces:**
- Produces:
  - `describeCreatedDraft(kind: DraftKind, spec: CampaignDraftSpec): string` (movido pra `@trafego/core`).
  - `describeDraftOutcome(detail: { kind: "created"; dryRun: boolean; summary: string; targetingFallback?: boolean } | { kind: "blocked"; reason: string } | { kind: "failed"; metaMessage?: string }): string`.

- [ ] **Step 1: Test falho** — em `apply-outcome/index.test.ts`:

```ts
import { describeDraftOutcome } from "./index.js";
it("draft created real → confirma criação pausada", () => {
  expect(describeDraftOutcome({ kind: "created", dryRun: false, summary: "uma campanha nova" })).toContain("Criei");
});
it("draft created dry-run → simulado", () => {
  expect(describeDraftOutcome({ kind: "created", dryRun: true, summary: "x" })).toContain("Simulei a criação");
});
it("draft blocked → motivo", () => {
  expect(describeDraftOutcome({ kind: "blocked", reason: "sem página" })).toBe("Não criei: sem página.");
});
```

- [ ] **Step 2: Rodar → falha**

Run: `pnpm --filter @trafego/core test -- --run apply-outcome`
Expected: FAIL.

- [ ] **Step 3: Mover describeCreatedDraft pro core** — copiar o corpo de `apps/worker/src/modules/apply/draft-summary.ts` (função `describeCreatedDraft(kind, spec)`) pra `packages/core/src/apply-outcome/index.ts` (é pura: kind+spec→string). No `draft-summary.ts`, substituir por re-export:

```ts
export { describeCreatedDraft } from "@trafego/core";
```

- [ ] **Step 4: Adicionar describeDraftOutcome** — em `apply-outcome/index.ts` (voz do Roy, alinhado às frases hoje em `approval-apply.ts:122-133`):

```ts
export type DraftOutcomeDetail =
  | { readonly kind: "created"; readonly dryRun: boolean; readonly summary: string; readonly targetingFallback?: boolean }
  | { readonly kind: "blocked"; readonly reason: string }
  | { readonly kind: "failed"; readonly metaMessage?: string };

export function describeDraftOutcome(detail: DraftOutcomeDetail): string {
  switch (detail.kind) {
    case "created":
      if (detail.dryRun) return `Simulei a criação de ${detail.summary} (modo ensaio) — não criei de verdade.`;
      return `Criei ${detail.summary} — nasceu pausada. Revise e ative na plataforma quando quiser.`;
    case "blocked":
      return `Não criei: ${detail.reason}.`;
    case "failed":
      return detail.metaMessage ? `${detail.metaMessage} Dá pra tentar de novo.` : "Não consegui criar agora — a Meta não respondeu. Tenta de novo em instantes.";
  }
}
```

- [ ] **Step 5: Rodar → passa**

Run: `pnpm --filter @trafego/core test -- --run apply-outcome && pnpm --filter @trafego/worker typecheck`
Expected: PASS + limpo.

---

### Task 3: `ApprovalOutput` — applyPreview + ressalvas (remove os 4 booleans)

**Files:**
- Modify: `apps/api/src/modules/approvals/schema.ts:46-53`
- Modify: `apps/api/src/modules/approvals/service.ts` (`listPending` map)
- Test: `apps/api/src/modules/approvals/service.test.ts`

**Interfaces:**
- Consumes: `computeApplyPreview`, `applyPreviewSchema`, `ressalvaSchema`.
- Produces: `ApprovalOutput` sem `dryRun/killSwitch/actionAllowed/accountAvailable`; com `applyPreview` + `ressalvas`.

- [ ] **Step 1: Atualizar o test** — em `service.test.ts`, trocar as asserções dos 4 booleans por `applyPreview`:

```ts
it("ensaio + ação não permitida → applyPreview.effect blocked (capacidade vence ensaio)", async () => {
  const service = makeService([{ agentId: AGENT, accountId: "acc-1", accountName: "BM", currency: "BRL", accountStatus: "active", dryRun: true, killSwitch: false, allowedActions: ["pause_entity"], orgId: ORG }]);
  const bud = (await service.listPending(ORG))[0]!;
  expect(bud.applyPreview.effect).toBe("blocked");
  expect(bud.applyPreview.message).toContain("ações permitidas");
});
it("ensaio + ação permitida → simulated", async () => {
  const service = makeService([{ agentId: AGENT, accountId: "acc-1", accountName: "BM", currency: "BRL", accountStatus: "active", dryRun: true, killSwitch: false, allowedActions: ["adjust_budget"], orgId: ORG }]);
  expect((await service.listPending(ORG))[0]!.applyPreview.effect).toBe("simulated");
});
```

- [ ] **Step 2: Rodar → falha**

Run: `pnpm --filter @trafego/api test -- --run approvals/service`
Expected: FAIL.

- [ ] **Step 3: Schema** — em `schema.ts`, remover os 4 booleans (linhas 49-52) e adicionar:

```ts
import { applyPreviewSchema } from "@trafego/shared/schemas";
import { ressalvaSchema } from "@trafego/shared/schemas";
// ... dentro de approvalOutput:
  applyPreview: applyPreviewSchema,
  ressalvas: z.array(ressalvaSchema).nullable(),
```

- [ ] **Step 4: Service** — em `service.ts`, no `.map`, trocar os 4 campos por:

```ts
import { computeApplyPreview } from "@trafego/core";
// ...
applyPreview: computeApplyPreview({
  dryRun: acc?.dryRun ?? false,
  killSwitch: acc?.killSwitch ?? false,
  accountAvailable: acc?.accountAvailable ?? false,
  capabilityEnabled: acc?.enabledActions.has(a.actionType) ?? false,
  kind: "action",
}),
ressalvas: (a.action.ressalvas ?? null) as ApprovalOutput["ressalvas"],
```

(`a.action.ressalvas` já existe no Action — Fatia A.)

- [ ] **Step 5: Rodar → passa**

Run: `pnpm --filter @trafego/api test -- --run approvals/service`
Expected: PASS.

---

### Task 4: `draftApprovalOutput` — applyPreview

**Files:**
- Modify: `apps/api/src/modules/drafts/schema.ts` (`draftApprovalOutput`)
- Modify: `apps/api/src/modules/drafts/service.ts` (onde monta o output)
- Test: `apps/api/src/modules/drafts/service.test.ts` (se existir; senão inline no test do slice)

**Interfaces:**
- Produces: `draftApprovalOutput.applyPreview` (`capabilityEnabled` = criação habilitada; `kind` = `approvalKind`).

- [ ] **Step 1: Schema** — adicionar em `draftApprovalOutput`:

```ts
  applyPreview: applyPreviewSchema,
```

- [ ] **Step 2: Service** — no ponto que monta o `draftApprovalOutput`, carregar guardrail + enabled do agente (reusar `loadEnabledTools`/`resolveEnabledTools` de `@trafego/core` — o service já é org-scoped) e:

```ts
const toolKey = draft.kind === "duplicate" ? "duplicate_scale" : "create_campaign";
applyPreview: computeApplyPreview({
  dryRun, killSwitch, accountAvailable,
  capabilityEnabled: approvalKind === "activation" ? true : enabled.has(toolKey),
  kind: approvalKind,
}),
```

(activation não tem gate de binding — só trava/conta/ensaio → `capabilityEnabled: true`.)

- [ ] **Step 3: Test** — cobre draft com criação off → blocked; com ensaio → simulated. Rodar `pnpm --filter @trafego/api test -- --run drafts`. Expected: PASS.

---

### Task 5: `suggestedActionOutput` — applyPreview (mini-surface)

**Files:**
- Modify: `apps/api/src/modules/agents/schema.ts` (`suggestedActionOutput`)
- Modify: `apps/api/src/modules/agents/service.ts` (onde monta o suggested)
- Test: `apps/api/src/modules/agents/service.test.ts`

**Interfaces:**
- Produces: `suggestedActionOutput.applyPreview` (mesma computação do card de ação — `type` dá o actionType).

- [ ] **Step 1: Schema** — adicionar `applyPreview: applyPreviewSchema` ao `suggestedActionOutput`.

- [ ] **Step 2: Service** — o `agents/service` já semeia guardrail; carregar `enabled` (resolveEnabledTools) e computar `applyPreview` por suggested com `capabilityEnabled: enabledActions.has(s.type)`, `kind: "action"`.

- [ ] **Step 3: Test + rodar** — `pnpm --filter @trafego/api test -- --run agents`. Expected: PASS.

---

### Task 6: Worker `apply_outcome` em draft/activation + `getOutcome` kind-aware + regen

**Files:**
- Modify: `apps/worker/src/workers/approval-apply.ts` (ramos draft/activation ~90-160)
- Modify: `apps/api/src/modules/approvals/service.ts` (`getOutcome`)
- Test: adaptar os testes de worker/api existentes

- [ ] **Step 1: Worker draft branch** — no ramo `kind === "draft"`, gravar outcome + reusar `describeDraftOutcome`:

```ts
case "created": {
  await ports.approval.resolve(approval.id, { status: "approved", applyOutcome: outcome.dryRun ? "simulated" : "applied" });
  const [draftRow] = await deps.db.select({ kind: campaignDrafts.kind, spec: campaignDrafts.spec }).from(campaignDrafts).where(eq(campaignDrafts.id, approval.draftId)).limit(1);
  const summary = draftRow ? describeCreatedDraft(draftRow.kind, draftRow.spec as CampaignDraftSpec) : "sua campanha";
  const text = describeDraftOutcome({ kind: "created", dryRun: outcome.dryRun, summary, targetingFallback: outcome.createdIds["targetingFallback"] === true });
  if (outcome.dryRun) await pushOutcome(text); else await pushRealApplied(text);
  return;
}
case "blocked":
case "unsupported":
  await ports.approval.resolve(approval.id, { status: "blocked", resolvedReason: outcome.reason, applyOutcome: "blocked" });
  await pushOutcome(describeDraftOutcome({ kind: "blocked", reason: outcome.reason }));
  return;
case "failed":
  await ports.approval.markApplyOutcome(approval.id, "failed", metaUserMessage(outcome.error));
  await pushOutcome(describeDraftOutcome({ kind: "failed", ...(metaUserMessage(outcome.error) ? { metaMessage: metaUserMessage(outcome.error)! } : {}) }));
  return;
```

(análogo no ramo `activation`, reusando as frases de ativação atuais → um `describeActivationOutcome` ou o mesmo describeDraftOutcome adaptado; manter o texto de ativação existente.)

- [ ] **Step 2: getOutcome kind-aware** — em `service.ts`, remover o `a.kind !== "action"` do 404 e ramificar a mensagem: ação → `describeActionOutcome`; draft/activation → `describeDraftOutcome` (lendo a `apply_outcome` + `resolved_reason`; para `created`/`simulated`, montar summary via `describeCreatedDraft` lendo `campaign_drafts`).

- [ ] **Step 3: Rodar + regen**

Run: `pnpm --filter @trafego/worker test && pnpm --filter @trafego/api test -- --run approvals && pnpm api:generate && pnpm --filter web typecheck`
Expected: PASS + tipos regenerados.

- [ ] **Fim da Fatia 1:** rodar `reviewing-trafego-changes` no diff da fatia → corrigir apontamentos → **então** commitar (um commit coeso ou por-task, após a revisão).

---

# FATIA 2 — peças web + aplicar

### Task 7: `<app-ui-callout>` — componente compartilhado

**Files:**
- Create: `apps/web/src/app/shared/ui/ui-callout.ts`
- Modify: `apps/web/src/app/shared/ui/index.ts` (barrel)
- Test: `apps/web/src/app/shared/ui/ui-callout.spec.ts`

**Interfaces:**
- Produces: `<app-ui-callout [tone]="'warning'|'blocked'|'info'">texto</app-ui-callout>` — ícone por tone + `role="status"` + tokens.

- [ ] **Step 1: Componente** — `ui-callout.ts` (espelha o padrão de `ui-eyebrow`/`ui-badge`; ícone via NgIcon lucide: warning→`lucideTriangleAlert`, blocked→`lucideLock`, info→`lucideInfo`):

```ts
import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideTriangleAlert, lucideLock, lucideInfo } from '@ng-icons/lucide';

type Tone = 'warning' | 'blocked' | 'info';
const ICON: Record<Tone, string> = { warning: 'lucideTriangleAlert', blocked: 'lucideLock', info: 'lucideInfo' };

@Component({
  selector: 'app-ui-callout',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgIcon],
  providers: [provideIcons({ lucideTriangleAlert, lucideLock, lucideInfo })],
  template: `<span class="flex items-start gap-2 rounded-md border px-3 py-2 text-xs" [class]="toneClass()" role="status">
    <ng-icon [name]="icon()" class="mt-0.5 shrink-0" />
    <span class="min-w-0"><ng-content /></span>
  </span>`,
})
export class UiCallout {
  readonly tone = input<Tone>('info');
  protected icon = () => ICON[this.tone()];
  protected toneClass = () =>
    this.tone() === 'warning' ? 'border-2 border-warning bg-warning-soft text-warning-strong'
    : this.tone() === 'blocked' ? 'border-line bg-panel text-ink'
    : 'border-line bg-soft text-ink';
}
```

Barrel: `export { UiCallout } from './ui-callout';`.

- [ ] **Step 2: Test + build** — spec renderiza o role/tone; `pnpm --filter web test` + `pnpm --filter web build` + `pnpm --filter web tokens:check`. Expected: verde, sem cor hardcoded.

---

### Task 8: `ApprovalApplyStateService` — aprovar + pollar (extraído)

**Files:**
- Create: `apps/web/src/app/features/approvals/approval-apply-state.service.ts`
- Test: `.../approval-apply-state.service.spec.ts`

**Interfaces:**
- Produces: serviço com `approve(id, onDone?)`, `state(id): 'applying'|'timeout'|ApprovalOutcomeOutput|undefined`, `label(id): string|null`, `isResolvedNonFailed(id): boolean` — a lógica hoje inline em `approvals-page` (constantes `APPLY_POLL_MS`/`APPLY_POLL_TIMEOUT_MS`, `pollOutcome`).

- [ ] **Step 1: Extrair** — mover `applyState`/`pollOutcome`/`applyingLabel`/`isResolvedNonFailed` (Fatia 2 da transparência, `approvals-page`) pra um `@Injectable` que injeta `ApprovalsApiService.getOne`. Mesma lógica (poll ~1,5s, teto 30s, fallback timeout).

- [ ] **Step 2: Test + build** — spec: `approve` → applying → getOne resolve → outcome; timeout encerra. `pnpm --filter web test`. Expected: PASS.

---

### Task 9: Card de ação (`/approvals`) — applyPreview + callout + service + ressalva

**Files:**
- Modify: `apps/web/src/app/features/approvals/approvals-page.ts`

- [ ] **Step 1: Consumir applyPreview** — trocar `dryRunNotice`/`approveBlockedReason` (que liam os 4 booleans) por leitura de `a.applyPreview`:
  - callout de aviso: `@if (a.applyPreview.message; as m) { <app-ui-callout [tone]="a.applyPreview.effect === 'blocked' ? 'blocked' : 'warning'">{{ m }}</app-ui-callout> }`
  - botão: `[disabled]="... || a.applyPreview.effect === 'blocked'"`.
- [ ] **Step 2: Ressalva** — renderizar `a.ressalvas` via `<app-ui-callout tone="warning">` (novo — fecha o gap).
- [ ] **Step 3: Estado do apply** — trocar os métodos locais pelo `ApprovalApplyStateService` (Task 8).
- [ ] **Step 4: Build AOT + tokens** — `pnpm --filter web build && pnpm --filter web tokens:check`. Atualizar `approvals-save.spec.ts` (fixtures: trocar os 4 booleans por `applyPreview: { effect:'real', message:null }` + `ressalvas: null`). Expected: verde.

---

### Task 10: Card de rascunho/ativação (`/approvals`) — applyPreview + callout + service

**Files:**
- Modify: `apps/web/src/app/features/approvals/approvals-page.ts` (seção `draftGroups`)

- [ ] **Step 1: Aviso** — no card de rascunho, adicionar o mesmo callout de `d.applyPreview.message` (tone por effect) + desabilitar o botão Aprovar/Ativar quando `effect === 'blocked'`.
- [ ] **Step 2: Estado do apply** — usar o `ApprovalApplyStateService` no `approveDraft` (hoje otimista) → "Aplicando…" + desfecho.
- [ ] **Step 3: Build AOT** — `pnpm --filter web build`. Expected: verde.

---

### Task 11: Mini-surface (`agent-actions`) — applyPreview + callout + service

**Files:**
- Modify: `apps/web/src/app/features/account-detail/agent-actions.ts`

- [ ] **Step 1: Aviso + ressalva** — trocar o `<span border-2 border-warning>` inline da ressalva (linhas 81-85) por `<app-ui-callout tone="warning">`; adicionar o callout de `s.applyPreview.message` (tone por effect) + desabilitar Aprovar quando blocked.
- [ ] **Step 2: Estado do apply** — usar o `ApprovalApplyStateService` no `approve` (hoje otimista) → "Aplicando…" + desfecho.
- [ ] **Step 3: Build AOT + tokens** — `pnpm --filter web build && pnpm --filter web tokens:check`. Expected: verde.

- [ ] **Fim da Fatia 2:** rodar `reviewing-trafego-changes` no diff → corrigir → **então** commitar.

---

## Self-review (cobertura do spec)

- **Contrato applyPreview nos 3 outputs:** Tasks 3 (ação), 4 (draft/activation), 5 (suggested). ✅
- **Ressalvas em todos:** Task 3 (ApprovalOutput — o gap); suggested/run já tinham. ✅
- **apply_outcome draft/activation + getOutcome kind-aware:** Task 6. ✅
- **Copy voz do Roy fonte única:** `computeApplyPreview` (T1) + `describeDraftOutcome`/`describeCreatedDraft` no core (T2). ✅
- **Peças web (callout + service) compostas por superfície:** Tasks 7–11. ✅
- **Refatorar booleans→applyPreview:** Task 3 + Task 9 (fixtures). ✅
- **Revisar antes de commitar:** fim de cada fatia. ✅

Tipos consistentes (`ApplyPreview`/`ApplyEffect` T1 usados em T3-5, 9-11; `describeDraftOutcome` T2 usado em T6). Sem placeholders de conteúdo.

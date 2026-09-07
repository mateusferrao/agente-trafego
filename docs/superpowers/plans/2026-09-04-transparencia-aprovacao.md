# Transparência da aprovação (diz×faz no card /approvals) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tornar o card de `/approvals` honesto ANTES (avisa/bloqueia conforme a condição) e DEPOIS (vira "Aplicando…" e mostra o desfecho real) de aprovar.

**Architecture:** Fatia 1 ("Antes") expõe 4 sinais do guardrail por card e ajusta o front, sem migration. Fatia 2 ("Depois") persiste um `apply_outcome` por aprovação, extrai a copy de desfecho pra um helper puro reusado por WhatsApp+site, e o card faz polling do desfecho. Gates saem sempre da MESMA fonte do apply (`resolveEnabledTools` + `enabledActionTypes` + guardrail config).

**Tech Stack:** Node/Fastify + Drizzle (api), BullMQ worker, Angular 21 (web), zod→OpenAPI→kubb (contrato), vitest.

## Global Constraints

- Copy na voz do Roy — `docs/DESIGN.md §5` (`BRAND_VOICE_KERNEL`) + `apps/web/DESIGN.md`: sentence case, "o que aconteceu + próximo passo", status por **tom+texto** (nunca só cor), sem jargão (traduzir termos).
- Rótulo do estado carregando = **"Aplicando…"** (maiúscula inicial).
- Sem string mágica / cor hardcoded — valores em const/token nomeado (CLAUDE.md → Princípios de engenharia). Cor só via design token.
- Migrations SÓ via `pnpm db:generate` (nunca SQL à mão).
- Contrato: zod (fonte) → OpenAPI → kubb (`pnpm api:generate`); sem tipo duplicado.
- Mudança em `apps/web` verifica com `pnpm --filter web build` (AOT), não só typecheck.
- Sinais do "antes" são INFORMATIVOS (UX); o gating real segue no guardrail do apply — e DEVEM sair da mesma fonte (`enabledActionTypes`/`resolveEnabledTools` + guardrail config).
- Todo commit termina com: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## Mapa de arquivos

**Fatia 1 — "Antes":**
- Modify: `packages/shared/src/constants/actions.ts` (ou onde vive `WRITE_TOOL_TO_ACTION`) — recebe `enabledActionTypes` puro.
- Modify: `apps/worker/src/modules/tools/enabled.ts` — passa a re-exportar/importar `enabledActionTypes` de shared.
- Modify: `apps/api/src/modules/approvals/service.ts` — pending list carrega dryRun/killSwitch/actionAllowed/accountAvailable.
- Modify: `apps/api/src/modules/approvals/schema.ts` — 4 campos novos no `approvalOutput`.
- Regen: client kubb (`apps/web/src/app/core/api/generated/*`).
- Modify: `apps/web/src/app/features/approvals/approvals-page.ts` — faixa de ensaio, botão condicional, toast honesto.

**Fatia 2 — "Depois":**
- Create: `packages/core/src/apply-outcome/index.ts` — `describeActionOutcome` (puro) + tipo `ApplyOutcome`.
- Modify: `packages/core/src/index.ts` — export.
- Modify: `packages/db/src/schema/_shared.ts` + `execution.ts` — enum + coluna `apply_outcome`; migration gerada.
- Modify: `packages/shared/src/ports/approval.port.ts` + adapter `@trafego/approval-postgres` — `resolve` aceita `applyOutcome`; novo `markApplyOutcome`.
- Modify: `apps/worker/src/workers/approval-apply.ts` — grava `apply_outcome` + reusa `describeActionOutcome`.
- Modify: `apps/api/src/modules/approvals/{schema,service,routes}.ts` — `GET /:id` devolve desfecho.
- Regen kubb + `apps/web/src/app/core/api/approvals-api.service.ts` (método `getOne`).
- Modify: `apps/web/src/app/features/approvals/approvals-page.ts` — estado "Aplicando…" + polling + desfechos.

---

# FATIA 1 — "Antes"

### Task 1: Mover `enabledActionTypes` (puro) pra `@trafego/shared`

Hoje `enabledActionTypes` vive em `apps/worker/src/modules/tools/enabled.ts` — a API não pode importar de `apps/worker`. É PURO (só filtra `WRITE_TOOL_TO_ACTION` por um Set). Move pra shared → uma fonte pros dois gates.

**Files:**
- Modify: `packages/shared/src/constants/actions.ts`
- Modify: `apps/worker/src/modules/tools/enabled.ts:39-42`
- Test: `packages/shared/src/constants/actions.test.ts` (criar se não existir)

**Interfaces:**
- Produces: `enabledActionTypes(enabled: ReadonlySet<string>): ActionType[]` em `@trafego/shared`.

- [ ] **Step 1: Test falho** — `packages/shared/src/constants/actions.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { enabledActionTypes } from "./actions.js";

describe("enabledActionTypes", () => {
  it("mapeia só as tool-keys de AÇÃO habilitadas p/ ActionType", () => {
    expect(enabledActionTypes(new Set(["pause_entity"]))).toEqual(["pause_entity"]);
  });
  it("ignora tool-keys de criação (não são ActionType)", () => {
    const out = enabledActionTypes(new Set(["pause_entity", "create_campaign", "duplicate_scale"]));
    expect(out).toEqual(["pause_entity"]);
  });
  it("Set vazio → []", () => {
    expect(enabledActionTypes(new Set())).toEqual([]);
  });
});
```

- [ ] **Step 2: Rodar → falha**

Run: `pnpm --filter @trafego/shared test -- --run actions.test`
Expected: FAIL ("enabledActionTypes is not exported").

- [ ] **Step 3: Implementar em shared** — adicionar ao fim de `packages/shared/src/constants/actions.ts` (usa o `WRITE_TOOL_TO_ACTION` já existente no módulo):

```ts
/** Subconjunto das ACTION-types habilitadas (das 4) a partir das tool-keys habilitadas.
 *  Fonte ÚNICA dos dois gates (apply no worker + sinal do card na API). PURO. */
export function enabledActionTypes(enabled: ReadonlySet<string>): ActionType[] {
  return [...WRITE_TOOL_TO_ACTION.entries()].filter(([tool]) => enabled.has(tool)).map(([, action]) => action);
}
```

Confirme os imports no topo do arquivo (`ActionType`, `WRITE_TOOL_TO_ACTION`); se `WRITE_TOOL_TO_ACTION` estiver noutro arquivo de `packages/shared/src`, coloque `enabledActionTypes` ao lado dele e ajuste o import do teste.

- [ ] **Step 4: Worker reusa de shared** — em `apps/worker/src/modules/tools/enabled.ts`: remover a definição local de `enabledActionTypes` (linhas 39-42) e adicioná-la ao import de `@trafego/shared` (linha 10):

```ts
import { WRITE_TOOL_TO_ACTION, enabledActionTypes, type ActionType, type ToolBindingMode } from "@trafego/shared";
```

Manter o `export { enabledActionTypes }` no `enabled.ts` se algum consumidor importa dali:

```ts
export { enabledActionTypes } from "@trafego/shared";
```

- [ ] **Step 5: Rodar shared + worker**

Run: `pnpm --filter @trafego/shared test -- --run actions.test && pnpm --filter @trafego/worker typecheck`
Expected: PASS + typecheck limpo.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/constants/actions.ts packages/shared/src/constants/actions.test.ts apps/worker/src/modules/tools/enabled.ts
git commit -m "refactor(shared): enabledActionTypes puro em @trafego/shared (fonte única dos gates)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: API — pending list carrega os 4 sinais do "antes"

**Files:**
- Modify: `apps/api/src/modules/approvals/schema.ts:22-45`
- Modify: `apps/api/src/modules/approvals/service.ts:37-93`
- Test: `apps/api/src/modules/approvals/service.test.ts` (estender/criar)

**Interfaces:**
- Consumes: `enabledActionTypes` (Task 1), `resolveEnabledTools` (`@trafego/core`).
- Produces: `ApprovalOutput` ganha `dryRun`, `killSwitch`, `actionAllowed`, `accountAvailable` (todos `boolean`).

- [ ] **Step 1: Test falho** — em `service.test.ts`, com um agente `dry_run=true` e `allowed_actions=["pause_entity"]`, o item `adjust_budget` deve vir `dryRun:true, actionAllowed:false`:

```ts
it("pending carrega sinais do antes: ensaio + ação não permitida", async () => {
  // arrange: guardrail dry_run=true, allowed=["pause_entity"], sem bindings; conta active;
  // 1 approval pendente adjust_budget. (usar os helpers/fixtures do arquivo)
  const out = await service.listPending(ORG);
  const bud = out.find((o) => o.type === "adjust_budget")!;
  expect(bud.dryRun).toBe(true);
  expect(bud.actionAllowed).toBe(false);
  expect(bud.killSwitch).toBe(false);
  expect(bud.accountAvailable).toBe(true);
});
```

- [ ] **Step 2: Rodar → falha**

Run: `pnpm --filter @trafego/api test -- --run approvals`
Expected: FAIL (propriedades inexistentes).

- [ ] **Step 3: Schema** — adicionar ao `approvalOutput` (`schema.ts`, após `audience`):

```ts
  /** Sinais do "antes" (informativos — o gating real é do apply). O card avisa/bloqueia. */
  dryRun: z.boolean(),
  killSwitch: z.boolean(),
  actionAllowed: z.boolean(),
  accountAvailable: z.boolean(),
```

- [ ] **Step 4: Service** — em `service.ts`, estender o carregamento por-agente com guardrail + bindings + status da conta e computar os sinais. Substituir `accountByAgent` por um loader que também traz o necessário:

```ts
import { agentToolBindings, guardrailConfigs } from "@trafego/db";
import { resolveEnabledTools } from "@trafego/core";
import { enabledActionTypes, type ToolBindingMode } from "@trafego/shared";

/** agentId → { conta + guardrail + tool-keys habilitadas } p/ os sinais do card. */
async function signalsByAgent(agentIds: readonly string[]) {
  const map = new Map<string, {
    accountId: string; accountName: string; currency: string | null;
    accountAvailable: boolean; dryRun: boolean; killSwitch: boolean; enabledActions: Set<string>;
  }>();
  if (agentIds.length === 0) return map;
  const rows = await deps.db
    .select({
      agentId: agents.id, accountId: adAccounts.id, accountName: adAccounts.name,
      currency: adAccounts.currency, accountStatus: adAccounts.status,
      dryRun: guardrailConfigs.dryRun, killSwitch: guardrailConfigs.killSwitch,
      allowedActions: guardrailConfigs.allowedActions, orgId: agents.orgId,
    })
    .from(agents)
    .innerJoin(adAccounts, eq(agents.adAccountId, adAccounts.id))
    .leftJoin(guardrailConfigs, eq(guardrailConfigs.agentId, agents.id))
    .where(inArray(agents.id, [...agentIds]));
  const bindings = await deps.db
    .select({ agentId: agentToolBindings.agentId, toolKey: agentToolBindings.toolKey, mode: agentToolBindings.mode })
    .from(agentToolBindings)
    .where(inArray(agentToolBindings.agentId, [...agentIds]));
  const bindingsByAgent = new Map<string, Map<string, ToolBindingMode>>();
  for (const b of bindings) {
    const m = bindingsByAgent.get(b.agentId) ?? new Map();
    m.set(b.toolKey, b.mode as ToolBindingMode);
    bindingsByAgent.set(b.agentId, m);
  }
  for (const r of rows) {
    const allowed = new Set((r.allowedActions ?? []) as string[]);
    const enabled = resolveEnabledTools(bindingsByAgent.get(r.agentId) ?? new Map(), allowed);
    map.set(r.agentId, {
      accountId: r.accountId, accountName: r.accountName ?? r.accountId, currency: r.currency,
      accountAvailable: r.accountStatus === "active",
      dryRun: r.dryRun ?? false, killSwitch: r.killSwitch ?? false,
      enabledActions: new Set(enabledActionTypes(enabled)),
    });
  }
  return map;
}
```

No `listPending`, trocar `accountByAgent` por `signalsByAgent` e no `.map` devolver:

```ts
const s = accounts.get(a.agentId);
// ... campos existentes ...
dryRun: s?.dryRun ?? false,
killSwitch: s?.killSwitch ?? false,
actionAllowed: s?.enabledActions.has(a.actionType) ?? false,
accountAvailable: s?.accountAvailable ?? false,
```

(Ajustar as leituras `acc?.accountId`/`acc?.currency`/`acc?.accountName` p/ `s?.…`.)

- [ ] **Step 5: Rodar → passa**

Run: `pnpm --filter @trafego/api test -- --run approvals`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/approvals/schema.ts apps/api/src/modules/approvals/service.ts apps/api/src/modules/approvals/service.test.ts
git commit -m "feat(api): pending de aprovações carrega sinais do 'antes' (ensaio/kill-switch/permitida/conta)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Regenerar o contrato (kubb)

**Files:** Regen: `apps/web/src/app/core/api/generated/**` (via `pnpm api:generate`).

- [ ] **Step 1: Regenerar**

Run: `pnpm api:generate`
Expected: `ApprovalOutput.ts` gerado ganha `dryRun/killSwitch/actionAllowed/accountAvailable: boolean`.

- [ ] **Step 2: Verificar tipos web**

Run: `pnpm --filter web typecheck`
Expected: limpo (os campos existem no tipo).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/core/api/generated
git commit -m "chore(api): regen kubb — sinais do 'antes' no ApprovalOutput

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Web — faixa de ensaio, botão condicional, toast honesto

**Files:**
- Modify: `apps/web/src/app/features/approvals/approvals-page.ts` (template do card pendente ~150-181; método `approve` ~461-466)

**Interfaces:**
- Consumes: `ApprovalOutput.{dryRun,killSwitch,actionAllowed,accountAvailable}`.

- [ ] **Step 1: Helpers de bloqueio/aviso** — no componente, adicionar:

```ts
/** Motivo de bloqueio do botão Aprovar (null = liberado). Ordem: conta > trava > permitida. */
protected approveBlockedReason(a: ApprovalOutput): string | null {
  if (!a.accountAvailable) return 'Esta conta está indisponível agora — não dá pra aplicar. Recheque a conexão.';
  if (a.killSwitch) return 'Trava total ligada — o agente está impedido de agir nesta conta. Desligue em limites de segurança pra aprovar.';
  if (!a.actionAllowed) return 'Essa ação não está nas ações permitidas deste agente — aprovar não teria efeito. Habilite em ações permitidas.';
  return null;
}
/** Aviso de ensaio (não bloqueia — só avisa que aprovar simula). */
protected dryRunNotice(a: ApprovalOutput): string | null {
  return a.dryRun ? 'Modo ensaio ligado — aprovar aqui simula, não altera a conta. Desligue em limites de segurança quando quiser valer.' : null;
}
```

- [ ] **Step 2: Template** — no card pendente (dentro do `<li>` ~151), acima da linha de botões (~163), inserir os avisos; e no botão Aprovar (~177) desabilitar por `approveBlockedReason`. Manter tom+texto (não só cor):

```html
@if (dryRunNotice(a); as notice) {
  <span class="rounded-md border-2 border-warning bg-warning-soft px-3 py-2 text-xs text-ink">{{ notice }}</span>
}
@if (approveBlockedReason(a); as blocked) {
  <span class="rounded-md border border-line bg-panel px-3 py-2 text-xs text-muted">{{ blocked }}</span>
}
```

E o botão:

```html
<button appButton size="sm" [disabled]="resolving().has(a.id) || !!approveBlockedReason(a)" (click)="approve(a)">
  {{ resolving().has(a.id) ? 'Enviando…' : 'Aprovar' }}
</button>
```

- [ ] **Step 3: Toast honesto** — no `approve` (~466), quando `dryRun`, refletir a simulação:

```ts
toast.success(a.dryRun ? `Aprovado — em modo ensaio, o ${AGENT_NAME} só simula (não altera a conta).` : `Aprovado. O ${AGENT_NAME} aplica em instantes.`);
```

- [ ] **Step 4: Build AOT**

Run: `pnpm --filter web build`
Expected: `Application bundle generation complete` (sem erro de template).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/features/approvals/approvals-page.ts
git commit -m "feat(web): card de aprovação avisa ensaio e bloqueia botão quando não teria efeito

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 6: Revisão da fatia** — rodar skill `reviewing-trafego-changes` sobre os commits da Fatia 1; corrigir apontamentos.

---

# FATIA 2 — "Depois"

### Task 5: Helper puro `describeActionOutcome` (`@trafego/core`)

Extrai as frases de desfecho hoje INLINE no `approval-apply.ts` (fonte única: WhatsApp + site + card).

**Files:**
- Create: `packages/core/src/apply-outcome/index.ts`
- Modify: `packages/core/src/index.ts` (export)
- Test: `packages/core/src/apply-outcome/index.test.ts`

**Interfaces:**
- Produces:
  - `type ApplyOutcome = "applied" | "simulated" | "noop" | "blocked" | "failed";`
  - `type OutcomeDetail = { kind: "applied" } | { kind: "simulated" } | { kind: "noop" } | { kind: "blocked"; reason: string } | { kind: "failed"; metaMessage?: string };`
  - `describeActionOutcome(action: Action, detail: OutcomeDetail): string`

- [ ] **Step 1: Test falho** — `index.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { describeActionOutcome } from "./index.js";
import type { Action } from "@trafego/shared";

const budget: Action = { id: "a", type: "adjust_budget", target: { level: "adset", id: "1", name: "Leads — 8510" }, params: {}, source: "llm", riskLevel: "medium", reason: "x" };

describe("describeActionOutcome", () => {
  it("applied real → 1ª pessoa + o quê", () => {
    expect(describeActionOutcome(budget, { kind: "applied" })).toBe("Ajustei o orçamento de Leads — 8510.");
  });
  it("simulated (ensaio) → honesto, sem mexer", () => {
    expect(describeActionOutcome(budget, { kind: "simulated" })).toContain("Simulei");
  });
  it("blocked → o que + motivo", () => {
    expect(describeActionOutcome(budget, { kind: "blocked", reason: "budget já ajustado hoje" })).toBe("Não apliquei (Leads — 8510): budget já ajustado hoje.");
  });
  it("noop → já estava assim", () => {
    expect(describeActionOutcome(budget, { kind: "noop" })).toContain("Não precisei mexer");
  });
  it("failed → mensagem da Meta quando houver + próximo passo", () => {
    expect(describeActionOutcome(budget, { kind: "failed", metaMessage: "A Meta informou: limite" })).toContain("A Meta informou: limite");
    expect(describeActionOutcome(budget, { kind: "failed" })).toContain("Tenta de novo");
  });
});
```

- [ ] **Step 2: Rodar → falha**

Run: `pnpm --filter @trafego/core test -- --run apply-outcome`
Expected: FAIL (módulo inexistente).

- [ ] **Step 3: Implementar** — `packages/core/src/apply-outcome/index.ts` (portar `appliedActionLine` + as frases de `approval-apply.ts`):

```ts
import type { Action } from "@trafego/shared";

export type ApplyOutcome = "applied" | "simulated" | "noop" | "blocked" | "failed";
export type OutcomeDetail =
  | { readonly kind: "applied" }
  | { readonly kind: "simulated" }
  | { readonly kind: "noop" }
  | { readonly kind: "blocked"; readonly reason: string }
  | { readonly kind: "failed"; readonly metaMessage?: string };

/** Resumo BREVE (1ª pessoa) do que foi aplicado — voz do Roy. */
function appliedActionLine(action: Action): string {
  const name = action.target?.name ?? "a entidade";
  switch (action.type) {
    case "pause_entity": return `Pausei ${name}`;
    case "resume_entity": return `Reativei ${name}`;
    case "set_status": return `Mudei o status de ${name}`;
    case "adjust_budget": return `Ajustei o orçamento de ${name}`;
    case "adjust_audience": return `Ajustei o público de ${name}`;
    default: return `Apliquei a ação em ${name}`;
  }
}

/** Copy ÚNICA do desfecho de uma ação (WhatsApp + site). PURA. */
export function describeActionOutcome(action: Action, detail: OutcomeDetail): string {
  const name = action.target?.name;
  const suffix = name ? ` (${name})` : "";
  switch (detail.kind) {
    case "applied": return `${appliedActionLine(action)}.`;
    case "simulated": return `Simulei a ação${suffix} (modo ensaio) — mostrei o que faria, sem mexer na conta.`;
    case "noop": return `Não precisei mexer${suffix} — já estava no estado desejado.`;
    case "blocked": return `Não apliquei${suffix}: ${detail.reason}.`;
    case "failed": return detail.metaMessage
      ? `${detail.metaMessage} Dá pra tentar de novo.`
      : `Não consegui aplicar agora${suffix} — a Meta não respondeu. Tenta de novo em instantes.`;
  }
}
```

Export em `packages/core/src/index.ts`:

```ts
export * from "./apply-outcome/index.js";
```

- [ ] **Step 4: Rodar → passa**

Run: `pnpm --filter @trafego/core test -- --run apply-outcome`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/apply-outcome packages/core/src/index.ts
git commit -m "feat(core): describeActionOutcome — copy única do desfecho (WhatsApp+site)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: DB — coluna `apply_outcome` na `approvals`

**Files:**
- Modify: `packages/db/src/schema/_shared.ts` (enum), `packages/db/src/schema/execution.ts` (coluna)
- Generate: migration (`pnpm db:generate`)

- [ ] **Step 1: Enum** — em `_shared.ts`, junto dos outros pgEnum:

```ts
export const applyOutcome = pgEnum("apply_outcome", ["applied", "simulated", "noop", "blocked", "failed"]);
```

- [ ] **Step 2: Coluna** — em `execution.ts`, tabela `approvals`, importar `applyOutcome` e adicionar após `resolvedReason`:

```ts
    // desfecho da aplicação (Fatia "depois"): distingue applied×simulated (ambos status approved)
    // e marca failed SEM resolver (status segue pending → reaprovável). Null = sem tentativa/aplicando.
    applyOutcome: applyOutcome("apply_outcome"),
```

- [ ] **Step 3: Gerar migration**

Run: `pnpm db:generate`
Expected: nova migration `NNNN_*.sql` com `ALTER TABLE approvals ADD COLUMN apply_outcome ...` + o tipo enum.

- [ ] **Step 4: Typecheck db**

Run: `pnpm --filter @trafego/db typecheck`
Expected: limpo.

- [ ] **Step 5: Commit**

```bash
git add packages/db
git commit -m "feat(db): approvals.apply_outcome (desfecho da aplicação)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Port + adapter — persistir o desfecho

**Files:**
- Modify: `packages/shared/src/ports/approval.port.ts` (`ResolveApprovalInput` + novo método)
- Modify: adapter `@trafego/approval-postgres` (impl)
- Test: teste do adapter (arquivo existente do approval-postgres)

**Interfaces:**
- Produces:
  - `ResolveApprovalInput` ganha `applyOutcome?: ApplyOutcome`.
  - `markApplyOutcome(id: ApprovalId, applyOutcome: ApplyOutcome, resolvedReason?: string): Promise<void>` — grava o desfecho SEM mudar status (p/ o caso `failed`).

- [ ] **Step 1: Test falho** — no teste do adapter: `resolve(..., { status:"approved", applyOutcome:"simulated" })` grava `apply_outcome="simulated"`; `markApplyOutcome(id, "failed", msg)` grava outcome + reason mantendo `status="pending"`.

```ts
it("resolve grava applyOutcome; markApplyOutcome marca failed sem resolver", async () => {
  const a = await port.upsertPending(/* ...pendente... */);
  await port.resolve(a.id, { status: "approved", applyOutcome: "simulated" });
  expect((await port.getById(a.id))!.applyOutcome).toBe("simulated");

  const b = await port.upsertPending(/* outra pendente */);
  await port.markApplyOutcome(b.id, "failed", "A Meta informou: limite");
  const got = await port.getById(b.id);
  expect(got!.status).toBe("pending");
  expect(got!.applyOutcome).toBe("failed");
  expect(got!.resolvedReason).toBe("A Meta informou: limite");
});
```

- [ ] **Step 2: Rodar → falha**

Run: `pnpm --filter @trafego/approval-postgres test`
Expected: FAIL.

- [ ] **Step 3: Port** — em `approval.port.ts`: importar `ApplyOutcome` (de `@trafego/core` ou re-exportado por shared — decidir: como o port é shared e core depende de shared, defina `ApplyOutcome` em `@trafego/shared` e o core importa dali). Ajuste:
  - `ResolveApprovalInput`: `readonly applyOutcome?: ApplyOutcome;`
  - método novo na interface `ApprovalPort`: `markApplyOutcome(id: ApprovalId, applyOutcome: ApplyOutcome, resolvedReason?: string): Promise<void>;`
  - Todos os tipos `PendingApproval`/`Approval` expõem `applyOutcome: ApplyOutcome | null`.

> **Nota de dependência:** mover a definição do tipo `ApplyOutcome` pra `@trafego/shared` (junto de `RESSALVA_CODES` etc.) e o `describeActionOutcome` (core, Task 5) importar `ApplyOutcome` de shared. Ajustar o export do Task 5 se necessário.

- [ ] **Step 4: Adapter** — implementar `markApplyOutcome` (update `apply_outcome` [+ `resolved_reason`] por id, sem tocar status) e no `resolve` gravar `apply_outcome` quando vier no input; `getById`/listagens passam a selecionar `apply_outcome`.

- [ ] **Step 5: Rodar → passa**

Run: `pnpm --filter @trafego/approval-postgres test && pnpm --filter @trafego/shared typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/ports/approval.port.ts packages/*/approval-postgres
git commit -m "feat(approval): persistir apply_outcome (resolve + markApplyOutcome)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Worker — gravar o desfecho + reusar a copy

**Files:**
- Modify: `apps/worker/src/workers/approval-apply.ts` (ramos de AÇÃO ~179-207; remover `appliedActionLine`/`metaFailureLine` inline em favor do helper onde couber)
- Test: `apps/worker/src/workers/approval-apply.test.ts` (se existir) OU teste focado nos ramos.

**Interfaces:**
- Consumes: `describeActionOutcome`, `markApplyOutcome`, `resolve({applyOutcome})`.

- [ ] **Step 1: Test falho** — cada ramo grava o `apply_outcome` certo; `failed` mantém `pending`.

```ts
it("applied real grava apply_outcome=applied e status=approved", async () => { /* mock outcome applied dryRun:false */ });
it("dry-run grava apply_outcome=simulated", async () => { /* outcome applied dryRun:true */ });
it("blocked grava apply_outcome=blocked + status blocked", async () => {});
it("noop grava apply_outcome=noop", async () => {});
it("failed grava apply_outcome=failed mantendo pending", async () => {});
```

- [ ] **Step 2: Rodar → falha**

Run: `pnpm --filter @trafego/worker test -- --run approval-apply`
Expected: FAIL.

- [ ] **Step 3: Implementar** — no ramo de AÇÃO (`outcome.kind`), gravar o outcome + usar `describeActionOutcome` p/ a mensagem (mantendo `pushRealApplied`/`pushOutcome`):

```ts
case "failed": {
  const metaMessage = metaFailureLine(outcome.error, "");
  await ports.approval.markApplyOutcome(approval.id, "failed", metaMessage || undefined);
  await pushOutcome(describeActionOutcome(approval.action, { kind: "failed", metaMessage: metaMessage || undefined }));
  return;
}
case "blocked":
  await ports.approval.resolve(approval.id, { status: "blocked", resolvedReason: outcome.reason, applyOutcome: "blocked" });
  await pushOutcome(describeActionOutcome(approval.action, { kind: "blocked", reason: outcome.reason }));
  return;
case "noop":
  await ports.approval.resolve(approval.id, { status: "blocked", resolvedReason: "a entidade já estava no estado desejado", applyOutcome: "noop" });
  await pushOutcome(describeActionOutcome(approval.action, { kind: "noop" }));
  return;
case "applied":
  await ports.approval.resolve(approval.id, { status: "approved", applyOutcome: outcome.dryRun ? "simulated" : "applied" });
  if (outcome.dryRun) await pushOutcome(describeActionOutcome(approval.action, { kind: "simulated" }));
  else await pushRealApplied(describeActionOutcome(approval.action, { kind: "applied" }));
  return;
```

(Remover o `appliedActionLine` local do worker — agora vem do core.)

- [ ] **Step 4: Rodar → passa**

Run: `pnpm --filter @trafego/worker test -- --run approval-apply`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/workers/approval-apply.ts apps/worker/src/workers/approval-apply.test.ts
git commit -m "feat(worker): grava apply_outcome + reusa describeActionOutcome (copy única)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: API — `GET /approvals/:id` devolve o desfecho

**Files:**
- Modify: `apps/api/src/modules/approvals/schema.ts` (novo `approvalOutcomeOutput`)
- Modify: `apps/api/src/modules/approvals/service.ts` (`getOutcome`)
- Modify: `apps/api/src/modules/approvals/routes.ts` (rota GET `/:id`)
- Test: `service.test.ts`

**Interfaces:**
- Produces: `GET /approvals/:id` → `{ id, status, applyOutcome: ApplyOutcome | null, resolvedReason: string | null, outcomeMessage: string | null }`.

- [ ] **Step 1: Test falho**:

```ts
it("getOutcome devolve applyOutcome + mensagem na voz do Roy", async () => {
  // approval resolvida blocked + apply_outcome=blocked + resolvedReason="budget já ajustado hoje"
  const out = await service.getOutcome(ORG, approvalId);
  expect(out.applyOutcome).toBe("blocked");
  expect(out.outcomeMessage).toBe("Não apliquei (Leads — 8510): budget já ajustado hoje.");
});
```

- [ ] **Step 2: Rodar → falha**

Run: `pnpm --filter @trafego/api test -- --run approvals`
Expected: FAIL.

- [ ] **Step 3: Schema + service + rota**:

Schema (`schema.ts`):

```ts
export const approvalOutcomeOutput = z.object({
  id: z.string(),
  status: approvalStatusOutput,
  applyOutcome: z.enum(["applied", "simulated", "noop", "blocked", "failed"]).nullable(),
  resolvedReason: z.string().nullable(),
  outcomeMessage: z.string().nullable(),
});
export type ApprovalOutcomeOutput = z.infer<typeof approvalOutcomeOutput>;
```

Service (`service.ts`) — deriva a mensagem via `describeActionOutcome`:

```ts
import { describeActionOutcome, type OutcomeDetail } from "@trafego/core";

async getOutcome(orgId: OrgId, approvalId: ApprovalId): Promise<ApprovalOutcomeOutput> {
  const a = await deps.approvals.getById(approvalId);
  if (!a || a.orgId !== orgId || a.kind !== "action") throw notFound("Aprovação não encontrada.");
  const oc = a.applyOutcome;
  const detail: OutcomeDetail | null =
    oc === "applied" ? { kind: "applied" }
    : oc === "simulated" ? { kind: "simulated" }
    : oc === "noop" ? { kind: "noop" }
    : oc === "blocked" ? { kind: "blocked", reason: a.resolvedReason ?? "" }
    : oc === "failed" ? { kind: "failed", metaMessage: a.resolvedReason ?? undefined }
    : null;
  return {
    id: a.id, status: a.status, applyOutcome: oc ?? null,
    resolvedReason: a.resolvedReason ?? null,
    outcomeMessage: detail ? describeActionOutcome(a.action, detail) : null,
  };
}
```

Rota (`routes.ts`) — `GET /:id` (schema `approvalOutcomeOutput`), org-scoped como as demais.

- [ ] **Step 4: Rodar + regen**

Run: `pnpm --filter @trafego/api test -- --run approvals && pnpm api:generate && pnpm --filter web typecheck`
Expected: PASS + tipo `ApprovalOutcomeOutput` gerado.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/approvals apps/web/src/app/core/api/generated
git commit -m "feat(api): GET /approvals/:id devolve o desfecho da aplicação (voz do Roy)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 10: Web — "Aplicando…" + polling + desfecho

**Files:**
- Modify: `apps/web/src/app/core/api/approvals-api.service.ts` (`getOne`)
- Modify: `apps/web/src/app/features/approvals/approvals-page.ts` (estado + polling + template)

**Interfaces:**
- Consumes: `ApprovalsApiService.getOne(id)`, `ApprovalOutcomeOutput`.

- [ ] **Step 1: Método de API** — em `approvals-api.service.ts`:

```ts
/** `GET /api/approvals/:id` — desfecho da aplicação (polling do card). */
getOne(id: string): Observable<ApprovalOutcomeOutput> {
  return this.get<ApprovalOutcomeOutput>(['/approvals', id]);
}
```

(importar `ApprovalOutcomeOutput` de `./generated`.)

- [ ] **Step 2: Estado + polling** — no componente. Const nomeadas (sem número mágico):

```ts
const APPLY_POLL_MS = 1500;
const APPLY_POLL_TIMEOUT_MS = 30_000;
```

Signal de desfecho por card: `applyingOutcome = signal<Map<string, ApprovalOutcomeOutput | 'applying' | 'timeout'>>(new Map())`. No `approve`, em vez de remover o card, marcar `applying` e iniciar o polling (`timer(0, APPLY_POLL_MS).pipe(switchMap(() => api.getOne(a.id)), takeWhile(o => o.applyOutcome === null && !expirou, true))`), atualizando o mapa até `applyOutcome !== null` (desfecho) ou timeout (`'timeout'`). `failed` → também reabilita o botão (a aprovação segue pending).

- [ ] **Step 3: Template do desfecho** — abaixo dos botões, renderizar o estado:

```html
@if (outcomeState(a.id); as st) {
  @if (st === 'applying') { <span class="text-xs text-muted">Aplicando…</span> }
  @else if (st === 'timeout') { <span class="text-xs text-muted">Ainda aplicando — te aviso no WhatsApp.</span> }
  @else { <span class="text-xs text-ink">{{ st.outcomeMessage }}</span> }
}
```

`outcomeState(id)` lê o mapa. Quando `applied`/`simulated`/`blocked`/`noop`, o card pode sair da lista após um beat (ou ficar com a mensagem); `failed` mantém o card acionável.

- [ ] **Step 4: Build AOT**

Run: `pnpm --filter web build`
Expected: bundle ok.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/core/api/approvals-api.service.ts apps/web/src/app/features/approvals/approvals-page.ts
git commit -m "feat(web): card vira 'Aplicando…' e mostra o desfecho real (polling)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 6: Revisão da fatia** — rodar skill `reviewing-trafego-changes` sobre a Fatia 2; corrigir apontamentos.

---

## Self-review (cobertura do spec)

- **Antes (misto):** Task 2 (sinais) + Task 4 (aviso ensaio + botão bloqueado por conta/kill-switch/não-permitida). ✅
- **Depois (Aplicando… + desfecho):** Tasks 6–10 (coluna, port, worker grava, API expõe, web polla). ✅
- **Copy voz do Roy, fonte única:** Task 5 (`describeActionOutcome`) reusado em worker (Task 8) e API (Task 9). ✅
- **Rótulo "Aplicando…":** Task 10 Step 3. ✅
- **Gates single-source:** Task 1 (`enabledActionTypes` em shared) + Task 2 (`resolveEnabledTools`). ✅
- **Migration só via db:generate:** Task 6 Step 3. ✅
- **Contrato kubb:** Tasks 3 e 9. ✅
- **Web verify com build AOT:** Tasks 4 e 10. ✅

Sem placeholders de conteúdo; tipos consistentes (`ApplyOutcome`/`OutcomeDetail` definidos na Task 5/7 e usados nas 8/9/10).

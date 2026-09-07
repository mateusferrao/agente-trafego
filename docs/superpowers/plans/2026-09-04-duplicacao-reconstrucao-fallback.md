# Duplicação com fallback de reconstrução — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fazer a duplicação de campanha funcionar em conta antiga — `/copies` primeiro (fiel/barato), com fallback de reconstrução **por-nó** via rota de criação quando a Meta recusa a cópia (`not_duplicable`), avisando as modernizações inevitáveis.

**Architecture:** Toda a lógica de copiar-ou-reconstruir vive no **adapter** `@trafego/ads-meta` (a recursão interna do `duplicateEntity` é o único ponto que alcança cada nó). Quando um nó bate num muro `not_duplicable`, o adapter reconstrói **só aquele nó** (e sua subárvore) espelhando os campos crus da fonte via `POST /adsets`/`/ads` (referenciando o `creative_id` existente — o criativo não é recriado, então a re-validação que o `/copies` faz não dispara). Campos descontinuados (janela de atribuição) são modernizados pela Meta e reportados como `ModernizationNote` neutro no `DuplicateResult`, que a saga espelha no desfecho (WhatsApp + site) reusando o mesmo pipe do `targetingFallback`. Tipos genuinamente divergentes (ASC etc) caem na rede **tenta-e-reverte** que já existe (`revertRoot` + atomicidade), virando `failed/blocked` honesto — sem allowlist de tipos.

**Tech Stack:** TypeScript (monorepo pnpm), Vitest, Meta Graph API v26, Drizzle (só leitura de `campaign_drafts.created_ids`), Angular 21 (card de desfecho).

## Global Constraints

- **Reuso-primeiro / desacoplamento (CLAUDE.md → Convenções › Princípios de engenharia):** reusar `shallowCopy`, `createOnAccount`, `listChildIds`, `revertRoot`, `copiedIdOf`, `AdsPlatformError`, `MetaGovernor` (via `this.client.request`). Nada novo que já exista.
- **Vocabulário Meta só no adapter (CLAUDE.md → Portas & adapters):** subcodes, `attribution_spec`, `optimization_goal`, `promoted_object` NUNCA vazam pro `shared`/`core`. O contrato neutro é `ModernizationNote { code }`; o core traduz `code → PT`.
- **Atomicidade / idempotência (CLAUDE.md → Regras de negócio):** `duplicateEntity` continua **tudo-ou-nada** — qualquer falha dura reverte a raiz (`revertRoot`) e re-lança. A reconstrução herda isso (é chamada DENTRO do mesmo try/catch).
- **Sem string mágica (CLAUDE.md → Princípios de engenharia):** subcodes num objeto nomeado; campos de espelho numa const nomeada.
- **Cadência do usuário:** rodar `reviewing-trafego-changes` no diff **antes** de commitar CADA task; corrigir; só então commitar.
- **TDD:** RED → GREEN por task. Adapter testado com `stubTree` (mock de `client.request` roteado por url+method) — já existe em `creation.test.ts`.

## Validação empírica (spikes reais na BM-Automato, tudo revertido)

O mecanismo-chave (referenciar `creative_id` encapsula o criativo; espelhar campos crus do conjunto) foi provado contra a Meta real:
- **Normal (janela de atribuição descontinuada + criativo legado):** reconstrução recria campanha→conjunto→anúncio (spike da Leads 55076000). ✅
- **Dynamic creative:** espelhar `is_dynamic_creative` + referenciar o `creative_id` (que carrega o `asset_feed_spec`) recria a campanha DC inteira. ✅ → o espelho é **type-agnostic** como projetado.
- **Catálogo/DPA:** NÃO fabricável nesta conta (o System User token não tem `catalog_management` — só cria referências, não catálogos). Coberto pelo MESMO mecanismo provado 2× (`promoted_object` já está no `ADSET_MIRROR_FIELDS`; criativo referenciado) — a reconstrução real referencia o catálogo/product_set EXISTENTE do cliente (só exige `ads_management`). Sem carimbo empírico; a rede honesta cobre se falhar.
- **ASC (Advantage+ Shopping):** caso-alvo da rede por design (estrutura própria que o espelho campo-a-campo não reproduz fiel) → `failed/blocked` honesto.

---

### Task 1: Classificador `NOT_DUPLICABLE_SUBCODES` (+ janela de atribuição)

Para o erro de atribuição (`1885423`) parar de virar "tenta de novo" (mentira — é determinístico) e passar a ser reconhecido como muro `not_duplicable`. Sozinha, esta task já melhora a honestidade (vira `blocked`); as tasks 3-4 transformam o `blocked` em reconstrução real.

**Files:**
- Modify: `packages/ads-meta/src/creation.ts:45-51` (a const `LEGACY_ENHANCEMENTS_SUBCODE` + `isLegacyEnhancementsCopyError`)
- Test: `packages/ads-meta/src/creation.test.ts`

**Interfaces:**
- Consumes: `MetaApiError` (com `.subcode`, `.userMessage`), `AdsPlatformError` (já importados no arquivo).
- Produces: `isNotDuplicableCopyError(error: unknown): boolean` e o objeto nomeado `NOT_DUPLICABLE_SUBCODES` (usado pelas tasks 3-4 no catch do fallback).

- [ ] **Step 1: Escrever o teste que falha** (adicionar ao `creation.test.ts`)

```ts
it("janela de atribuição descontinuada (subcode 1885423) → not_duplicable neutro (subcode não vaza)", async () => {
  const svc = new MetaCreationService(clientThatFailsCopyWith({
    code: 100, error_subcode: 1885423,
    error_user_msg: "A janela de atribuição de conversão é inválida.",
  }));
  const err = await svc.duplicateEntity(ACCOUNT, { sourceLevel: "ad", sourceId: "AD1", status: "paused" }).catch((e) => e);
  expect(err).toMatchObject({ kind: "not_duplicable", userMessage: "A janela de atribuição de conversão é inválida." });
});
```

Se `clientThatFailsCopyWith` não existir, reusar o padrão do teste `vencedor legado (subcode 3858504)` já presente no arquivo (mesma montagem de `MetaGraphClient` cujo `request` rejeita com `MetaApiError`).

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm --filter @trafego/ads-meta test -- creation`
Expected: FAIL — `1885423` hoje propaga como `upstream`, não `not_duplicable`.

- [ ] **Step 3: Implementar** (`creation.ts`, substituindo as linhas 45-51)

```ts
/**
 * Subcodes Meta em que a ENTIDADE-FONTE não pode ser copiada COMO ESTÁ (`/copies` re-valida e
 * recusa) — determinístico, não-transitório. Nomeado p/ auditar + estender sem string mágica.
 * `criativo_legado`: standard_enhancements descontinuado (v22). `atribuicao_descontinuada`: janela
 * de atribuição que o objetivo não suporta mais. Ambos → `not_duplicable` → gatilho de reconstrução.
 * INTERNO ao adapter (subcode nunca vaza pro port neutro).
 */
const NOT_DUPLICABLE_SUBCODES = {
  criativo_legado: 3858504,
  atribuicao_descontinuada: 1885423,
} as const;
const NOT_DUPLICABLE_SUBCODE_SET: ReadonlySet<number> = new Set(Object.values(NOT_DUPLICABLE_SUBCODES));

function isNotDuplicableCopyError(error: unknown): boolean {
  return error instanceof MetaApiError && typeof error.subcode === "number" && NOT_DUPLICABLE_SUBCODE_SET.has(error.subcode);
}
```

E em `shallowCopy` (linha ~188), trocar `isLegacyEnhancementsCopyError(error)` por `isNotDuplicableCopyError(error)` e generalizar a mensagem técnica (a `userMessage` da Meta continua sendo a voz pro usuário):

```ts
      if (isNotDuplicableCopyError(error)) {
        throw new AdsPlatformError("not_duplicable", "cópia rejeitada pela plataforma (config descontinuada da entidade-fonte)", (error as MetaApiError).userMessage);
      }
```

Remover a antiga `LEGACY_ENHANCEMENTS_SUBCODE` / `isLegacyEnhancementsCopyError` (substituídas). Ajustar o teste legado existente se ele referenciava o nome antigo.

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm --filter @trafego/ads-meta test -- creation`
Expected: PASS (o teste novo + o legado `3858504` seguem verdes).

- [ ] **Step 5: Revisar (cadência) e commitar**

Rodar `reviewing-trafego-changes` no diff; corrigir; então:

```bash
git add packages/ads-meta/src/creation.ts packages/ads-meta/src/creation.test.ts
git commit -m "feat(ads-meta): classificador NOT_DUPLICABLE_SUBCODES nomeado (+ janela de atribuição 1885423)"
```

---

### Task 2: Contrato `ModernizationNote` + surfacing no desfecho (pipe ponta-a-ponta)

Threa a nota neutra do adapter até o card/WhatsApp, reusando o pipe do `targetingFallback`. Nesta task o adapter ainda devolve `modernizations: []` (o produtor de notas chega na Task 4) — o valor aqui é o **cano pronto e testado**.

**Files:**
- Modify: `packages/shared/src/ports/ads-platform.port.ts:96-100` (`DuplicateResult`) + novo tipo `ModernizationNote`
- Modify: `packages/core/src/apply-outcome/index.ts` (`DraftOutcomeDetail.created` + `describeDraftOutcome` + helper `modernizationNotePt`)
- Modify: `packages/ads-meta/src/creation.ts` (`duplicateEntity` retorna `modernizations: []` em todos os caminhos)
- Modify: `apps/worker/src/modules/apply/apply-draft.ts:221-222` (persistir `modernizations`)
- Modify: `apps/worker/src/workers/approval-apply.ts:96` (ler `createdIds["modernizations"]`)
- Modify: `apps/api/src/modules/approvals/service.ts:126` (idem no card do site)
- Test: `packages/core/src/apply-outcome/*.test.ts`

**Interfaces:**
- Consumes: `DuplicateResult` (Task 3-4 preenchem `modernizations`).
- Produces: `ModernizationNote { readonly code: "attribution_window_modernized" }` (união extensível); `DraftOutcomeDetail.created.modernizations?: readonly ModernizationNote[]`.

- [ ] **Step 1: Teste que falha** (`apply-outcome` test)

```ts
it("desfecho created com modernização anexa a nota honesta", () => {
  const out = describeDraftOutcome({
    kind: "created", dryRun: false, summary: "a duplicata do seu vencedor, R$ 80,00/dia",
    activated: false, modernizations: [{ code: "attribution_window_modernized" }],
  });
  expect(out).toContain("nasceu pausada");
  expect(out).toContain("janela de atribuição pra 1 dia");
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm --filter @trafego/core test -- apply-outcome`
Expected: FAIL — `modernizations` ainda não existe no tipo.

- [ ] **Step 3a: Tipo neutro** (`packages/shared/src/ports/ads-platform.port.ts`, junto do `DuplicateResult`)

```ts
/** Diferença INEVITÁVEL que a reconstrução introduziu vs a fonte (a plataforma descontinuou o
 *  valor original). Neutro — sem vocabulário do provider. O core traduz `code` → PT. */
export interface ModernizationNote {
  readonly code: "attribution_window_modernized";
}
```

E acrescentar ao `DuplicateResult`:

```ts
export interface DuplicateResult {
  readonly copiedId: string;
  readonly childIds: readonly string[];
  readonly childAdsetIds: readonly string[];
  /** modernizações que a reconstrução precisou aplicar (vazio quando tudo veio de `/copies`). */
  readonly modernizations: readonly ModernizationNote[];
}
```

- [ ] **Step 3b: Core copy** (`packages/core/src/apply-outcome/index.ts`)

Importar `ModernizationNote` de `@trafego/shared`. Adicionar `modernizations?` ao `created`:

```ts
  | { readonly kind: "created"; readonly dryRun: boolean; readonly summary: string; readonly activated?: boolean; readonly targetingFallback?: boolean; readonly modernizations?: readonly ModernizationNote[] }
```

Helper (fonte única PT, por código):

```ts
function modernizationNotePt(note: ModernizationNote): string {
  switch (note.code) {
    case "attribution_window_modernized":
      return "Obs: ajustei a janela de atribuição pra 1 dia — a Meta descontinuou a janela original nesse objetivo.";
  }
}
```

No branch `created` do `describeDraftOutcome`, depois de compor `base`+fallback, anexar as notas:

```ts
      const withFallback = detail.targetingFallback ? `${base} Obs: não consegui herdar o público que prometi (a fonte sumiu) — usei um público amplo. Revise antes de ativar.` : base;
      const mods = (detail.modernizations ?? []).map(modernizationNotePt);
      return mods.length ? `${withFallback} ${mods.join(" ")}` : withFallback;
```

(dry-run não anexa modernização — nada foi criado.)

- [ ] **Step 3c: Adapter devolve `modernizations`** (`creation.ts` `duplicateEntity`)

Nos 3 `return` do `duplicateEntity` (campaign/adset/ad), acrescentar `modernizations: []` (a Task 4 troca por um acumulador real). Isso mantém o typecheck verde com o contrato novo.

- [ ] **Step 3d: Saga persiste** (`apply-draft.ts`, linha ~221)

```ts
      if (!createdIds["copiedId"]) {
        const dup = await ports.ads.duplicateEntity(ref, buildDuplicateInput(pausedDraft));
        await persist({ copiedId: dup.copiedId, childIds: dup.childIds, childAdsetIds: dup.childAdsetIds, modernizations: dup.modernizations });
      }
```

- [ ] **Step 3e: Leitores do desfecho**

`apps/worker/src/workers/approval-apply.ts:96`:

```ts
            const text = describeDraftOutcome({ kind: "created", dryRun: outcome.dryRun, summary, activated: outcome.activated, targetingFallback: outcome.createdIds["targetingFallback"] === true, modernizations: readModernizations(outcome.createdIds) });
```

`apps/api/src/modules/approvals/service.ts:126`:

```ts
    return describeDraftOutcome({ kind: "created", dryRun: oc === "simulated", summary, modernizations: readModernizations(createdIds) });
```

Helper defensivo compartilhado (colocar em `@trafego/core` `apply-outcome`, exportado — evita duplicar o cast nos dois leitores):

```ts
/** Lê as notas de modernização de um `created_ids` cru (defensivo — só códigos conhecidos). */
export function readModernizations(createdIds: Record<string, unknown>): readonly ModernizationNote[] {
  const raw = createdIds["modernizations"];
  if (!Array.isArray(raw)) return [];
  return raw.filter((n): n is ModernizationNote => !!n && typeof n === "object" && (n as { code?: unknown }).code === "attribution_window_modernized");
}
```

- [ ] **Step 4: Rodar tudo e ver passar**

Run: `pnpm --filter @trafego/core test && pnpm --filter @trafego/ads-meta test && pnpm --filter @trafego/shared typecheck && pnpm --filter worker typecheck && pnpm --filter api typecheck`
Expected: PASS.

- [ ] **Step 5: Revisar (cadência) e commitar**

```bash
git add packages/shared packages/core apps/worker/src/modules/apply/apply-draft.ts apps/worker/src/workers/approval-apply.ts apps/api/src/modules/approvals/service.ts
git commit -m "feat: contrato ModernizationNote neutro + surfacing do desfecho (reusa pipe do targetingFallback)"
```

---

### Task 3: Reconstruir ANÚNCIO (folha) + fallback por-nó no nível ad

Primeiro nó reconstruível (o mais simples: referencia o `creative_id`). Cobre o muro do criativo legado sem reconstruir o resto.

**Files:**
- Modify: `packages/ads-meta/src/creation.ts` (`copyAdsInto` → `copyOrReconstructAdsInto`; novo `reconstructAdInto`; helper `withRenameSuffix`)
- Test: `packages/ads-meta/src/creation.test.ts`

**Interfaces:**
- Consumes: `createOnAccount`, `listChildIds`, `shallowCopy`, `AdsPlatformError`.
- Produces: `copyOrReconstructAdsInto(account, srcAdset, status, newAdsetId, renameSuffix?): Promise<string[]>` (substitui `copyAdsInto` em todos os call-sites).

- [ ] **Step 1: Teste que falha** — no `stubTree`, fazer o `/copies` de UM anúncio falhar com `3858504`; esperar que o anúncio seja **recriado** via `POST /ads` referenciando o `creative_id` da fonte, e a duplicação inteira suceder.

```ts
it("anúncio com criativo legado → reconstrói via POST /ads (creative_id) e a duplicação sucede", async () => {
  const stub = stubTree({
    adsets: { C_SRC: ["AS1"] }, ads: { AS1: ["AD_LEGACY"] },
    creativeOf: { AD_LEGACY: "CRE_9" },
    failCopyOn: ["AD_LEGACY"], failCopySubcode: 3858504,
  });
  const svc = new MetaCreationService(stub.client);
  const res = await svc.duplicateEntity(ACCOUNT, { sourceLevel: "campaign", sourceId: "C_SRC", status: "paused" });
  expect(res.childIds).toHaveLength(1);
  expect(stub.posted("ads")).toContainEqual(expect.objectContaining({ creative: JSON.stringify({ creative_id: "CRE_9" }) }));
});
```

(estender o `stubTree` existente: suportar `creativeOf`, `failCopySubcode`, e capturar `POST act_x/ads`/`/adsets` em `stub.posted(edge)`.)

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm --filter @trafego/ads-meta test -- creation`
Expected: FAIL — hoje o `not_duplicable` propaga e reverte tudo (não reconstrói).

- [ ] **Step 3: Implementar** (`creation.ts`)

Helper de nome:

```ts
/** Aplica o mesmo sufixo de nome que o `/copies` usaria (fidelidade visual copy×reconstrução). */
function withRenameSuffix(name: string, suffix?: string): string {
  return suffix ? `${name}${suffix}` : name;
}
```

`reconstructAdInto`:

```ts
/** Recria UM anúncio no conjunto destino REFERENCIANDO o creative_id da fonte (não recria o
 *  criativo → a re-validação de standard_enhancements do `/copies` não dispara). Prova real: spike
 *  BM-Automato. Sem criativo reutilizável → `not_duplicable` (a rede da casca oferece as saídas). */
private async reconstructAdInto(account: AdAccountRef, srcAdId: string, newAdsetId: string, status: "active" | "paused", renameSuffix?: string): Promise<string> {
  const { data } = await this.client.request<{ name?: string; creative?: { id?: string } }>({
    method: "GET", path: srcAdId, accessToken: account.accessToken, params: { fields: "name,creative{id}" },
  });
  const creativeId = data.creative?.id;
  if (!creativeId) throw new AdsPlatformError("not_duplicable", "anúncio-fonte sem criativo reutilizável", undefined);
  return this.createOnAccount(account, "ads", {
    name: withRenameSuffix(data.name ?? "anúncio", renameSuffix),
    adset_id: newAdsetId,
    status: status === "active" ? STATUS_ACTIVE_CREATE : STATUS_PAUSED_CREATE,
    creative: JSON.stringify({ creative_id: creativeId }),
  });
}
```

(usar as MESMAS constantes de status que `createCampaign`/`createAdSet` já usam — hoje literais `"ACTIVE"`/`"PAUSED"`; se ainda não houver const nomeada de status de CREATE, extrair uma `STATUS_ACTIVE_CREATE="ACTIVE"`/`STATUS_PAUSED_CREATE="PAUSED"` no topo e reusar nos `create*` também — sem string mágica.)

`copyOrReconstructAdsInto` (substitui `copyAdsInto`, linha ~158):

```ts
/** Copia cada anúncio da fonte no conjunto novo; se o `/copies` de um anúncio bater muro
 *  `not_duplicable`, reconstrói SÓ ele via create. Fidelidade: copia onde dá. */
private async copyOrReconstructAdsInto(account: AdAccountRef, srcAdset: string, status: "active" | "paused", newAdsetId: string, renameSuffix?: string): Promise<string[]> {
  const newAdIds: string[] = [];
  for (const srcAd of await this.listChildIds(account, srcAdset, "ads")) {
    try {
      newAdIds.push(await this.shallowCopy(account, srcAd, status, { adset_id: newAdsetId }));
    } catch (error) {
      if (error instanceof AdsPlatformError && error.kind === "not_duplicable") {
        newAdIds.push(await this.reconstructAdInto(account, srcAd, newAdsetId, status, renameSuffix));
      } else throw error;
    }
  }
  return newAdIds;
}
```

Atualizar os call-sites de `copyAdsInto` (em `duplicateEntity` adset-path linha ~132 e em `copyAdsetInto` linha ~153) para `copyOrReconstructAdsInto(..., input.renameSuffix)` / `(..., renameSuffix)` — propagar o `renameSuffix`. `copyAdsetInto` ganha o param `renameSuffix?`.

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm --filter @trafego/ads-meta test -- creation`
Expected: PASS (novo + todos os de duplicação existentes).

- [ ] **Step 5: Revisar (cadência) e commitar**

```bash
git add packages/ads-meta/src/creation.ts packages/ads-meta/src/creation.test.ts
git commit -m "feat(ads-meta): fallback por-nó — reconstrói anúncio (creative_id) quando /copies bate muro"
```

---

### Task 4: Reconstruir CONJUNTO (espelho de campos crus + modernização) + fallback por-nó

Fecha a feature: conjunto que bate no muro da atribuição é reconstruído espelhando os campos crus da fonte, omitindo a `attribution_spec` descontinuada (Meta assume janela válida → emite `ModernizationNote`), e seus anúncios entram via `copyOrReconstructAdsInto` (Task 3). Aqui o `duplicateEntity` passa a acumular as notas de verdade.

**Files:**
- Modify: `packages/ads-meta/src/creation.ts` (`duplicateEntity` acumula notas; `copyAdsetInto` → `copyOrReconstructAdsetInto`; novo `reconstructAdsetInto`; const `ADSET_MIRROR_FIELDS`; helper `mirrorAdsetParams`)
- Test: `packages/ads-meta/src/creation.test.ts`

**Interfaces:**
- Consumes: `createOnAccount`, `copyOrReconstructAdsInto` (Task 3), `shallowCopy`, `AdsPlatformError`, `ModernizationNote`.
- Produces: `DuplicateResult.modernizations` preenchido de verdade.

- [ ] **Step 1: Teste que falha** — `/copies` de um conjunto falha com `1885423`; espera reconstrução via `POST /adsets` (SEM `attribution_spec`, COM `optimization_goal`/`targeting`/`promoted_object` espelhados), anúncios recriados, e `res.modernizations` contendo `attribution_window_modernized`.

```ts
it("conjunto com atribuição descontinuada → reconstrói (espelha campos, omite attribution) + nota de modernização", async () => {
  const stub = stubTree({
    adsets: { C_SRC: ["AS_OLD"] }, ads: { AS_OLD: ["AD1"] }, creativeOf: { AD1: "CRE_1" },
    adsetFields: { AS_OLD: { name: "conj", optimization_goal: "CONVERSATIONS", billing_event: "IMPRESSIONS", targeting: { age_min: 25 }, promoted_object: { pixel_id: "PX" }, attribution_spec: [{ event_type: "CLICK_THROUGH", window_days: 7 }] } },
    failCopyOn: ["AS_OLD"], failCopySubcode: 1885423,
  });
  const svc = new MetaCreationService(stub.client);
  const res = await svc.duplicateEntity(ACCOUNT, { sourceLevel: "campaign", sourceId: "C_SRC", status: "paused" });
  expect(res.modernizations).toContainEqual({ code: "attribution_window_modernized" });
  const posted = stub.posted("adsets")[0];
  expect(posted).toMatchObject({ optimization_goal: "CONVERSATIONS", billing_event: "IMPRESSIONS" });
  expect(posted).not.toHaveProperty("attribution_spec");
});
```

(estender o `stubTree`: `adsetFields` devolvidos no `GET {id}?fields=...`.)

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm --filter @trafego/ads-meta test -- creation`
Expected: FAIL.

- [ ] **Step 3: Implementar** (`creation.ts`)

Const de campos espelhados (genérico — cobre dynamic creative via `is_dynamic_creative`; catálogo via `promoted_object`; o criativo é referenciado nos ads):

```ts
/** Campos crus do conjunto que a reconstrução espelha da fonte. `attribution_spec` é LIDO só p/
 *  detectar modernização — NUNCA reescrito (a Meta assume a janela válida do objetivo). */
const ADSET_MIRROR_FIELDS = "name,optimization_goal,billing_event,bid_strategy,bid_amount,daily_budget,lifetime_budget,promoted_object,destination_type,targeting,is_dynamic_creative,attribution_spec" as const;

interface RawSourceAdset {
  readonly name?: string;
  readonly optimization_goal?: string;
  readonly billing_event?: string;
  readonly bid_strategy?: string;
  readonly bid_amount?: string | number;
  readonly daily_budget?: string | number;
  readonly lifetime_budget?: string | number;
  readonly promoted_object?: unknown;
  readonly destination_type?: string;
  readonly targeting?: unknown;
  readonly is_dynamic_creative?: boolean;
}
```

`mirrorAdsetParams` (puro — monta o body do POST a partir dos campos presentes; omite atribuição):

```ts
/** Traduz os campos crus da fonte no body do `POST /adsets`. Só inclui o que está presente
 *  (a Meta rejeita budget nos dois níveis; campos ausentes ficam no default válido). */
function mirrorAdsetParams(src: RawSourceAdset, campaignId: string, status: "active" | "paused", renameSuffix?: string): Record<string, string> {
  const p: Record<string, string> = {
    name: withRenameSuffix(src.name ?? "conjunto", renameSuffix),
    campaign_id: campaignId,
    status: status === "active" ? STATUS_ACTIVE_CREATE : STATUS_PAUSED_CREATE,
  };
  if (src.optimization_goal) p["optimization_goal"] = src.optimization_goal;
  if (src.billing_event) p["billing_event"] = src.billing_event;
  if (src.bid_strategy) p["bid_strategy"] = src.bid_strategy;
  if (src.bid_amount) p["bid_amount"] = String(src.bid_amount);
  if (Number(src.daily_budget) > 0) p["daily_budget"] = String(src.daily_budget);
  else if (Number(src.lifetime_budget) > 0) p["lifetime_budget"] = String(src.lifetime_budget);
  if (src.promoted_object) p["promoted_object"] = JSON.stringify(src.promoted_object);
  if (src.destination_type) p["destination_type"] = src.destination_type;
  if (src.targeting) p["targeting"] = JSON.stringify(src.targeting);
  if (src.is_dynamic_creative) p["is_dynamic_creative"] = "true";
  return p;
}
```

`reconstructAdsetInto` (empurra a nota no acumulador; reusa a Task 3 pros ads):

```ts
/** Recria UM conjunto na campanha destino espelhando os campos crus da fonte, OMITINDO a janela
 *  de atribuição descontinuada (→ nota de modernização). Ads via copyOrReconstructAdsInto. */
private async reconstructAdsetInto(account: AdAccountRef, srcAdsetId: string, campaignId: string, status: "active" | "paused", renameSuffix: string | undefined, notes: ModernizationNote[]): Promise<{ newAdsetId: string; newAdIds: string[] }> {
  const { data } = await this.client.request<RawSourceAdset>({
    method: "GET", path: srcAdsetId, accessToken: account.accessToken, params: { fields: ADSET_MIRROR_FIELDS },
  });
  const newAdsetId = await this.createOnAccount(account, "adsets", mirrorAdsetParams(data, campaignId, status, renameSuffix));
  notes.push({ code: "attribution_window_modernized" });
  const newAdIds = await this.copyOrReconstructAdsInto(account, srcAdsetId, status, newAdsetId, renameSuffix);
  return { newAdsetId, newAdIds };
}
```

`copyOrReconstructAdsetInto` (substitui `copyAdsetInto`, linha ~146):

```ts
private async copyOrReconstructAdsetInto(account: AdAccountRef, srcAdset: string, status: "active" | "paused", campaignId: string, renameSuffix: string | undefined, notes: ModernizationNote[]): Promise<{ newAdsetId: string; newAdIds: string[] }> {
  try {
    const newAdsetId = await this.shallowCopy(account, srcAdset, status, { campaign_id: campaignId });
    const newAdIds = await this.copyOrReconstructAdsInto(account, srcAdset, status, newAdsetId, renameSuffix);
    return { newAdsetId, newAdIds };
  } catch (error) {
    if (error instanceof AdsPlatformError && error.kind === "not_duplicable") {
      return this.reconstructAdsetInto(account, srcAdset, campaignId, status, renameSuffix, notes);
    }
    throw error;
  }
}
```

`duplicateEntity` campaign-path (linha ~111) — acumular notas e devolvê-las:

```ts
    if (input.sourceLevel === "campaign") {
      const newCampaignId = await this.shallowCopy(account, input.sourceId, input.status, undefined, input.renameSuffix);
      const notes: ModernizationNote[] = [];
      try {
        const childAdsetIds: string[] = [];
        const childIds: string[] = [];
        for (const srcAdset of await this.listChildIds(account, input.sourceId, "adsets")) {
          const { newAdsetId, newAdIds } = await this.copyOrReconstructAdsetInto(account, srcAdset, input.status, newCampaignId, input.renameSuffix, notes);
          childAdsetIds.push(newAdsetId);
          childIds.push(...newAdIds);
        }
        return { copiedId: newCampaignId, childIds, childAdsetIds, modernizations: dedupeNotes(notes) };
      } catch (error) {
        await this.revertRoot(account, newCampaignId);
        throw error;
      }
    }
```

Para o adset-path (linha ~127) e ad-path do `duplicateEntity`: quando a raiz duplicada é um conjunto/anúncio e o próprio `shallowCopy` da raiz bate `not_duplicable`, reconstruir a raiz também. Ajustar:

```ts
    if (input.sourceLevel === "adset") {
      const notes: ModernizationNote[] = [];
      const campaignId = input.destinationCampaignId;
      try {
        const newAdsetId = await this.shallowCopy(account, input.sourceId, input.status, campaignId ? { campaign_id: campaignId } : undefined, input.renameSuffix);
        const newAdIds = await this.copyOrReconstructAdsInto(account, input.sourceId, input.status, newAdsetId, input.renameSuffix);
        return { copiedId: newAdsetId, childIds: newAdIds, childAdsetIds: [], modernizations: [] };
      } catch (error) {
        if (error instanceof AdsPlatformError && error.kind === "not_duplicable" && campaignId) {
          const { newAdsetId, newAdIds } = await this.reconstructAdsetInto(account, input.sourceId, campaignId, input.status, input.renameSuffix, notes);
          return { copiedId: newAdsetId, childIds: newAdIds, childAdsetIds: [], modernizations: dedupeNotes(notes) };
        }
        throw error;
      }
    }
    // anúncio (folha)
    try {
      const reparent = input.destinationCampaignId ? { campaign_id: input.destinationCampaignId } : undefined;
      const copiedId = await this.shallowCopy(account, input.sourceId, input.status, reparent, input.renameSuffix);
      return { copiedId, childIds: [], childAdsetIds: [], modernizations: [] };
    } catch (error) {
      if (error instanceof AdsPlatformError && error.kind === "not_duplicable" && input.destinationAdsetId) {
        const copiedId = await this.reconstructAdInto(account, input.sourceId, input.destinationAdsetId, input.status, input.renameSuffix);
        return { copiedId, childIds: [], childAdsetIds: [], modernizations: [] };
      }
      throw error;
    }
```

> Nota de escopo: reconstruir um **adset/ad como raiz** exige um pai destino (`destinationCampaignId`/`destinationAdsetId`). `destinationAdsetId` não existe hoje no `DuplicateEntityInput` — como o caso real (o card) é duplicação de **campanha**, deixar o ad-root-reconstruct guardado por `input.destinationAdsetId` (opcional, ausente hoje = cai na rede tenta-e-reverte) e **não** adicionar o campo agora (YAGNI). Remover o ramo `destinationAdsetId` se preferir manter o input intacto; o essencial é o campaign-path.

Helper `dedupeNotes` (uma nota por código):

```ts
function dedupeNotes(notes: readonly ModernizationNote[]): ModernizationNote[] {
  const seen = new Set<string>();
  return notes.filter((n) => (seen.has(n.code) ? false : (seen.add(n.code), true)));
}
```

Remover o `modernizations: []` provisório da Task 2 onde agora há acumulador real.

- [ ] **Step 4: Rodar e ver passar** (+ um teste da REDE: reconstrução cujo `POST /adsets` falha com erro comum → `revertRoot` chamado + erro propaga)

```ts
it("reconstrução que a Meta rejeita (tipo divergente) → reverte a raiz + propaga (rede honesta)", async () => {
  const stub = stubTree({ adsets: { C_SRC: ["AS_OLD"] }, ads: { AS_OLD: [] }, adsetFields: { AS_OLD: { name: "x" } }, failCopyOn: ["AS_OLD"], failCopySubcode: 1885423, failCreateOn: ["adsets"] });
  const svc = new MetaCreationService(stub.client);
  await expect(svc.duplicateEntity(ACCOUNT, { sourceLevel: "campaign", sourceId: "C_SRC", status: "paused" })).rejects.toBeTruthy();
  expect(stub.deleted()).toContain(stub.copiedId("C_SRC")); // raiz revertida
});
```

Run: `pnpm --filter @trafego/ads-meta test -- creation && pnpm --filter worker typecheck`
Expected: PASS.

- [ ] **Step 5: Revisar (cadência) e commitar**

```bash
git add packages/ads-meta/src/creation.ts packages/ads-meta/src/creation.test.ts
git commit -m "feat(ads-meta): reconstrói conjunto (espelho de campos, moderniza atribuição) — duplicação funciona em conta antiga"
```

---

### Task 5: Card do site mostra as notas de modernização

O desfecho já carrega o texto (o `describeDraftOutcome` anexa as notas na Task 2), então **se o card já renderiza a string de desfecho, esta task pode ser só verificação visual**. Confirmar; só há trabalho se o card renderiza campos estruturados em vez da string única.

**Files:**
- Verify/Modify: `apps/web/src/app/features/approvals/approvals-page.ts` (ou o componente do card de rascunho que exibe o desfecho)
- Verify: reuso de `apps/web/src/app/shared/ui/ui-callout.ts`

- [ ] **Step 1:** Ler o componente que renderiza o desfecho do rascunho aplicado. Se ele já mostra a string vinda da API (`describeDraftOutcome`), a nota aparece automaticamente → **sem código**, só um teste/checagem visual.

- [ ] **Step 2:** Se o card monta o texto por conta própria (não usa a string da API), ajustar para exibir a string de desfecho da API (fonte única) — nunca duplicar a copy no front.

- [ ] **Step 3:** Verificar no browser (preview) um rascunho `created` com modernização (pode forçar via seed/estado) — a nota "ajustei a janela de atribuição pra 1 dia" aparece no card.

- [ ] **Step 4:** `pnpm --filter web build` (AOT) — garantir que nada quebrou.

- [ ] **Step 5: Revisar (cadência, se houve mudança) e commitar**

```bash
git add apps/web
git commit -m "feat(web): card de desfecho exibe a nota de modernização da duplicação (fonte única da API)"
```

---

## Self-Review

- **Cobertura do spec:** classificador (`1885423`) = Task 1; fallback por-nó = Task 3 (ad) + Task 4 (adset); espelho genérico type-agnostic = `mirrorAdsetParams` + `is_dynamic_creative`/`promoted_object` (Task 4); rede tenta-e-reverte = herda `revertRoot` + teste da rede (Task 4 Step 4); avisar modernização = `ModernizationNote` + `describeDraftOutcome` (Task 2) preenchido na Task 4; pro-usuário-é-cópia = create vs copy nunca surge, só o delta real. ✔
- **Placeholders:** nenhum "TBD/etc" — cada step tem código real. ✔
- **Consistência de tipos:** `copyOrReconstructAdsInto`/`copyOrReconstructAdsetInto`/`reconstructAdInto`/`reconstructAdsetInto`/`mirrorAdsetParams`/`dedupeNotes`/`withRenameSuffix`/`readModernizations`/`ModernizationNote`/`NOT_DUPLICABLE_SUBCODES` usados com a mesma assinatura em todas as tasks. `DuplicateResult.modernizations` adicionado na Task 2 e preenchido na Task 4. ✔
- **Atomicidade:** reconstrução sempre dentro do try/catch que reverte a raiz — nunca deixa árvore parcial. ✔
- **Reuso:** `createOnAccount`, `listChildIds`, `revertRoot`, `shallowCopy`, `AdsPlatformError`, pipe do `targetingFallback`, `ui-callout`. Nada novo que já exista. ✔

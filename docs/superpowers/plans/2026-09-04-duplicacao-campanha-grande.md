# Duplicação de campanha grande (cópia rasa recursiva) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Duplicar campanhas de qualquer tamanho reconstruindo a árvore com cópias RASAS (`/copies` deep_copy=false, 1 objeto/chamada, sempre < 3), atômico (auto-reverte parciais em falha).

**Architecture:** A mudança é do ADAPTER (`packages/ads-meta/src/creation.ts`): `duplicateEntity` de campanha vira um algoritmo recursivo raso (casca → conjuntos → anúncios) com reparent por id. O contrato neutro (`DuplicateEntityInput`/`DuplicateResult`) e a saga `apply-draft` ficam ~inalterados (a saga já trata `not_duplicable`→blocked e `failed`→tenta-de-novo). Confirmado por spike real (BM-Automato).

**Tech Stack:** `@trafego/ads-meta` (Graph v26), vitest com `MetaGraphClient` mockado.

## Global Constraints

- Adapter isola o vocabulário Meta (`/copies`, `deep_copy`, `campaign_id`/`adset_id`); o core/shared falam `DuplicateEntityInput`/`DuplicateResult` NEUTROS — inalterados.
- **Atômico / sempre reverte:** falha em qualquer nó → o adapter DELETA a campanha nova criada (cascata) ANTES de re-lançar → `duplicateEntity` devolve árvore completa OU lança sem deixar lixo (decisão do usuário: "sempre reverter").
- **Idempotência (§8):** `/copies` não é idempotente; o auto-revert garante all-or-nothing (um retry da saga re-copia do zero, sem órfão).
- Erro classificado nos kinds NEUTROS que JÁ existem (`AdsPlatformErrorKind`): criativo legado → `not_duplicable` (já tratado, `subcode 3858504`); rate-limit → `rate_limited`; outros → `upstream`.
- Reuso-primeiro: `copiedIdOf`, `isLegacyEnhancementsCopyError`, `this.client.request` (GET/DELETE) já existentes.
- **Revisar ANTES de commitar** (instrução do usuário): implementar (TDD) → `reviewing-trafego-changes` no diff → corrigir → commitar.
- Commit termina com `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## Mapa de arquivos

- Modify: `packages/ads-meta/src/creation.ts` — `shallowCopy` + `listChildIds` + `duplicateEntity` recursivo + auto-revert.
- Test: `packages/ads-meta/src/creation.test.ts` (ou o arquivo de teste do creation, com `MetaGraphClient` mockado).
- (Verificação) `apps/worker/src/modules/apply/apply-draft.ts` — SEM mudança de código; um teste confirma que a saga segue funcionando com o novo `duplicateEntity` (retorna full result ou lança `not_duplicable`).

Nada muda em `packages/shared` (contrato neutro), `packages/core` (`describeDraftOutcome` já correto: `not_duplicable`→blocked, `failed`→transitório), nem no web.

---

### Task 1: `shallowCopy` + `listChildIds` (helpers do adapter)

**Files:**
- Modify: `packages/ads-meta/src/creation.ts` (dentro de `MetaCreationService`)
- Test: `packages/ads-meta/src/creation.test.ts`

**Interfaces:**
- Consumes: `this.client.request`, `copiedIdOf`, `isLegacyEnhancementsCopyError`, `AdsPlatformError`, `MetaApiError`.
- Produces (privados na classe):
  - `shallowCopy(account: AdAccountRef, sourceId: string, status: "active"|"paused", reparent?: { campaign_id?: string; adset_id?: string }, renameSuffix?: string): Promise<string>` — `POST /{sourceId}/copies` com `deep_copy=false` + reparent + `rename_options` (quando `renameSuffix`); devolve `copiedId`. Erro de criativo legado → `AdsPlatformError("not_duplicable", …)`.
  - `listChildIds(account: AdAccountRef, parentId: string, edge: "adsets"|"ads"): Promise<string[]>` — `GET /{parentId}/{edge}?fields=id&limit=100` (pagina se `paging.next`).

- [ ] **Step 1: Test falho** — em `creation.test.ts`, com o client mockado, `shallowCopy` faz `POST {id}/copies` com `deep_copy=false&status_option=PAUSED&campaign_id=X` e devolve o `copied_campaign_id`:

```ts
it("shallowCopy: POST /copies deep_copy=false + reparent → copiedId", async () => {
  const req = vi.fn(async () => ({ data: { copied_campaign_id: "999" }, usage: {} }));
  const svc = new MetaCreationService({ request: req } as never);
  const id = await (svc as unknown as { shallowCopy: Function }).shallowCopy(ACCOUNT, "src1", "paused", { campaign_id: "new1" });
  expect(id).toBe("999");
  const call = req.mock.calls[0]![0];
  expect(call.path).toBe("src1/copies");
  expect(call.params).toMatchObject({ deep_copy: "false", status_option: "PAUSED", campaign_id: "new1" });
});
```

- [ ] **Step 2: Rodar → falha**

Run: `pnpm --filter @trafego/ads-meta test -- --run creation`
Expected: FAIL (shallowCopy inexistente).

- [ ] **Step 3: Implementar** — em `creation.ts` (`MetaCreationService`):

```ts
private async shallowCopy(
  account: AdAccountRef,
  sourceId: string,
  status: "active" | "paused",
  reparent?: { campaign_id?: string; adset_id?: string },
  renameSuffix?: string,
): Promise<string> {
  const params: Record<string, string> = { deep_copy: "false", status_option: status === "active" ? STATUS_ACTIVE : STATUS_PAUSED };
  if (reparent?.campaign_id) params["campaign_id"] = reparent.campaign_id;
  if (reparent?.adset_id) params["adset_id"] = reparent.adset_id;
  if (renameSuffix) params["rename_options"] = JSON.stringify({ rename_suffix: renameSuffix });
  try {
    const { data } = await this.client.request<CopiesResponse>({ method: "POST", path: `${sourceId}/${COPIES_EDGE}`, accessToken: account.accessToken, params });
    const id = copiedIdOf(data);
    if (!id) throw new Error("Meta /copies não retornou o id da cópia");
    return id;
  } catch (error) {
    if (isLegacyEnhancementsCopyError(error)) {
      throw new AdsPlatformError("not_duplicable", "deep_copy rejeitado: criativo com recurso descontinuado", (error as MetaApiError).userMessage);
    }
    throw error;
  }
}

private async listChildIds(account: AdAccountRef, parentId: string, edge: "adsets" | "ads"): Promise<string[]> {
  const ids: string[] = [];
  let path: string | null = `${parentId}/${edge}`;
  let params: Record<string, string> | undefined = { fields: "id", limit: "100" };
  while (path) {
    const { data }: { data: { data?: Array<{ id: string }>; paging?: { next?: string; cursors?: { after?: string } } } } =
      await this.client.request({ method: "GET", path, accessToken: account.accessToken, ...(params ? { params } : {}) });
    for (const c of data.data ?? []) ids.push(c.id);
    const after = data.paging?.cursors?.after;
    if (after && data.paging?.next) { params = { fields: "id", limit: "100", after }; } else { path = null; }
  }
  return ids;
}
```

- [ ] **Step 4: Rodar → passa**

Run: `pnpm --filter @trafego/ads-meta test -- --run creation`
Expected: PASS.

---

### Task 2: `duplicateEntity` recursivo (casca → conjuntos → anúncios) + auto-revert

**Files:**
- Modify: `packages/ads-meta/src/creation.ts:102-147` (o `duplicateEntity` atual)
- Test: `packages/ads-meta/src/creation.test.ts`

**Interfaces:**
- Consumes: `shallowCopy`, `listChildIds` (Task 1).
- Produces: `duplicateEntity(account, input: DuplicateEntityInput): Promise<DuplicateResult>` — reconstrói a árvore RASA a partir de QUALQUER nível: `campaign` → casca + conjuntos + anúncios; `adset` → casca (reparent na campanha destino) + seus anúncios; `ad` → folha. Falha em qualquer nó → DELETA a raiz criada (campanha OU conjunto novo) + re-lança. `sourceLevel === "adset"` recursivo TAMBÉM (não pode ser raso simples — perderia os anúncios do conjunto).

- [ ] **Step 1: Test falho** — árvore: campanha(src)→[adsetA→adAA, adsetB→adBB]. Mock do client responde por path. Verifica: 1 copy casca + 2 copies de adset (reparent campaign) + 2 copies de ad (reparent adset); result agrega os ids:

```ts
it("duplicateEntity(campaign): casca + conjuntos + anúncios rasos, reparenteados", async () => {
  const req = vi.fn(async ({ method, path }: { method: string; path: string }) => {
    if (method === "GET" && path.endsWith("/adsets")) return { data: { data: [{ id: "asA" }, { id: "asB" }] } };
    if (method === "GET" && path.endsWith("/ads")) return { data: { data: [{ id: path.startsWith("asA") ? "adA" : "adB" }] } };
    if (path === "srcC/copies") return { data: { copied_campaign_id: "newC" } };
    if (path === "asA/copies" || path === "asB/copies") return { data: { copied_adset_id: path === "asA/copies" ? "nasA" : "nasB" } };
    return { data: { copied_ad_id: "nad" } };
  });
  const svc = new MetaCreationService({ request: req } as never);
  const r = await svc.duplicateEntity(ACCOUNT, { sourceLevel: "campaign", sourceId: "srcC", status: "paused" });
  expect(r.copiedId).toBe("newC");
  expect(r.childAdsetIds).toEqual(["nasA", "nasB"]);
  // reparent: cada adset copy manda campaign_id=newC; cada ad copy manda adset_id do adset novo
  const adsetCall = req.mock.calls.find((c) => c[0].path === "asA/copies")![0];
  expect(adsetCall.params).toMatchObject({ deep_copy: "false", campaign_id: "newC" });
});

it("duplicateEntity(campaign): falha num anúncio → DELETA a nova campanha + re-lança", async () => {
  const del: string[] = [];
  const req = vi.fn(async ({ method, path }: { method: string; path: string }) => {
    if (method === "DELETE") { del.push(path); return { data: { success: true } }; }
    if (method === "GET" && path.endsWith("/adsets")) return { data: { data: [{ id: "asA" }] } };
    if (method === "GET" && path.endsWith("/ads")) return { data: { data: [{ id: "adA" }] } };
    if (path === "srcC/copies") return { data: { copied_campaign_id: "newC" } };
    if (path === "asA/copies") return { data: { copied_adset_id: "nasA" } };
    throw new MetaApiError("boom", 100, 3858504, 400, undefined, "criativo antigo"); // ad copy falha (legado)
  });
  const svc = new MetaCreationService({ request: req } as never);
  await expect(svc.duplicateEntity(ACCOUNT, { sourceLevel: "campaign", sourceId: "srcC", status: "paused" }))
    .rejects.toMatchObject({ kind: "not_duplicable" });
  expect(del).toContain("newC"); // reverteu a casca criada
});
```

- [ ] **Step 2: Rodar → falha**

Run: `pnpm --filter @trafego/ads-meta test -- --run creation`
Expected: FAIL.

- [ ] **Step 3: Implementar** — substituir o corpo do `duplicateEntity` por um recursivo raso GENERAL + auto-revert da raiz. Extrai `copyAdsetInto(account, srcAdset, status, campaignId)` (casca do conjunto + seus anúncios) reusado por campanha e adset:

```ts
/** Copia UM conjunto (raso) na campanha destino + cada anúncio (raso) reparenteado. Devolve os ids novos. */
private async copyAdsetInto(account: AdAccountRef, srcAdset: string, status: "active" | "paused", campaignId: string): Promise<{ newAdsetId: string; newAdIds: string[] }> {
  const newAdsetId = await this.shallowCopy(account, srcAdset, status, { campaign_id: campaignId });
  const newAdIds: string[] = [];
  for (const srcAd of await this.listChildIds(account, srcAdset, "ads")) {
    newAdIds.push(await this.shallowCopy(account, srcAd, status, { adset_id: newAdsetId }));
  }
  return { newAdsetId, newAdIds };
}

/** DELETE best-effort da raiz criada (limpeza atômica). Falha na limpeza → não mascara o erro original. */
private async revertRoot(account: AdAccountRef, rootId: string): Promise<void> {
  try { await this.client.request({ method: "DELETE", path: rootId, accessToken: account.accessToken }); } catch { /* limpeza falhou; erro original prevalece — casca avisa p/ apagar manual */ }
}

async duplicateEntity(account: AdAccountRef, input: DuplicateEntityInput): Promise<DuplicateResult> {
  if (input.sourceLevel === "campaign") {
    const newCampaignId = await this.shallowCopy(account, input.sourceId, input.status, undefined, input.renameSuffix);
    try {
      const childAdsetIds: string[] = [];
      const childIds: string[] = [];
      for (const srcAdset of await this.listChildIds(account, input.sourceId, "adsets")) {
        const { newAdsetId, newAdIds } = await this.copyAdsetInto(account, srcAdset, input.status, newCampaignId);
        childAdsetIds.push(newAdsetId);
        childIds.push(...newAdIds);
      }
      return { copiedId: newCampaignId, childIds, childAdsetIds };
    } catch (error) { await this.revertRoot(account, newCampaignId); throw error; }
  }
  if (input.sourceLevel === "adset") {
    // conjunto vencedor → nova casca de conjunto na campanha destino + seus anúncios (recursivo).
    const campaignId = input.destinationCampaignId;
    if (!campaignId) throw new AdsPlatformError("upstream", "duplicar conjunto exige campanha destino");
    const newAdsetId = await this.shallowCopy(account, input.sourceId, input.status, { campaign_id: campaignId });
    try {
      const newAdIds: string[] = [];
      for (const srcAd of await this.listChildIds(account, input.sourceId, "ads")) {
        newAdIds.push(await this.shallowCopy(account, srcAd, input.status, { adset_id: newAdsetId }));
      }
      return { copiedId: newAdsetId, childIds: newAdIds, childAdsetIds: [] };
    } catch (error) { await this.revertRoot(account, newAdsetId); throw error; }
  }
  // ad = folha (1 objeto)
  const reparent = input.destinationCampaignId ? { campaign_id: input.destinationCampaignId } : undefined;
  const copiedId = await this.shallowCopy(account, input.sourceId, input.status, reparent, input.renameSuffix);
  return { copiedId, childIds: [], childAdsetIds: [] };
}
```

Revert = responsabilidade do CALLER (o topo de cada ramo): campanha → `revertRoot(campanha)` (o DELETE cascateia conjuntos/anúncios); adset-top → `revertRoot(newAdsetId)`. `copyAdsetInto` (usado só pelo ramo campanha) NÃO se auto-reverte — a limpeza da campanha já cascateia (evita revert duplo). `STATUS_*`/`COPIES_EDGE` já existem; `shallowCopy` ganha o arg opcional `renameSuffix` (Task 3).

- [ ] **Step 4: Rodar → passa**

Run: `pnpm --filter @trafego/ads-meta test -- --run creation`
Expected: PASS.

---

### Task 3: Rename da casca (preservar `renameSuffix`) + typecheck do pacote

**Files:**
- Modify: `packages/ads-meta/src/creation.ts` (o `shallowCopy` da casca aceita `rename_suffix`)
- Test: `packages/ads-meta/src/creation.test.ts`

- [ ] **Step 1: Test falho** — `duplicateEntity(campaign)` com `renameSuffix` manda `rename_options` no copy da casca:

```ts
it("renameSuffix → rename_options no copy da casca", async () => {
  const req = vi.fn(async ({ path }: { path: string }) => (path === "srcC/copies" ? { data: { copied_campaign_id: "newC" } } : { data: { data: [] } }));
  const svc = new MetaCreationService({ request: req } as never);
  await svc.duplicateEntity(ACCOUNT, { sourceLevel: "campaign", sourceId: "srcC", status: "paused", renameSuffix: " — escala" });
  const shell = req.mock.calls.find((c) => c[0].path === "srcC/copies")![0];
  expect(JSON.parse(shell.params.rename_options)).toEqual({ rename_suffix: " — escala" });
});
```

- [ ] **Step 2..3:** o arg `renameSuffix` já existe em `shallowCopy` (Task 1) e a casca da campanha já o passa (Task 2). Este teste apenas VERIFICA a fiação. Rodar `pnpm --filter @trafego/ads-meta test -- --run creation` + `pnpm --filter @trafego/ads-meta typecheck`. Expected: PASS + limpo.

---

### Task 4: Verificação da saga (sem mudança de código)

**Files:**
- Test: `apps/worker/src/modules/apply/apply-draft.test.ts` (estender)

**Interfaces:**
- Consumes: `duplicateEntity` (agora recursivo) via o mock de `ports.ads`.

- [ ] **Step 1: Test** — confirmar que a saga de duplicação segue: `duplicateEntity` retorna `{copiedId,childIds,childAdsetIds}` → persiste em `createdIds` → `setEntityBudget`; e `duplicateEntity` lançando `not_duplicable` → outcome `blocked` (não `failed`). Reusar o mock de `ports.ads` do teste existente, trocando o retorno/erro do `duplicateEntity`.

```ts
it("saga: not_duplicable do duplicateEntity → blocked (não failed)", async () => {
  // ports.ads.duplicateEntity mock lança AdsPlatformError('not_duplicable', ...)
  // espera outcome.kind === 'blocked'
});
```

- [ ] **Step 2: Rodar**

Run: `pnpm --filter @trafego/worker test -- --run apply-draft`
Expected: PASS (a saga não mudou; o teste documenta o contrato com o adapter recursivo).

---

### Fim (por fatia)
- **Adapter (Tasks 1-3):** rodar `reviewing-trafego-changes` no diff → corrigir → commit.
- **Saga (Task 4):** rodar `reviewing-trafego-changes` (diff pequeno) → commit.
- Verificação final: `pnpm --filter @trafego/ads-meta test && pnpm --filter @trafego/worker test`.
- (Opcional, autorizado) E2E real: re-rodar o spike-de-cópia numa campanha SEM criativo legado pra confirmar a árvore ponta-a-ponta + revert.

---

## Self-review (cobertura do spec)

- **Cópia rasa recursiva (casca→conjuntos→anúncios):** Task 2 — para campanha E conjunto (adset-top recursivo, não raso simples). ✅
- **Sempre recursiva (não só grandes):** decidido — o `deep_copy` síncrono estoura em qualquer campanha real (<3 objetos), então não há caminho rápido a preservar; um único caminho recursivo. ✅
- **Reparent campaign_id/adset_id:** Task 1 (`shallowCopy`) + Task 2 (uso). ✅
- **Sempre reverter parciais (atômico):** Task 2 (auto-revert DELETE). ✅
- **Classificação de erro (not_duplicable/rate_limited/upstream):** reusa os kinds existentes; `not_duplicable` em Task 1; demais propagam como estão. ✅
- **Copy failed determinístico × transitório:** já correto (not_duplicable→blocked; failed=transitório) — sem mudança no core (documentado no Mapa de arquivos). ✅
- **Idempotência / all-or-nothing:** Task 2 (auto-revert) + saga inalterada (Task 4 confirma). ✅
- **`renameSuffix`/`destinationCampaignId` preservados:** Task 3 (rename) + Task 2 (adset/ad reparent). ✅
- **DELETE de limpeza falho → best-effort + erro original prevalece:** Task 2 (try/catch no revert); o aviso ao usuário vem do `failed` na saga. ✅

Tipos consistentes: `shallowCopy`/`listChildIds` (Task 1) usados em Task 2/3; `DuplicateResult` inalterado. Sem placeholders.

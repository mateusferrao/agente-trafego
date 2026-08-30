// Camada compartilhada de EDIÇÃO/PERSISTÊNCIA de rascunho de campanha (Fatia 7) — fonte ÚNICA
// pra os DOIS caminhos de edição (chat no worker, painel no site/api) convergirem: ler o rascunho
// aberto, resolver os fragmentos de IO (público) e gravar o spec editado com UPDATE GUARDADO por
// status. Depende só de `db` + PORTAS (desacoplado do canal e do provider de ads). O merge puro +
// as regras (pixel/clamp) vivem no core (`applyDraftEdit`); aqui é a casca (IO + persistência).

import { and, eq } from "drizzle-orm";
import { campaignDrafts } from "@trafego/db";
import type { Database } from "@trafego/db/client";
import type { CampaignDraftSpec, DraftKind, TargetingSpec } from "@trafego/shared";

const DRAFT_OPEN_STATUS = "proposed" as const;

export interface DraftForEdit {
  readonly kind: DraftKind;
  readonly spec: CampaignDraftSpec;
}

export interface DraftRef {
  readonly draftId: string;
  readonly orgId: string;
  /** escopo opcional por conta (defesa em profundidade — o org-scoping já isola o tenant). */
  readonly adAccountId?: string;
}

const scopeOf = (ref: DraftRef) =>
  and(
    eq(campaignDrafts.id, ref.draftId),
    eq(campaignDrafts.orgId, ref.orgId),
    ...(ref.adAccountId ? [eq(campaignDrafts.adAccountId, ref.adAccountId)] : []),
  );

/**
 * Lê um rascunho pra edição, ORG-SCOPED. Só devolve se ainda `proposed` (aberto pra ajuste);
 * qualquer outro estado (creating/created/…) → null (a casca traduz p/ "não está mais aberto").
 */
export async function loadDraftForEdit(db: Database, ref: DraftRef): Promise<DraftForEdit | null> {
  const [row] = await db
    .select({ kind: campaignDrafts.kind, spec: campaignDrafts.spec, status: campaignDrafts.status })
    .from(campaignDrafts)
    .where(scopeOf(ref))
    .limit(1);
  if (!row || row.status !== DRAFT_OPEN_STATUS) return null;
  return { kind: row.kind, spec: row.spec as CampaignDraftSpec };
}

/**
 * Persiste o spec editado com UPDATE GUARDADO por status (`... AND status='proposed'`). Fecha a
 * corrida com o apply virando `creating` DURANTE a IO da edição (LLM/infer podem levar segundos):
 * 0 linhas afetadas = o rascunho não está mais aberto → `false` (a casca avisa, não sobrescreve
 * o estado do apply). Idempotente e seguro pras duas superfícies.
 */
export async function persistDraftSpec(
  db: Database,
  ref: DraftRef,
  nextSpec: CampaignDraftSpec,
): Promise<boolean> {
  const updated = await db
    .update(campaignDrafts)
    .set({ spec: nextSpec })
    .where(and(scopeOf(ref), eq(campaignDrafts.status, DRAFT_OPEN_STATUS)))
    .returning({ id: campaignDrafts.id });
  return updated.length > 0;
}

/**
 * Resolve o modo de PÚBLICO (neutro) → `TargetingSpec` — lógica compartilhada por chat e site.
 * `broad` = Advantage+ amplo; `reuse` = herda o conjunto provado — SEMPRE com retrato (`resolved`),
 * nunca um `reuse_adset` cru (senão o apply leria a fonte AS-IS e a Meta ligaria expansão no default).
 * Já tem retrato → mantém; senão (re)resolve pelo thunk. Nada pra herdar → mantém o atual (não força).
 *
 * `resolveReuse` é um THUNK LAZY que devolve o `reuse_adset` JÁ COM `resolved` (a casca lê o público
 * da fonte + `buildResolvedSnapshot`) — só chamado quando precisa (reuse sem retrato); broad/keep não
 * tocam a conta/token à toa.
 */
export async function resolveAudienceTargeting(
  audience: "reuse" | "broad",
  current: TargetingSpec | undefined,
  resolveReuse: () => Promise<Extract<TargetingSpec, { readonly kind: "reuse_adset" }> | undefined>,
): Promise<TargetingSpec | undefined> {
  if (audience === "broad") return { kind: "advantage_plus" };
  if (current?.kind === "reuse_adset" && current.resolved) return current;
  const resolved = await resolveReuse();
  return resolved ?? current;
}

/**
 * Edição do público `explicit` já resolvido (Fase 1, subfatia 3a/3b) — lógica compartilhada por
 * chat e site (§13 DRY). Remove/adiciona geo(s), estreita idade e/ou ajusta gênero. Remover é SEM
 * chamada nova (o dono já viu essa lista no eco/painel); adicionar já vem RESOLVIDO (a busca
 * aconteceu na casca — `prepareGeo` no worker, `searchGeo` do adapter no site — esta função só funde).
 * `genders`: ausente = mantém; `[]` = limpa (todos); `[1]`/`[2]` = define. Pura.
 */
export function applyExplicitGeoEdit(
  current: Extract<TargetingSpec, { readonly kind: "explicit" }>,
  patch: {
    readonly removeGeo?: readonly string[];
    readonly addGeo?: readonly { readonly key: string; readonly name: string; readonly kind: "country" | "region" | "city" }[];
    readonly ageMin?: number;
    readonly ageMax?: number;
    readonly genders?: readonly (1 | 2)[];
  },
): { readonly kind: "ok"; readonly targeting: TargetingSpec } | { readonly kind: "blocked"; readonly reason: string } {
  let geo = current.geo;
  for (const name of patch.removeGeo ?? []) {
    const before = geo.length;
    geo = geo.filter((g) => !g.name.toLowerCase().includes(name.toLowerCase()));
    if (geo.length === before) {
      return { kind: "blocked", reason: `não achei "${name}" no público atual do rascunho — confere o nome? (hoje: ${current.geo.map((g) => g.name).join(", ")})` };
    }
  }
  if (patch.addGeo && patch.addGeo.length > 0) {
    const existingKeys = new Set(geo.map((g) => g.key));
    geo = [...geo, ...patch.addGeo.filter((g) => !existingKeys.has(g.key))];
  }
  // gênero: destrutura a chave p/ poder LIMPAR (spread de `current` sozinho manteria o valor antigo —
  // `genders` é opcional; array vazio no patch = "todos" e some do targeting).
  const genders = patch.genders === undefined ? current.genders : patch.genders.length > 0 ? patch.genders : undefined;
  const { genders: _drop, ...rest } = current;
  return {
    kind: "ok",
    targeting: {
      ...rest,
      geo,
      ...(patch.ageMin !== undefined ? { ageMin: patch.ageMin } : {}),
      ...(patch.ageMax !== undefined ? { ageMax: patch.ageMax } : {}),
      ...(genders && genders.length > 0 ? { genders } : {}),
    },
  };
}

/**
 * Edição de INTERESSES em GRUPOS (Slice 3) do público `explicit` — compartilhada chat+site (§13 DRY).
 * `interestGroups`: cada grupo = OR interno; grupos entre si = AND (narrowing). Operações:
 * - `removeInterests` (por NOME/substring, sem chamada nova): remove entre TODOS os grupos; grupo que
 *   esvazia some. Nenhum match → bloqueia (nunca aplica em interpretação incerta).
 * - `addInterests` (já RESOLVIDO na casca): OR-widen — adiciona ao 1º grupo (cria um se não há).
 * - `narrowInterests` (já RESOLVIDO): novo grupo AND ("e também/que também curtam" → estreita).
 * Exclusão de interesse NÃO existe (a Meta removeu — spike subcode 3858492). Pura.
 */
type Ref = { readonly id: string; readonly name: string };
type GroupEdit = { readonly remove?: readonly string[] | undefined; readonly add?: readonly Ref[] | undefined; readonly narrow?: readonly Ref[] | undefined };

/** Merge PURO de grupos de direcionamento detalhado (interesse/behavior) — mesma lógica pros dois
 *  (§13 DRY). `remove` por nome entre grupos (drop de grupo vazio; nada casa → bloqueia); `add`
 *  OR-widen no 1º grupo; `narrow` = novo grupo AND. `label` só compõe a mensagem de erro. */
function mergeGroups(
  currentGroups: readonly (readonly Ref[])[] | undefined,
  edit: GroupEdit,
  label: string,
): { readonly ok: true; readonly groups: Ref[][] } | { readonly ok: false; readonly reason: string } {
  let groups: Ref[][] = (currentGroups ?? []).map((g) => [...g]);
  for (const name of edit.remove ?? []) {
    const lower = name.toLowerCase();
    let found = false;
    groups = groups
      .map((g) => {
        const filtered = g.filter((i) => !i.name.toLowerCase().includes(lower));
        if (filtered.length < g.length) found = true;
        return filtered;
      })
      .filter((g) => g.length > 0);
    if (!found) {
      const all = (currentGroups ?? []).flat().map((i) => i.name).join(", ") || "nenhum";
      return { ok: false, reason: `não achei "${name}" ${label} do rascunho — confere o nome? (hoje: ${all})` };
    }
  }
  if (edit.add && edit.add.length > 0) {
    if (groups.length === 0) groups = [[]];
    const existing = new Set(groups[0]!.map((i) => i.id));
    groups[0] = [...groups[0]!, ...edit.add.filter((i) => !existing.has(i.id))];
  }
  if (edit.narrow && edit.narrow.length > 0) groups = [...groups, [...edit.narrow]];
  return { ok: true, groups };
}

export function applyExplicitInterestEdit(
  current: Extract<TargetingSpec, { readonly kind: "explicit" }>,
  patch: {
    readonly removeInterests?: readonly string[];
    readonly addInterests?: readonly Ref[];
    readonly narrowInterests?: readonly Ref[];
  },
): { readonly kind: "ok"; readonly targeting: TargetingSpec } | { readonly kind: "blocked"; readonly reason: string } {
  const r = mergeGroups(current.interestGroups, { remove: patch.removeInterests, add: patch.addInterests, narrow: patch.narrowInterests }, "nos interesses atuais");
  if (!r.ok) return { kind: "blocked", reason: r.reason };
  const { interestGroups: _drop, ...rest } = current;
  return { kind: "ok", targeting: { ...rest, ...(r.groups.length > 0 ? { interestGroups: r.groups } : {}) } };
}

/** Edição de COMPORTAMENTOS em grupos (Slice 4) — espelho do interesse, sobre `behaviorGroups`. Pura. */
export function applyExplicitBehaviorEdit(
  current: Extract<TargetingSpec, { readonly kind: "explicit" }>,
  patch: {
    readonly removeBehaviors?: readonly string[];
    readonly addBehaviors?: readonly Ref[];
    readonly narrowBehaviors?: readonly Ref[];
  },
): { readonly kind: "ok"; readonly targeting: TargetingSpec } | { readonly kind: "blocked"; readonly reason: string } {
  const r = mergeGroups(current.behaviorGroups, { remove: patch.removeBehaviors, add: patch.addBehaviors, narrow: patch.narrowBehaviors }, "nos comportamentos atuais");
  if (!r.ok) return { kind: "blocked", reason: r.reason };
  const { behaviorGroups: _drop, ...rest } = current;
  return { kind: "ok", targeting: { ...rest, ...(r.groups.length > 0 ? { behaviorGroups: r.groups } : {}) } };
}

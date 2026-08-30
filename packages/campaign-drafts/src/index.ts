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
 * `broad` = Advantage+ amplo; `reuse` = herda o conjunto provado (mantém o que o spec já tinha,
 * ou re-infere ao vivo se ainda não havia). Nada pra herdar → mantém o atual (não força).
 *
 * `inferSourceAdset` é um THUNK LAZY: só é chamado quando de fato precisa inferir (reuse SEM
 * herança) — assim broad/keep não carregam contexto de conta/token à toa (a casca resolve o
 * token e chama a plataforma dentro do thunk).
 */
export async function resolveAudienceTargeting(
  audience: "reuse" | "broad",
  current: TargetingSpec | undefined,
  inferSourceAdset: () => Promise<string | undefined>,
): Promise<TargetingSpec | undefined> {
  if (audience === "broad") return { kind: "advantage_plus" };
  if (current?.kind === "reuse_adset") return current;
  const sourceAdsetId = await inferSourceAdset();
  return sourceAdsetId ? { kind: "reuse_adset", sourceAdsetId } : current;
}

/**
 * Edição do público `explicit` já resolvido (Fase 1, subfatia 3a/3b) — lógica compartilhada por
 * chat e site (§13 DRY). Remove/adiciona geo(s) e/ou estreita idade. Remover é SEM chamada nova (o
 * dono já viu essa lista no eco/painel); adicionar já vem RESOLVIDO (a busca aconteceu na casca —
 * `prepareGeo` no worker, `searchGeo` do adapter no site — esta função só funde). Pura.
 */
export function applyExplicitGeoEdit(
  current: Extract<TargetingSpec, { readonly kind: "explicit" }>,
  patch: {
    readonly removeGeo?: readonly string[];
    readonly addGeo?: readonly { readonly key: string; readonly name: string; readonly kind: "country" | "region" | "city" }[];
    readonly ageMin?: number;
    readonly ageMax?: number;
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
  return {
    kind: "ok",
    targeting: { ...current, geo, ...(patch.ageMin !== undefined ? { ageMin: patch.ageMin } : {}), ...(patch.ageMax !== undefined ? { ageMax: patch.ageMax } : {}) },
  };
}

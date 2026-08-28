// Camada compartilhada de EDIÇÃO/PERSISTÊNCIA de rascunho de campanha (Fatia 7) — fonte ÚNICA
// pra os DOIS caminhos de edição (chat no worker, painel no site/api) convergirem: ler o rascunho
// aberto, resolver os fragmentos de IO (público) e gravar o spec editado com UPDATE GUARDADO por
// status. Depende só de `db` + PORTAS (desacoplado do canal e do provider de ads). O merge puro +
// as regras (pixel/clamp) vivem no core (`applyDraftEdit`); aqui é a casca (IO + persistência).

import { and, eq } from "drizzle-orm";
import { campaignDrafts } from "@trafego/db";
import type { Database } from "@trafego/db/client";
import type { CampaignDraftSpec, DraftKind, TargetingSpec } from "@trafego/shared";
import type { AdAccountRef, AdsPlatformPort } from "@trafego/shared/ports";

const DRAFT_OPEN_STATUS = "proposed" as const;

export interface DraftForEdit {
  readonly kind: DraftKind;
  readonly spec: CampaignDraftSpec;
}

export interface DraftRef {
  readonly draftId: string;
  readonly orgId: string;
}

/**
 * Lê um rascunho pra edição, ORG-SCOPED. Só devolve se ainda `proposed` (aberto pra ajuste);
 * qualquer outro estado (creating/created/…) → null (a casca traduz p/ "não está mais aberto").
 */
export async function loadDraftForEdit(db: Database, ref: DraftRef): Promise<DraftForEdit | null> {
  const [row] = await db
    .select({ kind: campaignDrafts.kind, spec: campaignDrafts.spec, status: campaignDrafts.status })
    .from(campaignDrafts)
    .where(and(eq(campaignDrafts.id, ref.draftId), eq(campaignDrafts.orgId, ref.orgId)))
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
    .where(
      and(
        eq(campaignDrafts.id, ref.draftId),
        eq(campaignDrafts.orgId, ref.orgId),
        eq(campaignDrafts.status, DRAFT_OPEN_STATUS),
      ),
    )
    .returning({ id: campaignDrafts.id });
  return updated.length > 0;
}

/**
 * Resolve o modo de PÚBLICO (neutro) → `TargetingSpec` — IO compartilhada por chat e site.
 * `broad` = Advantage+ amplo; `reuse` = herda o conjunto provado (mantém o que o spec já tinha,
 * ou re-infere ao vivo se ainda não havia). Nada pra herdar → mantém o atual (não força).
 */
export async function resolveAudienceTargeting(
  ads: Pick<AdsPlatformPort, "inferCreationDefaults">,
  accountRef: AdAccountRef,
  audience: "reuse" | "broad",
  current: TargetingSpec | undefined,
): Promise<TargetingSpec | undefined> {
  if (audience === "broad") return { kind: "advantage_plus" };
  if (current?.kind === "reuse_adset") return current;
  const defaults = await ads.inferCreationDefaults(accountRef);
  return defaults.sourceAdsetId ? { kind: "reuse_adset", sourceAdsetId: defaults.sourceAdsetId } : current;
}

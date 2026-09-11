// Decisões PURAS do anexar-criativo-a-campanha (attach) — sem IO. A casca (producer) faz as leituras
// (campanha por nome, conjuntos do alvo, anúncios do conjunto) e chama estas funções pra decidir
// usar/perguntar. §8: nunca escolhe sozinho o que é ambíguo (>1 conjunto → pergunta; 0 → pergunta).

import type { AdSetAd } from "@trafego/shared/ports";
import type { AdFormat, EntityStatus } from "@trafego/shared/types";

/** Conjunto candidato do alvo (id + rótulo + status neutro) — vem da árvore da campanha. */
export interface AdsetChoice {
  readonly adsetId: string;
  readonly name?: string;
  readonly status: EntityStatus;
}

export type AdsetDecision =
  | { readonly kind: "use"; readonly adsetId: string }
  | { readonly kind: "ask"; readonly options: readonly AdsetChoice[] }
  | { readonly kind: "ask_none" };

/**
 * Escolha do conjunto onde o anúncio novo entra (decisão do dono): 1 ATIVO → usa; >1 → PERGUNTA
 * (nunca chuta); 0 ativo → PERGUNTA (não cria conjunto sozinho — decisão do dono). Conjuntos
 * não-ativos não entram como opção automática (mas contam pro "0 ativo → pergunta").
 */
export function resolveAdsetChoice(adsets: readonly AdsetChoice[]): AdsetDecision {
  const active = adsets.filter((a) => a.status === "active");
  if (active.length === 1) return { kind: "use", adsetId: active[0]!.adsetId };
  if (active.length > 1) return { kind: "ask", options: active };
  return { kind: "ask_none" };
}

function isReusable(format: AdFormat): boolean {
  return format === "image" || format === "video";
}

export type TemplateDecision =
  | { readonly kind: "use"; readonly templateAdId: string; readonly restructured: boolean }
  | { readonly kind: "ask_destination" };

/**
 * Escolha do anúncio-MOLDE a clonar (decisão do dono "herdar de um anúncio do conjunto"): prefere um
 * anúncio REUSÁVEL (imagem/vídeo único) ATIVO do MESMO tipo de mídia do asset (troca limpa); senão
 * um reusável de outro tipo (marca `restructured` → o eco avisa que vai reestruturar imagem↔vídeo);
 * carrossel/catálogo NÃO é reusável (mesma convenção do `isReusableCreative`). Sem nenhum reusável
 * (0 anúncio OU só carrossel/catálogo) → pergunta o destino ao dono (fallback = fast-follow).
 * Ordena ATIVOS primeiro dentro de cada preferência.
 */
export function pickAttachTemplate(ads: readonly AdSetAd[], assetMedia: "image" | "video"): TemplateDecision {
  const reusable = ads.filter((a) => isReusable(a.format)).sort((x, y) => activeRank(x.status) - activeRank(y.status));
  const sameType = reusable.find((a) => a.format === assetMedia);
  if (sameType) return { kind: "use", templateAdId: sameType.adId, restructured: false };
  const other = reusable[0];
  if (other) return { kind: "use", templateAdId: other.adId, restructured: true };
  return { kind: "ask_destination" };
}

/** ATIVO ordena antes (menor rank). */
function activeRank(status: EntityStatus): number {
  return status === "active" ? 0 : 1;
}

import {
  CREATIVE_SOURCE_MODES,
  DEFAULT_CREATIVE_SOURCE_STRATEGY,
  SERVING_PICKS,
  type CreativeSourceMode,
  type CreativeSourceStrategy,
  type ServingPick,
} from "@trafego/shared";

/**
 * Resolve a estratégia de fonte do criativo (Slice 10) do `agents.model_config`, com fallback
 * ao default (= comportamento de hoje: reusa o melhor veiculando, determinístico). PURO. Robusto
 * a config malformado (valor legado/inválido → default). `servingPick` só faz sentido em `serving`.
 */
export function resolveCreativeSourceStrategy(
  modelConfig: Readonly<Record<string, unknown>> | null | undefined,
): CreativeSourceStrategy {
  const raw = (modelConfig ?? {})["creativeSource"] as { mode?: unknown; servingPick?: unknown } | undefined;
  const mode = raw?.mode;
  if (typeof mode !== "string" || !CREATIVE_SOURCE_MODES.includes(mode as CreativeSourceMode)) {
    return DEFAULT_CREATIVE_SOURCE_STRATEGY;
  }
  if (mode === "serving") {
    const pick = raw?.servingPick;
    const servingPick: ServingPick =
      typeof pick === "string" && SERVING_PICKS.includes(pick as ServingPick) ? (pick as ServingPick) : "best_performing";
    return { mode: "serving", servingPick };
  }
  return { mode: mode as CreativeSourceMode };
}

// Resolver PURO da habilitação de tools do agente (on/off por-ação). Fonte autoritativa =
// `agent_tool_bindings`; quando um binding não existe, cai no FALLBACK que preserva o
// comportamento atual (as 4 mutações herdam `allowedActions`; criação = default-on). Assim a
// virada dos gates (chat + apply) não muda nada até o dono editar. Gradua a lógica que vivia
// inline no `catalogWriteToolsShadow` do worker. Sem IO — testável direto.

import { GATEABLE_TOOL_KEYS, isCreationToolKey, type ToolBindingMode } from "@trafego/shared";

/** Resolve as tool-keys HABILITADAS (as 6) a partir dos bindings + fallback.
 *  - binding presente → habilitado sse `mode !== "disabled"` (`enabled`/`shadow` contam);
 *  - binding ausente → fallback: criação = habilitada (default-on); ação = está em `allowedActions`. */
export function resolveEnabledTools(
  bindings: ReadonlyMap<string, ToolBindingMode>,
  allowedActionsFallback: ReadonlySet<string>,
): Set<string> {
  const out = new Set<string>();
  for (const key of GATEABLE_TOOL_KEYS) {
    const mode = bindings.get(key);
    const enabled = mode === undefined ? (isCreationToolKey(key) ? true : allowedActionsFallback.has(key)) : mode !== "disabled";
    if (enabled) out.add(key);
  }
  return out;
}

// Nome de marca fixo do agente (identidade), não persona/tom — que seguem
// customizáveis por conta. Fonte única: agentes por conta E o concierge se
// chamam assim. O frontend tem a sua cópia em apps/web/src/app/core/brand.ts.
export const AGENT_NAME = "Roy";

// Tetos dos campos de texto livre da config do agente — fonte única (site + API +
// caminho de auto-config por chat). Guarda contra prompt inchado: entram em TODO
// prompt do LLM (system prompt da análise + camadas aditivas), então são generosos
// mas limitados (custo/latência/diluição de instrução/superfície de injeção).
/** contexto do negócio + orientações (camadas aditivas). ~1200 palavras cada. */
export const AGENT_TEXT_FIELD_MAX = 8000;
/** persona/tom — rótulos curtos de identidade. */
export const AGENT_IDENTITY_FIELD_MAX = 280;
/** override do system_prompt — é o prompt inteiro do analista. */
export const AGENT_PROMPT_FIELD_MAX = 8000;

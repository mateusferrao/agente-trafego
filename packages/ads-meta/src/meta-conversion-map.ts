import type { ConversionGoal, EntityObjective } from "@trafego/shared";

/**
 * Mapeamento **específico da Meta** → taxonomia genérica de conversão. TODO o
 * vocabulário Meta (action_type, custom_event_type, optimization_goal, objetivo de
 * campanha) vive AQUI, isolado no adapter — o core e o resto do sistema só falam
 * `ConversionGoal`. Adicionar Google/TikTok = outro mapa como este, sem tocar no core.
 *
 * ⚠️ As 3 grafias da Meta para o mesmo conceito NÃO são string-idênticas (pixel
 * `InitiateCheckout` ≠ enum `INITIATED_CHECKOUT` ≠ action `fb_pixel_initiate_checkout`),
 * por isso tabelas explícitas em vez de transformar string.
 */

const OFFSITE_PIXEL_PREFIX = "offsite_conversion.fb_pixel_";
const OFFSITE_CUSTOM_PREFIX = "offsite_conversion.custom.";
const ONSITE_PREFIX = "onsite_conversion.";

// action_type (sufixo do evento padrão de pixel) → goal genérico.
const PIXEL_EVENT_TO_GOAL: Readonly<Record<string, ConversionGoal>> = {
  purchase: "purchase",
  lead: "lead",
  complete_registration: "registration",
  initiate_checkout: "initiate_checkout",
  add_to_cart: "add_to_cart",
  view_content: "view_content",
  add_payment_info: "add_payment_info",
  search: "search",
  contact: "contact",
  subscribe: "subscribe",
  start_trial: "start_trial",
  submit_application: "submit_application",
};

// action_type on-Facebook → goal genérico.
const ONSITE_EVENT_TO_GOAL: Readonly<Record<string, ConversionGoal>> = {
  messaging_conversation_started_7d: "messaging_started",
  lead_grouped: "lead",
  purchase: "purchase",
};

// promoted_object.custom_event_type (enum) → goal genérico.
const CUSTOM_EVENT_TYPE_TO_GOAL: Readonly<Record<string, ConversionGoal>> = {
  PURCHASE: "purchase",
  LEAD: "lead",
  COMPLETE_REGISTRATION: "registration",
  INITIATED_CHECKOUT: "initiate_checkout",
  ADD_TO_CART: "add_to_cart",
  CONTENT_VIEW: "view_content",
  ADD_PAYMENT_INFO: "add_payment_info",
  SEARCH: "search",
  CONTACT: "contact",
  SUBSCRIBE: "subscribe",
  START_TRIAL: "start_trial",
  SUBMIT_APPLICATION: "submit_application",
  MESSAGING_CONVERSATION_STARTED_7D: "messaging_started",
};

// optimization_goal (adset) que define o objetivo direto, sem promoted_object.
const OPTIMIZATION_GOAL_DIRECT: Readonly<Record<string, ConversionGoal>> = {
  LEAD_GENERATION: "lead",
  QUALITY_LEAD: "lead",
  CONVERSATIONS: "messaging_started",
  APP_INSTALLS: "app_install",
};

// optimization_goal que usa o promoted_object p/ saber a conversão exata.
const OPTIMIZATION_GOAL_USES_PROMOTED = new Set(["OFFSITE_CONVERSIONS", "VALUE"]);

// objetivo de campanha (coarse) → goal, fallback p/ o nível campanha.
const CAMPAIGN_OBJECTIVE_TO_GOAL: Readonly<Record<string, ConversionGoal>> = {
  OUTCOME_SALES: "purchase",
  OUTCOME_LEADS: "lead",
  OUTCOME_APP_PROMOTION: "app_install",
};

/** O que uma linha de `actions` representa como conversão (ou null se não for conversão). */
export interface ActionConversion {
  readonly goal: ConversionGoal;
  readonly customConversionId?: string;
}

/**
 * Traduz um `action_type` cru → conversão genérica, ou `null` quando NÃO é uma
 * conversão contável. Regra (whitelist): entram no breakdown apenas
 *  - `offsite_conversion.custom.<id>` → conversão personalizada (casada por id);
 *  - eventos de pixel padrão / on-Facebook que o mapa reconhece.
 * Tudo o mais (engajamento como post_engagement/link_click/video_view; sub-métricas
 * de funil como onsite_conversion.post_net_like / messaging_user_depth_N /
 * messaging_first_reply; `fb_pixel_custom` genérico) → `null`: NÃO é conversão
 * tipada — fica só no `rawActions` (auditável / re-derivável). Não baldeamos
 * desconhecido em `custom` porque as famílias `onsite_/fb_pixel_` contêm muita
 * coisa que não é conversão, e isso poluiria o CPA/ROAS.
 */
export function parseActionType(actionType: string): ActionConversion | null {
  if (actionType.startsWith(OFFSITE_CUSTOM_PREFIX)) {
    return { goal: "custom", customConversionId: actionType.slice(OFFSITE_CUSTOM_PREFIX.length) };
  }
  if (actionType.startsWith(OFFSITE_PIXEL_PREFIX)) {
    const goal = PIXEL_EVENT_TO_GOAL[actionType.slice(OFFSITE_PIXEL_PREFIX.length)];
    return goal ? { goal } : null;
  }
  if (actionType.startsWith(ONSITE_PREFIX)) {
    const goal = ONSITE_EVENT_TO_GOAL[actionType.slice(ONSITE_PREFIX.length)];
    return goal ? { goal } : null;
  }
  return null;
}

/** Campos crus do promoted_object relevantes p/ derivar a conversão. */
export interface RawPromotedObject {
  readonly pixel_id?: string;
  readonly custom_event_type?: string;
  readonly custom_conversion_id?: string;
  readonly page_id?: string;
}

/**
 * Deriva o objetivo do adset (o que ele otimiza) combinando `optimization_goal` +
 * `promoted_object`. `custom_conversion_id` vence (resolve nome/goal depois); senão
 * o evento padrão; senão o goal direto do optimization_goal; senão indefinido
 * (ex: LINK_CLICKS → sem conversão, julga por CPC).
 */
export function objectiveFromAdSet(input: {
  readonly optimizationGoal?: string;
  readonly promotedObject?: RawPromotedObject;
}): EntityObjective | undefined {
  const { optimizationGoal, promotedObject } = input;

  if (promotedObject?.custom_conversion_id) {
    return { goal: "custom", customConversionId: promotedObject.custom_conversion_id };
  }
  if (!optimizationGoal) return undefined;

  if (OPTIMIZATION_GOAL_USES_PROMOTED.has(optimizationGoal)) {
    const eventType = promotedObject?.custom_event_type;
    const goal = eventType ? CUSTOM_EVENT_TYPE_TO_GOAL[eventType] : undefined;
    return goal ? { goal } : undefined;
  }
  const direct = OPTIMIZATION_GOAL_DIRECT[optimizationGoal];
  return direct ? { goal: direct } : undefined;
}

/** Objetivo coarse a partir do objetivo de campanha (fallback do nível campanha). */
export function objectiveFromCampaign(campaignObjective?: string): EntityObjective | undefined {
  if (!campaignObjective) return undefined;
  const goal = CAMPAIGN_OBJECTIVE_TO_GOAL[campaignObjective];
  return goal ? { goal } : undefined;
}

/** custom_event_type → goal (usado pelo resolver p/ classificar conversões personalizadas). */
export function goalFromCustomEventType(customEventType?: string): ConversionGoal {
  return (customEventType && CUSTOM_EVENT_TYPE_TO_GOAL[customEventType]) || "custom";
}

// ─── Mapa INVERSO (Fatia 7 — criação): goal genérico → vocabulário Meta ───
// Validar no Graph API Explorer v26: matriz objective↔optimization_goal↔billing_event
// e a combinação exata de custom_event_type (pendências registradas no plano).

const DEFAULT_OBJECTIVE = "OUTCOME_SALES";
const DEFAULT_BILLING_EVENT = "IMPRESSIONS";
const DEFAULT_CTA = "LEARN_MORE";

const GOAL_TO_CAMPAIGN_OBJECTIVE: Readonly<Record<ConversionGoal, string>> = {
  purchase: "OUTCOME_SALES",
  lead: "OUTCOME_LEADS",
  registration: "OUTCOME_LEADS",
  initiate_checkout: "OUTCOME_SALES",
  add_to_cart: "OUTCOME_SALES",
  view_content: "OUTCOME_SALES",
  add_payment_info: "OUTCOME_SALES",
  search: "OUTCOME_SALES",
  contact: "OUTCOME_LEADS",
  subscribe: "OUTCOME_SALES",
  start_trial: "OUTCOME_LEADS",
  submit_application: "OUTCOME_LEADS",
  messaging_started: "OUTCOME_ENGAGEMENT",
  app_install: "OUTCOME_APP_PROMOTION",
  custom: "OUTCOME_SALES",
};

// inverso do CUSTOM_EVENT_TYPE_TO_GOAL (goal → enum do promoted_object).
const GOAL_TO_CUSTOM_EVENT_TYPE: Readonly<Partial<Record<ConversionGoal, string>>> = {
  purchase: "PURCHASE",
  lead: "LEAD",
  registration: "COMPLETE_REGISTRATION",
  initiate_checkout: "INITIATED_CHECKOUT",
  add_to_cart: "ADD_TO_CART",
  view_content: "CONTENT_VIEW",
  add_payment_info: "ADD_PAYMENT_INFO",
  search: "SEARCH",
  contact: "CONTACT",
  subscribe: "SUBSCRIBE",
  start_trial: "START_TRIAL",
  submit_application: "SUBMIT_APPLICATION",
};

const CTA_TO_META: Readonly<Record<string, string>> = {
  shop_now: "SHOP_NOW",
  learn_more: "LEARN_MORE",
  sign_up: "SIGN_UP",
  subscribe: "SUBSCRIBE",
  contact_us: "CONTACT_US",
  book_now: "BOOK_TRAVEL",
  get_offer: "GET_OFFER",
  send_message: "MESSAGE_PAGE",
  download: "DOWNLOAD",
};

/** goal genérico → objetivo ODAX de campanha. */
export function resolveMetaObjective(goal: ConversionGoal): string {
  return GOAL_TO_CAMPAIGN_OBJECTIVE[goal] ?? DEFAULT_OBJECTIVE;
}

/** CTA neutro → call_to_action_type da Meta (fallback LEARN_MORE). */
export function resolveMetaCta(cta?: string): string {
  return (cta && CTA_TO_META[cta]) ?? DEFAULT_CTA;
}

/** optimization_goal + billing_event + promoted_object p/ um adset que otimiza `goal`. */
export interface MetaAdSetConversion {
  readonly optimizationGoal: string;
  readonly billingEvent: string;
  readonly promotedObject?: { readonly pixel_id: string; readonly custom_event_type: string };
}

/**
 * Resolve a config de conversão do adset. Com pixel + evento mapeável → OFFSITE_CONVERSIONS
 * + promoted_object. Sem pixel: lead → LEAD_GENERATION; messaging → CONVERSATIONS;
 * app → APP_INSTALLS; senão OFFSITE_CONVERSIONS (exige pixel — a casca valida antes).
 */
export function resolveAdSetConversion(goal: ConversionGoal, pixelId?: string): MetaAdSetConversion {
  const customEvent = GOAL_TO_CUSTOM_EVENT_TYPE[goal];
  if (pixelId && customEvent && goal !== "messaging_started") {
    return {
      optimizationGoal: "OFFSITE_CONVERSIONS",
      billingEvent: DEFAULT_BILLING_EVENT,
      promotedObject: { pixel_id: pixelId, custom_event_type: customEvent },
    };
  }
  if (goal === "messaging_started") return { optimizationGoal: "CONVERSATIONS", billingEvent: DEFAULT_BILLING_EVENT };
  if (goal === "app_install") return { optimizationGoal: "APP_INSTALLS", billingEvent: DEFAULT_BILLING_EVENT };
  if (goal === "lead") return { optimizationGoal: "LEAD_GENERATION", billingEvent: DEFAULT_BILLING_EVENT };
  return { optimizationGoal: "OFFSITE_CONVERSIONS", billingEvent: DEFAULT_BILLING_EVENT };
}

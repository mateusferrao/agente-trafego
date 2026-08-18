import { describe, expect, it } from "vitest";
import {
  objectiveFromAdSet,
  objectiveFromCampaign,
  parseActionType,
} from "./meta-conversion-map.js";

describe("parseActionType", () => {
  it("evento padrão de pixel → goal genérico", () => {
    expect(parseActionType("offsite_conversion.fb_pixel_purchase")).toEqual({ goal: "purchase" });
    expect(parseActionType("offsite_conversion.fb_pixel_complete_registration")).toEqual({
      goal: "registration",
    });
  });

  it("conversão personalizada → custom + id extraído", () => {
    expect(parseActionType("offsite_conversion.custom.170673")).toEqual({
      goal: "custom",
      customConversionId: "170673",
    });
  });

  it("on-Facebook messaging/lead → goal genérico", () => {
    expect(parseActionType("onsite_conversion.messaging_conversation_started_7d")).toEqual({
      goal: "messaging_started",
    });
    expect(parseActionType("onsite_conversion.lead_grouped")).toEqual({ goal: "lead" });
  });

  it("evento de pixel padrão desconhecido → null (não é conversão tipada; fica no rawActions)", () => {
    expect(parseActionType("offsite_conversion.fb_pixel_some_new_event")).toBeNull();
    expect(parseActionType("offsite_conversion.fb_pixel_custom")).toBeNull();
  });

  it("onsite que NÃO é conversão (engajamento/funil de messaging) → null", () => {
    expect(parseActionType("onsite_conversion.post_net_like")).toBeNull();
    expect(parseActionType("onsite_conversion.messaging_user_depth_2_message_send")).toBeNull();
    expect(parseActionType("onsite_conversion.total_messaging_connection")).toBeNull();
  });

  it("ação que não é conversão (link_click/engagement) → null", () => {
    expect(parseActionType("link_click")).toBeNull();
    expect(parseActionType("landing_page_view")).toBeNull();
    expect(parseActionType("post_engagement")).toBeNull();
  });
});

describe("objectiveFromAdSet", () => {
  it("custom_conversion_id vence → custom + id", () => {
    expect(
      objectiveFromAdSet({
        optimizationGoal: "OFFSITE_CONVERSIONS",
        promotedObject: { custom_conversion_id: "999", custom_event_type: "PURCHASE" },
      }),
    ).toEqual({ goal: "custom", customConversionId: "999" });
  });

  it("OFFSITE_CONVERSIONS + custom_event_type padrão → goal do evento", () => {
    expect(
      objectiveFromAdSet({
        optimizationGoal: "OFFSITE_CONVERSIONS",
        promotedObject: { pixel_id: "1", custom_event_type: "PURCHASE" },
      }),
    ).toEqual({ goal: "purchase" });
  });

  it("optimization_goal direto (CONVERSATIONS/LEAD_GENERATION)", () => {
    expect(objectiveFromAdSet({ optimizationGoal: "CONVERSATIONS" })).toEqual({
      goal: "messaging_started",
    });
    expect(objectiveFromAdSet({ optimizationGoal: "LEAD_GENERATION" })).toEqual({ goal: "lead" });
  });

  it("sem conversão (LINK_CLICKS) → undefined (julga por CPC)", () => {
    expect(objectiveFromAdSet({ optimizationGoal: "LINK_CLICKS" })).toBeUndefined();
  });
});

describe("objectiveFromCampaign", () => {
  it("objetivo coarse da campanha → goal", () => {
    expect(objectiveFromCampaign("OUTCOME_SALES")).toEqual({ goal: "purchase" });
    expect(objectiveFromCampaign("OUTCOME_LEADS")).toEqual({ goal: "lead" });
    expect(objectiveFromCampaign("OUTCOME_TRAFFIC")).toBeUndefined();
  });
});

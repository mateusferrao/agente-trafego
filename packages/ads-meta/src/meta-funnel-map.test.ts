import { describe, expect, it } from "vitest";
import { funnelFromRawActions, funnelStageFromActionType } from "./meta-funnel-map.js";

describe("funnelStageFromActionType", () => {
  it("mapeia o funil de messaging (com e sem prefixo onsite)", () => {
    expect(funnelStageFromActionType("onsite_conversion.messaging_conversation_started_7d")).toBe("conversation_started");
    expect(funnelStageFromActionType("messaging_first_reply")).toBe("first_reply");
    expect(funnelStageFromActionType("onsite_conversion.messaging_user_depth_3_message_send")).toBe("depth_3");
  });

  it("ignora action_types que não são funil (data-driven)", () => {
    expect(funnelStageFromActionType("link_click")).toBeNull();
    expect(funnelStageFromActionType("offsite_conversion.fb_pixel_purchase")).toBeNull();
    expect(funnelStageFromActionType("onsite_conversion.post_save")).toBeNull();
  });
});

describe("funnelFromRawActions", () => {
  it("deriva o funil do rawActions, ignorando o resto", () => {
    const raw = {
      "onsite_conversion.messaging_conversation_started_7d": 100,
      "onsite_conversion.messaging_first_reply": 40,
      "onsite_conversion.messaging_user_depth_3_message_send": 12,
      link_click: 500, // ignorado
      "offsite_conversion.fb_pixel_purchase": 3, // ignorado
    };
    const funnel = funnelFromRawActions(raw);
    const byStage = Object.fromEntries(funnel.map((f) => [f.stage, f.count]));
    expect(byStage).toEqual({ conversation_started: 100, first_reply: 40, depth_3: 12 });
  });

  it("rawActions ausente/vazio → funil vazio", () => {
    expect(funnelFromRawActions(undefined)).toEqual([]);
    expect(funnelFromRawActions({})).toEqual([]);
    expect(funnelFromRawActions({ link_click: 10 })).toEqual([]);
  });
});

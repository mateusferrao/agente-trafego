import { describe, expect, it } from "vitest";
import { actorLabel } from "./actor.js";

describe("actorLabel", () => {
  it("contato (DM) → contact:{id}", () => {
    expect(actorLabel({ kind: "contact", contactId: "ct-1" })).toBe("contact:ct-1");
  });

  it("grupo → group:{groupId}:{participantPhone}", () => {
    expect(actorLabel({ kind: "group", groupId: "grp-1", participantPhone: "+5511999999999" })).toBe(
      "group:grp-1:+5511999999999",
    );
  });
});

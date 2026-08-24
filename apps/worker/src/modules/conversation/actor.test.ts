import { describe, expect, it } from "vitest";
import { actorLabel } from "./actor.js";

describe("actorLabel", () => {
  it("contato (DM) → contact:{id}", () => {
    expect(actorLabel({ kind: "contact", contactId: "ct-1" })).toBe("contact:ct-1");
  });

  it("grupo (reativo, com participante) → group:{groupId}:{participantPhone}", () => {
    expect(actorLabel({ kind: "group", groupId: "grp-1", participantPhone: "+5511999999999" })).toBe(
      "group:grp-1:+5511999999999",
    );
  });

  it("grupo (proativo/broadcast, sem participante) → group:{groupId}", () => {
    expect(actorLabel({ kind: "group", groupId: "grp-1", participantPhone: null })).toBe("group:grp-1");
  });
});

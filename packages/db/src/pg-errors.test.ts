import { describe, expect, it } from "vitest";
import { isInvalidTextRepresentation, isUniqueViolation } from "./pg-errors.js";

describe("pg-errors", () => {
  it("isUniqueViolation reconhece 23505 e ignora o resto", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
    expect(isUniqueViolation({ code: "22P02" })).toBe(false);
    expect(isUniqueViolation(new Error("boom"))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });

  it("isInvalidTextRepresentation reconhece 22P02 (uuid malformado) e só ele", () => {
    // caso real: um :id de rota que não é uuid → o driver lança com code 22P02.
    expect(isInvalidTextRepresentation({ code: "22P02" })).toBe(true);
    expect(isInvalidTextRepresentation({ code: "23505" })).toBe(false);
    expect(isInvalidTextRepresentation(new Error("boom"))).toBe(false);
    expect(isInvalidTextRepresentation(undefined)).toBe(false);
  });
});

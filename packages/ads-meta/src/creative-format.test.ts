import { describe, expect, it } from "vitest";
import { classifyAdFormat } from "./creative-format.js";

const base = { hasImage: false, hasVideo: false, carouselItemCount: 0, isCatalog: false };

describe("classifyAdFormat", () => {
  it("imagem", () => {
    expect(classifyAdFormat({ ...base, hasImage: true })).toBe("image");
  });
  it("vídeo", () => {
    expect(classifyAdFormat({ ...base, hasVideo: true })).toBe("video");
  });
  it("carrossel", () => {
    expect(classifyAdFormat({ ...base, carouselItemCount: 2 })).toBe("carousel");
  });
  it("catálogo", () => {
    expect(classifyAdFormat({ ...base, isCatalog: true })).toBe("catalog");
  });
  it("outro (nenhum sinal)", () => {
    expect(classifyAdFormat(base)).toBe("other");
  });
  it("prioridade: imagem vence vídeo quando ambos presentes", () => {
    expect(classifyAdFormat({ ...base, hasImage: true, hasVideo: true })).toBe("image");
  });
  it("prioridade: vídeo vence carrossel", () => {
    expect(classifyAdFormat({ ...base, hasVideo: true, carouselItemCount: 3 })).toBe("video");
  });
  it("prioridade: carrossel vence catálogo", () => {
    expect(classifyAdFormat({ ...base, carouselItemCount: 1, isCatalog: true })).toBe("carousel");
  });
});

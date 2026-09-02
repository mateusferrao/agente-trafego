import type { AdFormat } from "@trafego/shared/types";

export interface AdFormatInput {
  readonly hasImage: boolean;
  readonly hasVideo: boolean;
  readonly carouselItemCount: number;
  readonly isCatalog: boolean;
}

/** Classifica o formato do anúncio pelos sinais já extraídos do object_story_spec (neutro). */
export function classifyAdFormat(input: AdFormatInput): AdFormat {
  if (input.hasImage) return "image";
  if (input.hasVideo) return "video";
  if (input.carouselItemCount > 0) return "carousel";
  if (input.isCatalog) return "catalog";
  return "other";
}

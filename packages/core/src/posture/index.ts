// Postura de comunicação do agente (Fatia postura) — PURO (dados/const + render).
// Fonte ÚNICA do significado dos 3 eixos de VOZ: alimenta o prompt (composePostureBlock),
// a UI + o describe_capabilities (postureCatalog/experienceCatalog) e o mapa de volume.
// Governa como o agente FALA (push/chat/pulso/narrativa) — NUNCA o output do analista.

import type {
  DidacticDepth,
  Directiveness,
  ExperienceLevel,
  Posture,
  Volume,
} from "@trafego/shared";
import {
  DIDACTIC_DEPTH_LEVELS,
  DIRECTIVENESS_LEVELS,
  EXPERIENCE_LEVELS,
  VOLUME_LEVELS,
} from "@trafego/shared";

/** Os 3 eixos de comunicação (sem o marcador de preset). */
export type PostureAxes = Pick<Posture, "directiveness" | "volume" | "didacticDepth">;

// ─── Volume → contagem determinística de recomendações lideradas ─────────────
const VOLUME_REC_COUNTS: Readonly<Record<Volume, number>> = {
  concise: 1,
  balanced: 3,
  comprehensive: 5,
};

/** Nº de recomendações que o agente LIDERA (o resto vira nudge "tem mais N"). PURO. */
export function volumeToRecCount(volume: Volume): number {
  return VOLUME_REC_COUNTS[volume];
}

// ─── Preset de experiência → semente dos 3 eixos ─────────────────────────────
const EXPERIENCE_PRESETS: Readonly<Record<ExperienceLevel, PostureAxes>> = {
  // não domina: diz o que fazer, mostra tudo, explica.
  beginner: { directiveness: "directive", volume: "comprehensive", didacticDepth: "explanatory" },
  // meio-termo.
  intermediate: { directiveness: "balanced", volume: "balanced", didacticDepth: "balanced" },
  // gestor sem tempo, orientado a resultado: curto, direto e com PLANO DE AÇÃO pronto
  // (diretivo) — não quer ponderar opções nem ler mensagem longa.
  advanced: { directiveness: "directive", volume: "concise", didacticDepth: "direct" },
};

/** Eixos semeados por um preset de experiência. PURO. */
export function experiencePresetDefaults(level: ExperienceLevel): PostureAxes {
  return EXPERIENCE_PRESETS[level];
}

/**
 * A postura diverge do preset marcado? (`experienceLevel` != null e algum eixo ≠ preset)
 * → UI/agente rotulam "personalizado". null (definido pelo arquétipo) nunca é custom. PURO.
 */
export function experienceLevelIsCustom(posture: Posture): boolean {
  if (posture.experienceLevel === null) return false;
  const preset = EXPERIENCE_PRESETS[posture.experienceLevel];
  return (
    posture.directiveness !== preset.directiveness ||
    posture.volume !== preset.volume ||
    posture.didacticDepth !== preset.didacticDepth
  );
}

// ─── Render do bloco de postura no prompt (voz) ──────────────────────────────
const DIRECTIVENESS_PROMPT: Readonly<Record<Directiveness, string>> = {
  consultative: "Apresente as opções e os trade-offs; devolva a decisão ao dono, sem dar a ordem.",
  balanced: "Recomende o melhor caminho, mas deixe as alternativas relevantes à mostra.",
  directive:
    "Entregue um PLANO DE AÇÃO: assuma UMA recomendação e lidere com ela ('faça X porque Y'), sem oferecer um leque de opções pra ponderar. A ação já está decidida na análise; comprometa-se.",
};
const VOLUME_PROMPT: Readonly<Record<Volume, string>> = {
  concise:
    "SÓ o movimento que mais importa agora, em pouquíssimas linhas. O dono não tem tempo de ler mensagem longa no WhatsApp — corte tudo que não for essencial e não empilhe sugestões.",
  balanced: "Os principais movimentos (uns poucos), sem virar uma lista longa.",
  comprehensive: "O panorama completo do que dá pra mexer — não deixe de fora o que é relevante, mesmo que fique mais longo.",
};
const DIDACTIC_PROMPT: Readonly<Record<DidacticDepth, string>> = {
  direct:
    "Fale de igual pra igual, como quem fala com um gestor experiente: use os termos (CPA, ROAS, adset) direto, sem explicar o básico nem encher de contexto.",
  balanced: "Explique um termo técnico só na primeira vez que usar.",
  explanatory:
    "O dono NÃO é técnico: explique cada termo (CPA, ROAS, adset) em linguagem simples e diga o porquê de cada ponto, como se ensinasse — nunca presuma que ele conhece o jargão.",
};

const POSTURE_BLOCK_HEADER = "Postura de comunicação com o dono (como FALAR; não muda a análise):";

/**
 * Bloco de postura injetado nas superfícies de FALA (push/chat/pulso). Fica FORA
 * do system_prompt sobrescrevível (sobrevive ao override). 1 linha por eixo. PURO.
 */
export function composePostureBlock(posture: Posture): string {
  return [
    POSTURE_BLOCK_HEADER,
    `- Diretividade: ${DIRECTIVENESS_PROMPT[posture.directiveness]}`,
    `- Volume: ${VOLUME_PROMPT[posture.volume]}`,
    `- Profundidade: ${DIDACTIC_PROMPT[posture.didacticDepth]}`,
  ].join("\n");
}

// ─── Catálogo amigável (UI + describe_capabilities + eco) — fonte única PT ────
export interface PostureLevelOption {
  readonly level: string;
  readonly label: string;
  readonly description: string;
}
export interface PostureAxisCatalog {
  readonly key: "directiveness" | "volume" | "didacticDepth";
  readonly label: string;
  readonly help: string;
  readonly levels: readonly PostureLevelOption[];
}

const DIRECTIVENESS_LABELS: Readonly<Record<Directiveness, PostureLevelOption>> = {
  consultative: { level: "consultative", label: "Consultivo", description: "Mostra as opções e os prós e contras; a decisão fica com você." },
  balanced: { level: "balanced", label: "Equilibrado", description: "Recomenda o melhor caminho, mas deixa as alternativas à mostra." },
  directive: { level: "directive", label: "Diretivo", description: "Assume uma recomendação e lidera com ela: 'faça X porque Y'." },
};
const VOLUME_LABELS: Readonly<Record<Volume, PostureLevelOption>> = {
  concise: { level: "concise", label: "Enxuto", description: "Só o movimento que mais importa agora." },
  balanced: { level: "balanced", label: "Equilibrado", description: "Os principais movimentos." },
  comprehensive: { level: "comprehensive", label: "Abrangente", description: "O panorama do que dá pra mexer." },
};
const DIDACTIC_LABELS: Readonly<Record<DidacticDepth, PostureLevelOption>> = {
  direct: { level: "direct", label: "Direto", description: "Vai direto; assume que você conhece os termos (CPA, ROAS)." },
  balanced: { level: "balanced", label: "Equilibrado", description: "Explica um termo técnico só na primeira vez." },
  explanatory: { level: "explanatory", label: "Didático", description: "Explica tudo em linguagem de dono, como se ensinasse." },
};

/** Catálogo dos 3 eixos com textos amigáveis (PT) — servido à UI + lido pelo agente. PURO. */
export function postureCatalog(): PostureAxisCatalog[] {
  return [
    { key: "directiveness", label: "Diretividade", help: "Como o agente entrega o conselho.", levels: DIRECTIVENESS_LEVELS.map((l) => DIRECTIVENESS_LABELS[l]) },
    { key: "volume", label: "Volume", help: "Quantas recomendações ele traz de uma vez.", levels: VOLUME_LEVELS.map((l) => VOLUME_LABELS[l]) },
    { key: "didacticDepth", label: "Profundidade", help: "Quanto ele explica os termos técnicos.", levels: DIDACTIC_DEPTH_LEVELS.map((l) => DIDACTIC_LABELS[l]) },
  ];
}

export interface ExperienceOption {
  readonly level: ExperienceLevel;
  readonly label: string;
  readonly description: string;
  readonly whenToUse: string;
  /** eixos que este preset semeia (UI mostra o preview do que vai mudar). */
  readonly axes: PostureAxes;
}

const EXPERIENCE_LABELS: Readonly<Record<ExperienceLevel, Omit<ExperienceOption, "level" | "axes">>> = {
  beginner: {
    label: "Iniciante",
    description: "Ainda aprendendo tráfego; quer que o agente diga o que fazer e explique.",
    whenToUse: "Pra quem não domina tráfego e quer mão na roda.",
  },
  intermediate: {
    label: "Intermediário",
    description: "Entende o básico; quer recomendação com as alternativas à mostra.",
    whenToUse: "Meio-termo equilibrado, sem exagero de sugestão.",
  },
  advanced: {
    label: "Avançado",
    description: "Domina tráfego; quer pouco e direto, só o que possa estar passando batido.",
    whenToUse: "Pra quem manja e se incomoda com sugestão demais.",
  },
};

/** Catálogo dos presets de experiência (padrão archetypeCatalog). PURO. */
export function experienceCatalog(): ExperienceOption[] {
  return EXPERIENCE_LEVELS.map((level) => ({ level, ...EXPERIENCE_LABELS[level], axes: EXPERIENCE_PRESETS[level] }));
}

// ─── Lookups PT (fonte única do eco de mudança + describe_capabilities) ───────
/** Rótulo PT de cada eixo (Diretividade/Volume/Profundidade). */
export const POSTURE_AXIS_PT = {
  directiveness: "diretividade",
  volume: "volume",
  didacticDepth: "profundidade",
} as const;

/** Rótulo PT amigável de um nível de um eixo. PURO. */
export function postureLevelLabel(axis: keyof typeof POSTURE_AXIS_PT, level: string): string {
  const maps = { directiveness: DIRECTIVENESS_LABELS, volume: VOLUME_LABELS, didacticDepth: DIDACTIC_LABELS };
  return (maps[axis] as Record<string, PostureLevelOption>)[level]?.label ?? level;
}

/** Rótulo PT de um preset de experiência (null = definido pelo arquétipo). PURO. */
export function experienceLabel(level: ExperienceLevel | null): string {
  return level === null ? "definido pelo arquétipo" : EXPERIENCE_LABELS[level].label;
}

---
name: AutoTraffic
description: Bold operational desk — a neobrutalist brand skin over a calm operational workspace, with Roi the agent as its face
colors:
  canvas: "#fbf9f4"
  surface: "#ffffff"
  surface-muted: "#f4f2ec"
  line: "#e6e2d8"
  ink: "#070a27"
  muted: "#4a5070"
  primary: "#0c1134"
  primary-strong: "#070a27"
  primary-ink: "#fbf9f4"
  accent: "#e00202"
  accent-strong: "#b00202"
  accent-soft: "#ffe3dc"
  success: "#047a4d"
  success-soft: "#c9f3e1"
  danger: "#b3241c"
  danger-soft: "#f7dcd7"
  tomato: "#e00202"
  tomato-soft: "#ffe3dc"
  navy-900: "#070a27"
  navy-500: "#2c3572"
  dark-canvas: "#070a27"
  dark-surface: "#0c1134"
  dark-line: "#2c3572"
  dark-ink: "#fbf9f4"
typography:
  display:
    fontFamily: "Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "2rem"
    fontWeight: 800
    lineHeight: 1.1
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  title:
    fontFamily: "Instrument Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: "0"
  body:
    fontFamily: "Instrument Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "0"
  label:
    fontFamily: "Instrument Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "0.025em"
  numeric:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontWeight: 500
rounded:
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
  xxl: "48px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-ink}"
    boxShadow: "3px 3px 0 {colors.accent}"
    rounded: "{rounded.md}"
    padding: "10px 16px"
  panel-brand:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    border: "2px solid {colors.ink}"
    boxShadow: "3px 3px 0 {colors.navy-900}"
    rounded: "{rounded.xl}"
    padding: "16px"
  panel-workspace:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    border: "1px solid {colors.line}"
    rounded: "{rounded.lg}"
    padding: "16px"
---

# Design System: AutoTraffic

## 1. Overview

**Creative North Star: "The Bold Operational Desk"**

AutoTraffic is a WhatsApp-native, semi-autonomous traffic agent. The product's face is **Roi**, the agent. The interface should feel like a confident, branded workspace: a **refined neobrutalist** brand skin (solid 2px borders, solid offset shadows, warm paper canvas, tomato and mint) over a **calm operational core** for the dense, money-critical work.

Manychat in spirit (approachable, warm, jargon-free, chat-native), operational in substance (clear, dense, honest where money is at stake). We inherit the brand language of the marketing site (`autotraffic`), not Manychat's app or its blue.

This is the intended direction for all product surfaces. AI is embedded operational infrastructure represented by Roi — never a generic sparkle or a separate chatbot destination.

**Key Characteristics:**

- Warm paper canvas, navy structure, tomato brand accent, mint for success/agent. Light-first with dark as a first-class alternate (neobrutalist dark: solid offset shadows turn mint).
- **Two tiers of surface.** "Brand" surfaces (decision, onboarding, conversation) carry the bold signature; "Workspace" surfaces (tables, config, shell) stay calm and flat for legibility.
- Refined neobrutalism: 2px borders and ~3px solid offset shadows only where they earn identity; data-dense cards use a thin border and no offset.
- Personality lives in motion and moments (loading, empty states, Roi's identity), not in extra chrome or shouty copy.

## 2. Colors

Warm, high-contrast, brand-owned. Designed to avoid generic AI blues and purple gradients.

### Primary (action)

- **Navy** (`#0c1134`): primary actions (solid navy button with a tomato offset shadow), primary emphasis. Hover uses **Deep Navy** (`#070a27`). Text on navy is **Paper** (`#fbf9f4`).

### Accent (rare brand)

- **Tomato** (`#e00202`): the rare brand accent — selection, active state, brand moments, and the Roi mark. **Tomato Wash** (`#ffe3dc`, peach) for low-emphasis selection backgrounds.

### Semantic

- **Mint** (`#047a4d`, wash `#c9f3e1`): success and agent (Roi) states.
- **Deep Red** (`#b3241c`, wash `#f7dcd7`): danger and destructive actions. Distinct from the tomato brand accent, and **always paired with icon + text** (never color alone).

### Neutral

- **Paper Canvas** (`#fbf9f4`): default app background. **Surface** (`#ffffff`) for panels. **Muted Surface** (`#f4f2ec`) for low-emphasis fills. **Line** (`#e6e2d8`) for calm dividers/borders. **Ink/Navy** (`#070a27`) for text and bold borders. **Muted** (`#4a5070`) for secondary text.

### Dark Mode (neobrutalist)

- Canvas `#070a27`, Surface `#0c1134`, Line `#2c3572`, Ink `#fbf9f4`. Solid offset shadows turn **mint** (`#00cc82`) in dark, mirroring the marketing site's on-navy behavior. Primary in dark uses a lighter navy (`#2c3572`).

### Named Rules

**The Brand Accent Rule.** Tomato is for selection, active state and brand moments only. If a screen has more than ~10% saturated tomato, the accent has stopped working.

**The Two Reds Rule.** Tomato (brand) and deep red (danger) coexist; keep danger darker/less orange, use peach wash for selection, and **always** pair danger with an icon and text.

**The No Generic AI Rule.** No purple-blue gradients, neon glows, abstract AI blobs, or ✨ sparkles as the AI identity. The agent's identity is Roi plus the tomato mark.

## 3. Typography

**Display / Headings:** Archivo (weights 700–800, tight tracking).
**Body / UI:** Instrument Sans.
**Numeric / Metrics:** JetBrains Mono (tabular numbers for KPIs, currency, IDs).
**Editorial (rare):** Noto Serif.

### Hierarchy

- **Display** (Archivo 800, 32px, 1.1, -0.02em): focused page titles and brand moments. Product scale, not landing scale.
- **Headline** (Archivo 700, 24px): top-level screen headings.
- **Title** (Instrument 600, 16px): panel titles and card labels.
- **Body** (Instrument 400, 14px, 1.55): operational prose. Cap explanatory copy at 65–75 characters.
- **Label** (Instrument 600, 12px, 0.025em): metadata and status labels.
- **Numeric** (JetBrains Mono 500): all displayed metrics and currency.

### Named Rules

**The Product Scale Rule.** Tight product typography. No giant landing-page type inside operational screens (onboarding/marketing surfaces excepted).

## 4. Elevation & Material

The material language is **solid**, not glass. Elevation is a solid offset shadow (the neobrutalist signature), used with restraint. Blur is reserved for genuine floating overlays (dialogs, menus, command surface) as subtle micro-elevation only.

### Shadow Vocabulary

- **Offset** (`3px 3px 0` navy / mint in dark): the brand-surface signature (brand cards, active brand chrome). Press state collapses to `1px 1px 0`.
- **Offset Accent** (`3px 3px 0` tomato / mint in dark): the primary button's brand pop.
- **Card Rest / Panel Float**: subtle soft shadows for calm separation and for overlay elevation only.

Fine-grained noise texture stays on large quiet surfaces (shell, command, empty states, dark) and must never reduce text contrast.

### Named Rules

**The Solid Layer Rule.** The offset shadow is the layer. Blur/glass appears only when a surface genuinely floats above the work plane; if it does not clarify focus, state or stacking, remove it. Glass-as-default is retired.

**The Two-Tier Surface Rule.** Bold (2px border + offset) belongs to Brand surfaces (decision, onboarding, conversation, approvals, timeline). Workspace surfaces (tables, agent config, shell, costs, settings) stay calm: thin border, no offset. Never put offset shadows on dense grids.

## 5. Personality & Voice

**The Personality Budget Rule.** Micro-delight lives in loading (Roi's mark pulsing + an honest progress narrative), empty states (a lively brand illustration), success, and Roi's identity. It is **forbidden** in errors, money/budget actions, guardrails and dense data.

**The Own Voice Rule (copy).** Write in AutoTraffic's own voice, never a generic-AI voice. Forbidden: em dashes as dramatic connectors, "não é só X, é Y" constructions, rhetorical triads, empty hype ("revolucione", "potencialize", "desbloqueie"), exclamation confetti, emoji as personality in the UI, assistant openers ("Claro!", "Aqui está"), AI jargon ("insights poderosos", "mágica"). Prefer short sentences, concrete verbs, a clear benefit, simple punctuation. A light, own metaphor is welcome on Brand surfaces.

**Tone by zone.** Brand surfaces (onboarding, empty, success, "Roi working") = warm and playful. Operational surfaces (data, config, costs) = neutral and precise. Critical surfaces (errors, money, guardrails) = strictly precise.

**The B2B Guardrail.** Playful tone never touches anything a manager would forward to their own client (numbers, results, spend recommendations) — that content stays sober.

**Roi identity.** Roi is the fixed brand name of the agent everywhere (per-account agents and the org concierge); persona/tone stay configurable per account, but the name is fixed. First mention on a surface qualifies it ("o Roi, seu agente de tráfego"); later mentions use "Roi". A persistent identity block (tomato mark + "Roi") anchors the agent surface.

**The status = tone + text rule.** Status is always tone plus text, never color alone.

## 6. Components

Components are directives that read design tokens; changing token values propagates the brand. Reuse `shared/ui` before building new.

### Buttons

- **Primary:** navy background, paper text, **tomato offset shadow (`3px 3px 0`)**, ~14px radius. Hover "sinks" (translate + shadow collapses to `1px 1px 0`); respects `prefers-reduced-motion`.
- **Danger:** deep red background, paper text (destructive, always with an icon).
- **Secondary / Ghost:** paper/transparent, ink text, navy 2px border on secondary when containment is needed.

### Cards / Containers

- **Brand tier:** 2px ink border + `3px 3px 0` navy offset shadow, 20px radius. For approvals, onboarding, empty states, brand moments.
- **Workspace tier:** 1px line border, no offset, 16px radius. For tables, KPIs, config.

### Chips / Badges

- Muted surface or wash background; status chips carry tone + text. Selection uses peach wash + tomato.

### Inputs / Fields

- Calm workspace treatment: surface background, line border, accent focus (border/ring, never only shadow). Errors use deep red + icon/text.

### Navigation / Shell

- Persistent app shell, calm workspace tier. Active state uses tomato sparingly. 14px medium labels; lucide icons (2px stroke).

### Loading & AI

- Roi's mark pulses (never spins). The analysis loader shows an honest progress narrative. A WhatsApp-style typing indicator appears only in real conversation contexts. Skeletons for content loading.

## 7. Do's and Don'ts

### Do:

- **Do** keep the two-tier discipline: bold for brand, calm for workspace.
- **Do** make AI explainable and grounded, embodied by Roi in the current context.
- **Do** support WCAG AA, keyboard nav, visible focus, color-blind-safe status (tone + text), and light + dark from the start.
- **Do** use JetBrains Mono for all metrics and currency.
- **Do** keep copy in AutoTraffic's own voice, tone-by-zone.

### Don't:

- **Don't** put offset shadows or 2px borders on dense tables/config.
- **Don't** use glass as default page structure (retired).
- **Don't** use ✨ sparkles, purple-blue gradients, neon or abstract AI blobs.
- **Don't** rely on color alone for status, risk or the two reds.
- **Don't** write in a generic-AI voice (see The Own Voice Rule).
- **Don't** let playful tone touch client-forwardable content.

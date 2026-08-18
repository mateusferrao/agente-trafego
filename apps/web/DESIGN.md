---
name: Automato
description: AI-first enterprise operating system with premium operational clarity
colors:
  canvas: "#f7f7f4"
  surface: "#fffefa"
  surface-muted: "#eef1ea"
  line: "#d9ded5"
  ink: "#17231e"
  muted: "#64726a"
  primary: "#047857"
  primary-strong: "#065f46"
  primary-soft: "#d9f5e6"
  tomato: "#e04b35"
  tomato-soft: "#ffe2dc"
  dark-canvas: "#0b1110"
  dark-surface: "#111a17"
  dark-line: "#25342f"
  dark-ink: "#edf7f1"
typography:
  display:
    fontFamily: "Figtree, Plus Jakarta Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "2rem"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "0"
  headline:
    fontFamily: "Plus Jakarta Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: "0"
  title:
    fontFamily: "Plus Jakarta Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 650
    lineHeight: 1.35
    letterSpacing: "0"
  body:
    fontFamily: "Plus Jakarta Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "0"
  label:
    fontFamily: "Plus Jakarta Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 650
    lineHeight: 1.3
    letterSpacing: "0.025em"
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
    textColor: "#ffffff"
    rounded: "{rounded.md}"
    padding: "10px 16px"
  button-primary-hover:
    backgroundColor: "{colors.primary-strong}"
    textColor: "#ffffff"
    rounded: "{rounded.md}"
    padding: "10px 16px"
  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "20px"
  chip:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.primary}"
    rounded: "{rounded.sm}"
    padding: "4px 8px"
---

# Design System: Automato

<!-- SEED -->

## 1. Overview

**Creative North Star: "The Operational Glass Desk"**

Automato should feel like a precise enterprise workspace: light-first, premium, context-rich and calm enough for daily operations. The reference lane is Stripe for clarity and explainability, Attio for workflow composition and relationship surfaces, with selective Raycast-like glass, noise texture and depth when the interface needs focus, layering or command presence.

This is a greenfield design system seed. The current UI is not the finished source of truth; these rules define the intended direction for future product surfaces. Automato should feel tailored and partner-like, with AI embedded into operational context rather than presented as a separate chatbot destination.

**Key Characteristics:**

- Light-first neutral premium base, with dark mode planned as a first-class alternate theme.
- Medium density: operational and fast, but explanatory enough for cross-functional enterprise teams.
- Restrained emerald primary, tomato used sparingly as a brand note or critical emphasis.
- Glass, grain and noise texture are allowed only for meaningful layering, command surfaces, workflow focus and contextual AI assist.
- Stripe-grade clarity, Attio-grade workflow ergonomics, Raycast-grade polish, Automato-specific operational depth.

## 2. Colors

The palette is a neutral premium system with a quiet green cast, designed to avoid generic AI blues and purple gradients.

### Primary

- **Operational Emerald** (`#047857`): primary actions, selected navigation, active states and trusted AI completion states.
- **Deep Emerald** (`#065f46`): hover, active and high-emphasis primary action states.
- **Emerald Wash** (`#d9f5e6`): low-emphasis selected states, subtle chips and contextual AI assist backgrounds.

### Secondary

- **Tomato Signal** (`#e04b35`): brand mark, rare warning emphasis and important exceptions. It should not compete with primary actions.
- **Tomato Wash** (`#ffe2dc`): low-emphasis warning or brand tint, used sparingly.

### Neutral

- **Premium Canvas** (`#f7f7f4`): default app background. Slightly warmer and more neutral than the current green-tinted canvas.
- **Warm Surface** (`#fffefa`): panels, menus and controlled working surfaces.
- **Muted Surface** (`#eef1ea`): hover states, chips and low-emphasis fills.
- **Quiet Line** (`#d9ded5`): dividers, borders and structure.
- **Deep Ink** (`#17231e`): primary text and high-emphasis icons.
- **Operational Muted** (`#64726a`): secondary text, metadata and helper labels.

### Dark Mode

- **Dark Canvas** (`#0b1110`): default dark background.
- **Dark Surface** (`#111a17`): panels and elevated surfaces.
- **Dark Line** (`#25342f`): dividers and structural borders.
- **Dark Ink** (`#edf7f1`): primary text in dark mode.

### Named Rules

**The Rare Accent Rule.** Emerald is for decisions, selection and completion. If a screen has more than 10% saturated emerald, the accent has stopped working.

**The No Generic AI Rule.** Do not use purple-blue gradients, neon glows or abstract AI blobs as the product identity.

## 3. Typography

**Display Font:** Figtree with Plus Jakarta Sans fallback.
**Body Font:** Plus Jakarta Sans with system sans fallback.
**Label/Mono Font:** Use Plus Jakarta Sans for labels; add a mono font only when technical IDs, logs or traces become product surfaces.

**Character:** The pairing should feel precise, contemporary and premium without becoming editorial. Plus Jakarta Sans carries the operational product; Figtree gives the brand lockup a slightly warmer, more distinctive shape.

### Hierarchy

- **Display** (700, 32px, 1.1): product identity, focused page titles and rare major announcements. Avoid oversized marketing hero scale inside authenticated product UI.
- **Headline** (650, 24px, 1.2): top-level screen headings and workflow summaries.
- **Title** (650, 16px, 1.35): panel titles, table group headings and card-level labels.
- **Body** (400, 14px, 1.55): operational prose, descriptions and table-adjacent text. Cap long explanatory body copy at 65 to 75 characters.
- **Label** (650, 12px, 1.3, 0.025em): metadata, section labels, compact navigation and status labels. Uppercase only when it improves scanning.

### Named Rules

**The Product Scale Rule.** Use tight product typography. Do not introduce giant landing-page type into operational screens unless the surface is explicitly onboarding or marketing.

## 4. Elevation

Automato uses tonal layering first and shadow second. Most screens should feel flat, precise and scannable. Elevation appears when a surface floats above the work plane: command menus, account menus, dialogs, focused AI assist and contextual overlays.

Glass effects are allowed only for transient or layered surfaces. Use them with restraint: subtle border, translucent surface, backdrop blur and deliberate noise texture. Do not turn ordinary cards into glass.

Noise texture is part of the material language. It should be fine-grained, low-contrast and more visible in large surfaces, command layers, empty states and dark mode. It should never reduce text contrast, make tables harder to scan or become a decorative pattern competing with content.

### Shadow Vocabulary

- **Card Rest** (`0 1px 2px rgb(23 48 39 / 0.07)`): compact repeated items when separation is needed.
- **Panel Float** (`0 18px 44px rgb(23 48 39 / 0.16)`): menus, overlays, command surfaces and focused assist layers.
- **Glass Command**: translucent surface, 1px quiet border, 16px to 24px blur and visible fine grain. Use only above content, never as default page structure.
- **Noise Plane**: low-opacity noise texture over Premium Canvas or Dark Canvas. Use to give large quiet areas material presence without adding gradients or decorative shapes.

### Named Rules

**The Layer Has A Job Rule.** If a shadow, blur or glass effect does not clarify focus, state or stacking, remove it.

## 5. Components

Components should feel precise and work-focused, with enough polish to communicate premium enterprise quality.

Workflow surfaces should take inspiration from Attio: clear object context, relationship-first layout, compact timelines, side-by-side detail and activity, editable structured fields and calm state transitions. The goal is to make CRM, conversations, agent runs and operational processes feel like one coherent working graph, not isolated dashboard pages.

### Buttons

- **Shape:** rounded but controlled, default 12px radius.
- **Primary:** Operational Emerald background, white text, 10px by 16px padding, medium weight.
- **Hover / Focus:** Deep Emerald hover. Focus uses a visible emerald ring with sufficient contrast and no layout shift.
- **Secondary / Ghost:** neutral surface or transparent background, Deep Ink text, Quiet Line border when containment is needed.

### Chips

- **Style:** Muted Surface background, Deep Ink or Operational Emerald text, 8px radius.
- **State:** selected chips may use Emerald Wash. Status chips must not rely on color alone.

### Cards / Containers

- **Corner Style:** 16px for panels, 12px for compact repeated items.
- **Background:** Warm Surface on Premium Canvas, with Quiet Line borders for structure.
- **Shadow Strategy:** flat by default. Use Card Rest only when repeated items need separation.
- **Border:** 1px Quiet Line. Avoid colored side borders.
- **Internal Padding:** 16px for compact panels, 20px to 24px for explanatory surfaces.

### Inputs / Fields

- **Style:** Warm Surface background, Quiet Line border, 12px radius, clear label and helper/error text areas.
- **Focus:** Emerald ring or border shift, never only shadow.
- **Error / Disabled:** error states use tomato plus icon/text; disabled states reduce contrast while preserving readability.

### Navigation

- **Style:** persistent app shell with compact labels and clear active state. Active navigation uses Operational Emerald or Emerald Wash depending on hierarchy.
- **Typography:** 14px medium labels, predictable spacing, no decorative icons unless they improve scanning.
- **Mobile Treatment:** collapse structure without hiding primary context. Prioritize current business, current module and active object.

### AI Assist Surfaces

AI assist should appear as contextual product infrastructure: suggestions, analysis, actions, explanations and agent activity tied to the current business object. Prefer inline panels, side inspectors and command surfaces over generic chat windows.

### Workflow Surfaces

- **Structure:** object header, primary work area, relationship/context rail and activity or agent trace when relevant.
- **Attio Reference:** use Attio's clarity around records, lists, relationships and workflow states as a specific reference for CRM-like and operational workflow screens.
- **State:** workflows need explicit ownership, lifecycle state, next action, automation status and audit trail.
- **Density:** medium density with enough explanation for cross-functional users. Avoid pure spreadsheet density unless the task is explicitly bulk operations.

## 6. Do's and Don'ts

### Do:

- **Do** design for operational teams who switch between CRM, marketing, conversations, products, integrations, agents and analytics.
- **Do** make AI explainable, grounded and recoverable in the current business context.
- **Do** keep surfaces dense but calm, with medium spacing and strong scanning hierarchy.
- **Do** use Stripe-like clarity for forms, tables, workflows and explanatory moments.
- **Do** use Attio-like ergonomics for workflow, CRM and relationship-heavy surfaces.
- **Do** reserve Raycast-like glass and noise texture for focused command, workflow and assist layers.
- **Do** use fine-grained noise texture to give large quiet surfaces premium material presence without harming readability.
- **Do** support WCAG AA, keyboard navigation, visible focus states, color-blind-safe status communication and i18n from the start.
- **Do** plan every component for light and dark mode, even if light mode ships first.

### Don't:

- **Don't** make Automato look like a generic AI platform, chatbot wrapper, dashboard template or overdecorated SaaS product.
- **Don't** use vague AI futurism, purple-blue gradients, neon accents, abstract AI blobs or dark cockpit aesthetics.
- **Don't** create generic card mosaics as the default dashboard answer.
- **Don't** make AI a separate destination when it should be embedded into operational work.
- **Don't** use glassmorphism as default page structure.
- **Don't** use noise texture at an opacity that reduces text contrast, table scanning or WCAG compliance.
- **Don't** rely on color alone for status, risk, permissions or agent state.
- **Don't** use side-stripe borders, gradient text or decorative effects that do not clarify hierarchy or action.

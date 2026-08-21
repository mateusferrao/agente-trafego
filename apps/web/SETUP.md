# `apps/web` — setup

App **web** do AutoTraffic: Angular 21 (standalone + signals, zoneless),
Tailwind 4 (CSS-config, sem `tailwind.config.js` — tokens em `src/styles.css`),
dentro do pnpm workspace (`pnpm-workspace.yaml` → `apps/*`).

Este diretório é um **esqueleto**: estrutura de pastas + arquivos-chave (placeholders).
Nada foi instalado nem gerado. Não rode `ng new` por cima — use esta estrutura, ou
regenere e traga estes arquivos por cima (ver abaixo).

## O que já está aqui

```
apps/web/
├─ package.json              # name "web"; scripts dev/build/api:generate/tokens:check/typecheck/test
├─ tsconfig.json             # strict + strictTemplates; aliases @app/@core/@ui
├─ angular.json              # @angular/build; registra src/styles.css; assets em public/
├─ DESIGN.md                 # regras do design system (COPIADO da referência)
├─ SETUP.md                  # este arquivo
├─ .gitignore
├─ scripts/
│  └─ validate-design-tokens.mjs   # gate de tokens (COPIADO da referência)
├─ public/                   # assets estáticos (coloque favicon.ico aqui)
└─ src/
   ├─ index.html             # lang pt-BR; Google Fonts Figtree/Plus Jakarta Sans/Noto Serif
   ├─ main.ts                # bootstrapApplication(App, appConfig)
   ├─ styles.css             # tokens + @theme Tailwind 4 (COPIADO da referência)
   └─ app/
      ├─ app.ts              # componente raiz (router-outlet)
      ├─ app.config.ts       # providers: router, HttpClient, zoneless
      ├─ app.routes.ts       # rotas lazy (onboarding fora do shell)
      ├─ layouts/app-shell/  # shell autenticado (sidebar + outlet)
      ├─ features/           # onboarding, accounts, agents, timeline, settings (stubs)
      ├─ core/
      │  ├─ api/             # cliente kubb (README + barrel placeholder)
      │  ├─ auth/            # sessão client-side (placeholder)
      │  └─ navigation/      # app-modules.ts (árvore de nav tipada)
      └─ shared/ui/          # design system vendorizado (index.ts placeholder + VENDORING.md)
```

## Como finalizar

### Opção A — usar esta estrutura (recomendado)

1. Instale as deps do workspace a partir da raiz do monorepo:
   ```bash
   pnpm install
   ```
   Confira as versões exatas de `@angular/*`, `tailwindcss`, `@tailwindcss/postcss`,
   `ng-primitives` e `@kubb/*` em `package.json` contra o projeto de referência
   (`Plataforma AI Driven/automato-web`) e alinhe se necessário.
2. Adicione um `favicon.ico` em `public/`.
3. Suba o dev server:
   ```bash
   pnpm --filter web dev        # ou, da pasta: ng serve
   ```

### Opção B — regenerar com `ng new` e trazer por cima

Se preferir o scaffolding oficial: gere em um diretório temporário
(`ng new web --standalone --style=css --routing`), depois **traga de volta** deste
esqueleto: `src/styles.css`, `DESIGN.md`, `scripts/validate-design-tokens.mjs`,
`src/index.html` (fontes + lang pt-BR), a árvore `src/app/**` e os scripts do
`package.json` (`api:generate`, `tokens:check`). Angular 21 já usa `@angular/build`
e standalone por padrão.

## Vendorização do `shared/ui`

Os componentes do design system **não** foram copiados (só o barrel placeholder).
Siga `src/app/shared/ui/VENDORING.md` — ele lista arquivo por arquivo o que copiar
de:
```
C:\Users\mateu\OneDrive\Área de Trabalho\Automato\Plataforma AI Driven\automato-web\src\app\shared\ui\
```
(read-only — **não modifique** a origem), em qual ordem, e o que cada arquivo exporta.
Depois de copiar, substitua `shared/ui/index.ts` pelo barrel real e rode `tokens:check`
+ `typecheck`. Muitos componentes dependem de `ng-primitives` (já em `package.json`).

Enquanto isso, o `app-shell` usa markup Tailwind cru (com `TODO(vendoring)`); troque
por `<ui-module-sidebar>` etc. quando os componentes chegarem.

## Design tokens (Tailwind 4 CSS-config)

- **Sem `tailwind.config.js`.** Toda a config vive em `src/styles.css`:
  `@import 'tailwindcss'`, `@source './app'` e o bloco `@theme` com os tokens
  (`--color-*`, `--radius-*`, `--shadow-*`, `--font-*`). As classes utilitárias
  (`bg-panel`, `text-ink`, `border-line`, `rounded-lg`, `font-display`…) derivam
  desses tokens.
- Regras de uso e vocabulário (cores, tipografia, elevação) estão em `DESIGN.md`.
- **Regra de ouro:** nenhum valor visual hardcoded fora de `src/styles.css`.

## Gate `tokens:check`

```bash
pnpm --filter web tokens:check     # node scripts/validate-design-tokens.mjs
```

O script varre `src/app/**` e falha (exit 1) se encontrar:
- cores/sombras/raios/font-family hardcoded (hex, `rgb()`, `hsl()`, classes de cor
  Tailwind tipo `bg-red-500`, `style="color:…"`),
- side-stripe borders/shadows (proibidos pelo DESIGN.md),
- uso de token global (`--color-*` etc.) que não existe em `styles.css`.

Ignora `core/api/generated/`, `node_modules`, `dist`, e arquivos como `*.spec.ts`,
`*.service.ts`, `*.store.ts`, `*.routes.ts`, `ui-color-picker.ts`. **Rode-o no CI**
(e idealmente num pre-commit) para manter a fidelidade ao design system ao longo do tempo.

## Contrato de API (kubb)

`pnpm --filter web api:generate` roda `kubb generate`, que lê o OpenAPI emitido pelo
backend e gera o cliente tipado em `src/app/core/api/generated/` (ignorado no git e
pelo `tokens:check`). Falta criar o `kubb.config.ts` apontando input (OpenAPI de
`apps/api`) → output (`src/app/core/api/generated`). Ver `src/app/core/api/README.md`.
No raiz do monorepo, `pnpm api:generate` encadeia o `openapi` do backend com este passo.

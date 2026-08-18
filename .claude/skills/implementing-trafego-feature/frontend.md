# Implementar — Frontend (Angular / apps/web)

Checklist acionável. Design system + regras no `CLAUDE.md` e em `apps/web/DESIGN.md`.

## Onde vai cada coisa

| Tipo | Local |
|---|---|
| Tela/fluxo | `apps/web/src/app/features/<feature>/` (componente standalone) |
| Componente de UI reusável | `apps/web/src/app/shared/ui/` (barrel `index.ts`) |
| Client da API | `apps/web/src/app/core/api/` (gerado por kubb — não editar à mão) |
| Navegação | `apps/web/src/app/core/navigation/app-modules.ts` |

## Regras

- **Angular 21 standalone + signals.** Sem NgModules. Estado com signals.
- **Sem cor/token hardcoded** (Princípios de engenharia — sem string mágica): usar variáveis do design system (`--color-accent`, `bg-panel`, `text-ink`, `font-brand`, etc.). Nunca hex/rgb solto nem `bg-blue-500`.
- **Reuso-primeiro:** usar componentes de `shared/ui` antes de criar novo. Faltou componente? Ver `shared/ui/VENDORING.md` (vendorizar do Automato) antes de escrever do zero.
- **Client tipado:** consumir a API pelo client kubb; regenerar com `pnpm api:generate` quando o contrato muda. Sem `fetch` manual duplicando tipos.
- **i18n/tom:** PT-BR.

## Verificação (obrigatória)

Rode o gate de tokens — bloqueia hex/rgb/hsl, cores Tailwind cruas, sombras/raios/fontes soltas fora do `styles.css`:

```bash
pnpm --filter web tokens:check
```

Corrija até passar (feedback loop) antes de concluir. Depois, `typecheck`/testes do app.

## Reuso-primeiro

Antes de criar componente: buscar em `apps/web/src/app/shared/ui/index.ts`. Antes de criar chamada de API: verificar o client gerado em `core/api`.

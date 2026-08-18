# OpenAPI — pipeline `zod → OpenAPI → kubb`

Contrato de API ponta-a-ponta **sem drift** (§4/§13, padrão Automato). A fonte da
verdade são os schemas **zod** definidos nas bordas de cada slice
(`src/modules/<mod>/schema.ts`) + os contratos canônicos em `@trafego/shared/schemas`.

## Etapas

1. **zod (fonte da verdade)** — cada endpoint valida input/output com zod na casca.
   Contratos de domínio compartilhados vivem em `@trafego/shared/schemas`
   (reutilizados, nunca redefinidos por slice).
2. **zod → OpenAPI** — `generate.ts` agrega os schemas dos slices e emite um
   documento OpenAPI 3.1 (`dist/openapi.json`). Ferramenta prevista:
   `@asteasolutions/zod-to-openapi` (registrar cada schema + rota).
   Rodado por: `pnpm --filter @trafego/api openapi`.
3. **OpenAPI → client (kubb)** — o pacote `web` (Angular) consome o
   `openapi.json` via **kubb** e gera tipos + client tipado.
   Rodado por: `pnpm --filter web api:generate`.

O script raiz `pnpm api:generate` encadeia (2) e (3):

```bash
pnpm api:generate   # = @trafego/api openapi  +  web api:generate
```

## TODO (skeleton)

- [ ] Instalar `@asteasolutions/zod-to-openapi` e registrar rotas/schemas em `generate.ts`.
- [ ] Anexar `zodToOpenApi` metadata (descriptions, exemplos) nos schemas dos slices.
- [ ] Emitir `dist/openapi.json` e apontar a config do kubb (no pacote `web`) para ele.
- [ ] Garantir cobertura: todo endpoint público tem schema de request/response.

# core/api — cliente gerado (kubb)

Este diretório hospeda o **cliente HTTP tipado gerado por kubb** a partir do
contrato OpenAPI do backend. Nada aqui é escrito à mão.

## Como funciona (CLAUDE.md §4 — "zod → OpenAPI → kubb")

1. O backend (`apps/api`) define os schemas em **zod** e emite um documento **OpenAPI**
   (`pnpm --filter @trafego/api openapi`).
2. Este app roda `pnpm api:generate` (script `web` → `kubb generate`), que lê o
   OpenAPI e gera, aqui em `core/api/generated/`:
   - tipos TypeScript das entidades e DTOs,
   - schemas zod para validação nas bordas,
   - funções de cliente (usando o `HttpClient` do Angular).
3. Tipos ponta-a-ponta, sem drift entre front e back.

## Regras

- `core/api/generated/` é **artefato de build** — não editar, não revisar linha a linha.
  Já está no `.gitignore` do app e é ignorado pelo `tokens:check`
  (ver `scripts/validate-design-tokens.mjs` → `IGNORED_PATH_PARTS`).
- Código de app importa **sempre** de `@core/api` (barrel), nunca de arquivos gerados soltos.
- O `kubb.config.ts` (a criar na finalização — ver `SETUP.md`) define o input
  (OpenAPI do backend) e o output (`src/app/core/api/generated`).

Enquanto o backend não expõe o OpenAPI, este diretório fica só com esta nota e o
barrel `index.ts` (placeholder).

/**
 * Gera `dist/openapi.json` a partir dos schemas zod dos slices.
 * Etapa (2) do pipeline `zod → OpenAPI → kubb` (ver README.md deste diretório).
 *
 * TODO: implementar com `@asteasolutions/zod-to-openapi`:
 *   - criar um OpenAPIRegistry;
 *   - registrar os schemas de cada `src/modules/<mod>/schema.ts` + os de
 *     `@trafego/shared/schemas`;
 *   - registrar cada rota (path, método, request/response);
 *   - `new OpenApiGeneratorV31(registry.definitions).generateDocument(...)`;
 *   - escrever o JSON em `dist/openapi.json`.
 */
import { pathToFileURL } from "node:url";

async function generate(): Promise<void> {
  // TODO: montar o documento OpenAPI e persistir.
  throw new Error("TODO: implementar geração OpenAPI (zod → OpenAPI)");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void generate();
}

export { generate };

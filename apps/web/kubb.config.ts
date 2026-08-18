import { defineConfig } from "@kubb/core";
import { pluginOas } from "@kubb/plugin-oas";
import { pluginTs } from "@kubb/plugin-ts";

/**
 * Contrato api→web: gera **só os TYPES** a partir do `openapi.json` (que a api
 * gera dos schemas zod). O consumo é via `BaseApiService` (Angular HttpClient),
 * não pelo client gerado — por isso sem `plugin-client`/`plugin-zod`.
 */
export default defineConfig({
  root: ".",
  input: { path: "../api/openapi.json" },
  output: {
    path: "./src/app/core/api/generated",
    clean: true,
    extension: { ".ts": "" },
  },
  plugins: [pluginOas(), pluginTs({ output: { path: "models" } })],
});

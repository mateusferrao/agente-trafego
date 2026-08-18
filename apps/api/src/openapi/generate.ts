/**
 * Etapa (2) do pipeline `zod → OpenAPI → kubb`: monta o documento OpenAPI 3.1 a
 * partir dos schemas zod dos slices (fonte única) e escreve `apps/api/openapi.json`
 * (input do kubb, que gera só os TYPES no web). O mesmo `buildDocument()` é servido
 * ao vivo em `GET /openapi.json`.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
  OpenApiGeneratorV31,
} from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { loginInput, meOutput, signupInput } from "../modules/auth/schema.js";
import { createOrgInput, orgOutput } from "../modules/orgs/schema.js";
import { accessStatusOutput, usageSummaryOutput } from "../modules/billing/schema.js";

extendZodWithOpenApi(z);

/** Destino do artefato lido pelo kubb (`apps/api/openapi.json`). */
const OUTPUT_PATH = fileURLToPath(new URL("../../openapi.json", import.meta.url));

/** Monta o documento OpenAPI a partir do registry de schemas + rotas. */
export function buildDocument(): ReturnType<OpenApiGeneratorV31["generateDocument"]> {
  const registry = new OpenAPIRegistry();

  const SignupInput = registry.register("SignupInput", signupInput);
  const LoginInput = registry.register("LoginInput", loginInput);
  const MeOutput = registry.register("MeOutput", meOutput);
  const CreateOrgInput = registry.register("CreateOrgInput", createOrgInput);
  const OrgOutput = registry.register("OrgOutput", orgOutput);
  const AccessStatusOutput = registry.register("AccessStatusOutput", accessStatusOutput);
  const UsageSummaryOutput = registry.register("UsageSummaryOutput", usageSummaryOutput);

  const jsonBody = (schema: z.ZodTypeAny) => ({
    body: { content: { "application/json": { schema } } },
  });
  const jsonRes = (description: string, schema: z.ZodTypeAny) => ({
    description,
    content: { "application/json": { schema } },
  });

  registry.registerPath({
    method: "post",
    path: "/api/auth/signup",
    tags: ["auth"],
    request: jsonBody(SignupInput),
    responses: { 201: jsonRes("sessão criada", MeOutput) },
  });
  registry.registerPath({
    method: "post",
    path: "/api/auth/login",
    tags: ["auth"],
    request: jsonBody(LoginInput),
    responses: {
      200: jsonRes("sessão", MeOutput),
      401: { description: "credenciais inválidas" },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/api/auth/logout",
    tags: ["auth"],
    responses: { 200: { description: "sessão encerrada" } },
  });
  registry.registerPath({
    method: "get",
    path: "/api/auth/me",
    tags: ["auth"],
    responses: {
      200: jsonRes("sessão corrente", MeOutput),
      401: { description: "não autenticado" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/api/orgs",
    tags: ["orgs"],
    responses: { 200: jsonRes("orgs do usuário", z.array(OrgOutput)) },
  });
  registry.registerPath({
    method: "post",
    path: "/api/orgs",
    tags: ["orgs"],
    request: jsonBody(CreateOrgInput),
    responses: { 201: jsonRes("org criada", OrgOutput) },
  });
  registry.registerPath({
    method: "get",
    path: "/api/billing/access-status",
    tags: ["billing"],
    responses: { 200: jsonRes("status de acesso da org", AccessStatusOutput) },
  });
  registry.registerPath({
    method: "get",
    path: "/api/billing/usage",
    tags: ["billing"],
    request: { query: z.object({ period: z.string().optional() }) },
    responses: { 200: jsonRes("resumo de uso do período", UsageSummaryOutput) },
  });

  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: "3.1.0",
    info: { title: "Agente de Tráfego API", version: "0.1.0" },
    servers: [{ url: "/" }],
  });
}

async function generate(): Promise<void> {
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(buildDocument(), null, 2)}\n`);
  // eslint-disable-next-line no-console -- script de linha de comando
  console.log("openapi.json gerado:", OUTPUT_PATH);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  generate().catch((err: unknown) => {
    // eslint-disable-next-line no-console -- script de linha de comando
    console.error("falha ao gerar openapi:", err);
    process.exit(1);
  });
}

export { generate };

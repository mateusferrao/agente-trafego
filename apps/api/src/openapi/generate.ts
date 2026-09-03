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
import { marketReferenceSchema } from "@trafego/shared";
import {
  emailCodeRequestInput,
  emailCodeVerifyInput,
  forgotPasswordInput,
  loginInput,
  meOutput,
  resetPasswordInput,
  signupInput,
  signupOutput,
} from "../modules/auth/schema.js";
import {
  createOrgInput,
  marketReferenceOutput,
  orgOutput,
  renameOrgInput,
  setMarketReferenceInput,
  setTimezoneInput,
} from "../modules/orgs/schema.js";
import { accessStatusOutput, costsOutput, usageSummaryOutput } from "../modules/billing/schema.js";
import { adAccountOutput } from "../modules/accounts/schema.js";
import {
  connectionAccountsOutput,
  connectionOutput,
  createConnectionInput,
  createConnectionOutput,
  selectAccountsInput,
  syncOutput,
} from "../modules/connections/schema.js";
import {
  agentConfigInput,
  agentGoalsInput,
  agentSummary,
  archetypeCatalogOutput,
  availableConversionsOutput,
  lastRunActionsOutput,
  muteCampaignInput,
  mutedCampaignsOutput,
  okOutput,
  playbookRuleInput,
  playbookRuleOutput,
  playbookRulesOutput,
  reseedArchetypeInput,
  setPausedInput,
  undoActionInput,
} from "../modules/agents/schema.js";
import {
  campaignAnalysesOutput,
  latestRunOutput,
  runDetailOutput,
  runListOutput,
  triggerRunOutput,
} from "../modules/runs/schema.js";
import { dashboardOutput, liveMetricsOutput, panoramaListOutput, refreshDataOutput } from "../modules/dashboard/schema.js";
import { timelineOutput } from "../modules/timeline/schema.js";
import { channelStateOutput } from "../modules/channels/schema.js";
import { channelGroupStateOutput, groupsListOutput, setGroupInput } from "../modules/groups/schema.js";
import { feedbackInput, feedbackOutput } from "../modules/recommendations/schema.js";
import { learningsList, editLearningInput, learningOk } from "../modules/learnings/schema.js";
import {
  startVerificationInput,
  startVerificationOutput,
  confirmVerificationInput,
  confirmVerificationOutput,
  recipientOutput,
  removeRecipientOutput,
} from "../modules/contacts/schema.js";
import {
  approvalOutput,
  editApprovalActionInput,
  resolveApprovalInput,
  resolveApprovalOutput,
  revertibleActionOutput,
} from "../modules/approvals/schema.js";
import {
  audienceOutput,
  creativeAssetOutput,
  deliveryEstimateInput,
  deliveryEstimateOutput,
  draftApprovalOutput,
  geoSearchResultOutput,
  interestSearchResultOutput,
  scaleWinnerInput,
  scaleWinnerOutput,
  servingCreativeOutput,
  uploadCreativeOutput,
  setDraftCreativeInput,
  setDraftCreativeOutput,
  setDraftTargetingInput,
  setDraftTargetingOutput,
  updateDraftInput,
  updateDraftOutput,
} from "../modules/drafts/schema.js";

extendZodWithOpenApi(z);

/** Destino do artefato lido pelo kubb (`apps/api/openapi.json`). */
const OUTPUT_PATH = fileURLToPath(new URL("../../openapi.json", import.meta.url));

/** Monta o documento OpenAPI a partir do registry de schemas + rotas. */
export function buildDocument(): ReturnType<OpenApiGeneratorV31["generateDocument"]> {
  const registry = new OpenAPIRegistry();

  const SignupInput = registry.register("SignupInput", signupInput);
  const SignupOutput = registry.register("SignupOutput", signupOutput);
  const EmailCodeRequestInput = registry.register("EmailCodeRequestInput", emailCodeRequestInput);
  const EmailCodeVerifyInput = registry.register("EmailCodeVerifyInput", emailCodeVerifyInput);
  const ForgotPasswordInput = registry.register("ForgotPasswordInput", forgotPasswordInput);
  const ResetPasswordInput = registry.register("ResetPasswordInput", resetPasswordInput);
  const LoginInput = registry.register("LoginInput", loginInput);
  const MeOutput = registry.register("MeOutput", meOutput);
  const CreateOrgInput = registry.register("CreateOrgInput", createOrgInput);
  const RenameOrgInput = registry.register("RenameOrgInput", renameOrgInput);
  const SetTimezoneInput = registry.register("SetTimezoneInput", setTimezoneInput);
  // registra o schema base como componente nomeado → kubb emite o tipo `MarketReference`
  // reusável (a UI edita esse objeto direto). Referenciado por Output/Input + agente.
  registry.register("MarketReference", marketReferenceSchema);
  const SetMarketReferenceInput = registry.register("SetMarketReferenceInput", setMarketReferenceInput);
  const MarketReferenceOutput = registry.register("MarketReferenceOutput", marketReferenceOutput);
  const OrgOutput = registry.register("OrgOutput", orgOutput);
  const AccessStatusOutput = registry.register("AccessStatusOutput", accessStatusOutput);
  const UsageSummaryOutput = registry.register("UsageSummaryOutput", usageSummaryOutput);
  const CostsOutput = registry.register("CostsOutput", costsOutput);
  const AdAccountOutput = registry.register("AdAccountOutput", adAccountOutput);
  const CreateConnectionInput = registry.register("CreateConnectionInput", createConnectionInput);
  const ConnectionOutput = registry.register("ConnectionOutput", connectionOutput);
  const CreateConnectionOutput = registry.register("CreateConnectionOutput", createConnectionOutput);
  const ConnectionAccountsOutput = registry.register("ConnectionAccountsOutput", connectionAccountsOutput);
  const SelectAccountsInput = registry.register("SelectAccountsInput", selectAccountsInput);
  const SyncOutput = registry.register("SyncOutput", syncOutput);
  const AgentSummary = registry.register("AgentSummary", agentSummary);
  const ArchetypeCatalogOutput = registry.register("ArchetypeCatalogOutput", archetypeCatalogOutput);
  const AgentGoalsInput = registry.register("AgentGoalsInput", agentGoalsInput);
  const AgentConfigInput = registry.register("AgentConfigInput", agentConfigInput);
  const AvailableConversionsOutput = registry.register("AvailableConversionsOutput", availableConversionsOutput);
  const SetPausedInput = registry.register("SetPausedInput", setPausedInput);
  const TriggerRunOutput = registry.register("TriggerRunOutput", triggerRunOutput);
  const LatestRunOutput = registry.register("LatestRunOutput", latestRunOutput);
  const CampaignAnalysesOutput = registry.register("CampaignAnalysesOutput", campaignAnalysesOutput);
  const RunListOutput = registry.register("RunListOutput", runListOutput);
  const LiveMetricsOutput = registry.register("LiveMetricsOutput", liveMetricsOutput);
  const RefreshDataOutput = registry.register("RefreshDataOutput", refreshDataOutput);
  const DashboardOutput = registry.register("DashboardOutput", dashboardOutput);
  const PanoramaListOutput = registry.register("PanoramaListOutput", panoramaListOutput);
  const TimelineOutput = registry.register("TimelineOutput", timelineOutput);
  const RunDetailOutput = registry.register("RunDetailOutput", runDetailOutput);
  const MuteCampaignInput = registry.register("MuteCampaignInput", muteCampaignInput);
  const MutedCampaignsOutput = registry.register("MutedCampaignsOutput", mutedCampaignsOutput);
  const PlaybookRuleInput = registry.register("PlaybookRuleInput", playbookRuleInput);
  const PlaybookRuleOutput = registry.register("PlaybookRuleOutput", playbookRuleOutput);
  const PlaybookRulesOutput = registry.register("PlaybookRulesOutput", playbookRulesOutput);
  const LastRunActionsOutput = registry.register("LastRunActionsOutput", lastRunActionsOutput);
  const OkOutput = registry.register("OkOutput", okOutput);
  const ReseedArchetypeInput = registry.register("ReseedArchetypeInput", reseedArchetypeInput);
  const UndoActionInput = registry.register("UndoActionInput", undoActionInput);
  const ChannelStateOutput = registry.register("ChannelStateOutput", channelStateOutput);
  const GroupsListOutput = registry.register("GroupsListOutput", groupsListOutput);
  const SetGroupInput = registry.register("SetGroupInput", setGroupInput);
  const ChannelGroupStateOutput = registry.register("ChannelGroupStateOutput", channelGroupStateOutput);
  const StartVerificationInput = registry.register("StartVerificationInput", startVerificationInput);
  const StartVerificationOutput = registry.register("StartVerificationOutput", startVerificationOutput);
  const ConfirmVerificationInput = registry.register("ConfirmVerificationInput", confirmVerificationInput);
  const ConfirmVerificationOutput = registry.register("ConfirmVerificationOutput", confirmVerificationOutput);
  const RecipientOutput = registry.register("RecipientOutput", recipientOutput);
  const RemoveRecipientOutput = registry.register("RemoveRecipientOutput", removeRecipientOutput);
  const FeedbackInput = registry.register("FeedbackInput", feedbackInput);
  const FeedbackOutput = registry.register("FeedbackOutput", feedbackOutput);
  const LearningsList = registry.register("LearningsList", learningsList);
  const EditLearningInput = registry.register("EditLearningInput", editLearningInput);
  const LearningOk = registry.register("LearningOk", learningOk);
  const ApprovalOutput = registry.register("ApprovalOutput", approvalOutput);
  const ResolveApprovalInput = registry.register("ResolveApprovalInput", resolveApprovalInput);
  const ResolveApprovalOutput = registry.register("ResolveApprovalOutput", resolveApprovalOutput);
  const EditApprovalActionInput = registry.register("EditApprovalActionInput", editApprovalActionInput);
  const DraftApprovalOutput = registry.register("DraftApprovalOutput", draftApprovalOutput);
  const ScaleWinnerInput = registry.register("ScaleWinnerInput", scaleWinnerInput);
  const ScaleWinnerOutput = registry.register("ScaleWinnerOutput", scaleWinnerOutput);
  const CreativeAssetOutput = registry.register("CreativeAssetOutput", creativeAssetOutput);
  const ServingCreativeOutput = registry.register("ServingCreativeOutput", servingCreativeOutput);
  const GeoSearchResultOutput = registry.register("GeoSearchResultOutput", geoSearchResultOutput);
  const InterestSearchResultOutput = registry.register("InterestSearchResultOutput", interestSearchResultOutput);
  const SetDraftTargetingInput = registry.register("SetDraftTargetingInput", setDraftTargetingInput);
  const SetDraftTargetingOutput = registry.register("SetDraftTargetingOutput", setDraftTargetingOutput);
  const DeliveryEstimateInput = registry.register("DeliveryEstimateInput", deliveryEstimateInput);
  const DeliveryEstimateOutput = registry.register("DeliveryEstimateOutput", deliveryEstimateOutput);
  const AudienceOutput = registry.register("AudienceOutput", audienceOutput);
  const SetDraftCreativeInput = registry.register("SetDraftCreativeInput", setDraftCreativeInput);
const SetDraftCreativeOutput = registry.register("SetDraftCreativeOutput", setDraftCreativeOutput);
  const UpdateDraftInput = registry.register("UpdateDraftInput", updateDraftInput);
  const UpdateDraftOutput = registry.register("UpdateDraftOutput", updateDraftOutput);
  const UploadCreativeOutput = registry.register("UploadCreativeOutput", uploadCreativeOutput);
  const RevertibleActionOutput = registry.register("RevertibleActionOutput", revertibleActionOutput);

  const accountParams = z.object({ id: z.string() });

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
    responses: {
      201: jsonRes("conta criada — verificação de email pendente", SignupOutput),
      400: { description: "senha fraca / payload inválido" },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/api/auth/email-code/request",
    tags: ["auth"],
    request: jsonBody(EmailCodeRequestInput),
    responses: { 204: { description: "código reenviado (sempre 204 — anti-enumeração)" } },
  });
  registry.registerPath({
    method: "post",
    path: "/api/auth/email-code/verify",
    tags: ["auth"],
    request: jsonBody(EmailCodeVerifyInput),
    responses: {
      200: jsonRes("email verificado — sessão criada", MeOutput),
      400: { description: "código inválido ou expirado" },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/api/auth/login",
    tags: ["auth"],
    request: jsonBody(LoginInput),
    responses: {
      200: jsonRes("sessão", MeOutput),
      401: { description: "credenciais inválidas" },
      403: { description: "email não verificado (código reenviado)" },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/api/auth/forgot-password",
    tags: ["auth"],
    request: jsonBody(ForgotPasswordInput),
    responses: { 204: { description: "link enviado (sempre 204 — anti-enumeração)" } },
  });
  registry.registerPath({
    method: "post",
    path: "/api/auth/reset-password",
    tags: ["auth"],
    request: jsonBody(ResetPasswordInput),
    responses: {
      204: { description: "senha redefinida (outras sessões revogadas)" },
      400: { description: "link inválido/expirado ou senha fraca" },
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
    method: "patch",
    path: "/api/orgs/current",
    tags: ["orgs"],
    request: jsonBody(RenameOrgInput),
    responses: { 200: jsonRes("org renomeada", OrgOutput) },
  });
  registry.registerPath({
    method: "get",
    path: "/api/orgs/current",
    tags: ["orgs"],
    responses: { 200: jsonRes("org ativa (nome + fuso)", OrgOutput) },
  });
  registry.registerPath({
    method: "patch",
    path: "/api/orgs/current/timezone",
    tags: ["orgs"],
    request: jsonBody(SetTimezoneInput),
    responses: { 200: jsonRes("fuso da org atualizado", OrgOutput) },
  });
  registry.registerPath({
    method: "get",
    path: "/api/orgs/current/market-reference",
    tags: ["orgs"],
    responses: { 200: jsonRes("referência de mercado padrão da org", MarketReferenceOutput) },
  });
  registry.registerPath({
    method: "put",
    path: "/api/orgs/current/market-reference",
    tags: ["orgs"],
    request: jsonBody(SetMarketReferenceInput),
    responses: { 200: jsonRes("referência de mercado atualizada", MarketReferenceOutput) },
  });
  registry.registerPath({
    method: "get",
    path: "/api/accounts",
    tags: ["accounts"],
    responses: { 200: jsonRes("contas sob gestão da org", z.array(AdAccountOutput)) },
  });
  registry.registerPath({
    method: "post",
    path: "/api/connections",
    tags: ["connections"],
    request: jsonBody(CreateConnectionInput),
    responses: {
      201: jsonRes("conexão criada + contas acessíveis", CreateConnectionOutput),
      400: { description: "token inválido ou sem permissões" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/api/connections",
    tags: ["connections"],
    responses: { 200: jsonRes("conexões da org", z.array(ConnectionOutput)) },
  });
  registry.registerPath({
    method: "get",
    path: "/api/connections/{id}/accounts",
    tags: ["connections"],
    request: { params: accountParams },
    responses: { 200: jsonRes("contas acessíveis + geridas da conexão", ConnectionAccountsOutput) },
  });
  registry.registerPath({
    method: "post",
    path: "/api/connections/{id}/accounts/select",
    tags: ["connections"],
    request: { params: accountParams, ...jsonBody(SelectAccountsInput) },
    responses: { 200: jsonRes("seleção aplicada", ConnectionAccountsOutput) },
  });
  registry.registerPath({
    method: "post",
    path: "/api/connections/{id}/sync",
    tags: ["connections"],
    request: { params: accountParams },
    responses: {
      200: jsonRes("contas reconciliadas", SyncOutput),
      400: { description: "token inválido ou sem permissões" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/api/agents/archetypes",
    tags: ["agents"],
    responses: { 200: jsonRes("catálogo de arquétipos (seleção na config)", ArchetypeCatalogOutput) },
  });
  registry.registerPath({
    method: "get",
    path: "/api/accounts/{id}/agent",
    tags: ["agents"],
    request: { params: accountParams },
    responses: { 200: jsonRes("agente da conta (cria se não existir)", AgentSummary) },
  });
  registry.registerPath({
    method: "put",
    path: "/api/accounts/{id}/agent/config",
    tags: ["agents"],
    request: { params: accountParams, ...jsonBody(AgentConfigInput) },
    responses: { 200: jsonRes("config do agente atualizada", AgentSummary) },
  });
  registry.registerPath({
    method: "put",
    path: "/api/accounts/{id}/agent/archetype",
    tags: ["agents"],
    request: { params: accountParams, ...jsonBody(ReseedArchetypeInput) },
    responses: { 200: jsonRes("arquétipo re-semeado (comportamento resetado)", AgentSummary) },
  });
  registry.registerPath({
    method: "get",
    path: "/api/accounts/{id}/available-conversions",
    tags: ["agents"],
    request: { params: accountParams },
    responses: { 200: jsonRes("conversões reportadas pela conta (select da config)", AvailableConversionsOutput) },
  });
  registry.registerPath({
    method: "put",
    path: "/api/accounts/{id}/agent/paused",
    tags: ["agents"],
    request: { params: accountParams, ...jsonBody(SetPausedInput) },
    responses: { 200: jsonRes("análises automáticas pausadas/retomadas", AgentSummary) },
  });
  registry.registerPath({
    method: "post",
    path: "/api/channels/connect",
    tags: ["channels"],
    responses: { 200: jsonRes("instância conectando (QR) ou conectada", ChannelStateOutput) },
  });
  registry.registerPath({
    method: "get",
    path: "/api/channels/status",
    tags: ["channels"],
    responses: { 200: jsonRes("estado do canal WhatsApp da org", ChannelStateOutput) },
  });
  registry.registerPath({
    method: "post",
    path: "/api/channels/disconnect",
    tags: ["channels"],
    responses: { 200: jsonRes("canal desconectado (logout do número)", ChannelStateOutput) },
  });
  registry.registerPath({
    method: "get",
    path: "/api/channels/groups",
    tags: ["channels"],
    responses: { 200: jsonRes("grupos que o número integra + o ativo da org (se algum)", GroupsListOutput) },
  });
  registry.registerPath({
    method: "put",
    path: "/api/channels/group",
    tags: ["channels"],
    request: jsonBody(SetGroupInput),
    responses: { 200: jsonRes("grupo ativado pra org", ChannelGroupStateOutput) },
  });
  registry.registerPath({
    method: "delete",
    path: "/api/channels/group",
    tags: ["channels"],
    responses: { 200: jsonRes("grupo desligado (soft)", ChannelGroupStateOutput) },
  });
  registry.registerPath({
    method: "post",
    path: "/api/contacts/verify/start",
    tags: ["contacts"],
    request: jsonBody(StartVerificationInput),
    responses: {
      202: jsonRes("código enviado pelo WhatsApp", StartVerificationOutput),
      400: { description: "WhatsApp não conectado" },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/api/contacts/verify/confirm",
    tags: ["contacts"],
    request: jsonBody(ConfirmVerificationInput),
    responses: {
      200: jsonRes("contato verificado", ConfirmVerificationOutput),
      400: { description: "código inválido ou expirado" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/api/contacts/recipient",
    tags: ["contacts"],
    responses: { 200: jsonRes("destinatário atual (verificado) da org", RecipientOutput) },
  });
  registry.registerPath({
    method: "post",
    path: "/api/contacts/recipient/remove",
    tags: ["contacts"],
    responses: { 200: jsonRes("destinatário removido", RemoveRecipientOutput) },
  });
  registry.registerPath({
    method: "post",
    path: "/api/accounts/{id}/runs",
    tags: ["runs"],
    request: { params: accountParams },
    responses: {
      202: jsonRes("análise enfileirada", TriggerRunOutput),
      409: { description: "já há uma análise em andamento" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/api/accounts/{id}/runs/latest",
    tags: ["runs"],
    request: { params: accountParams },
    responses: { 200: jsonRes("último run + recomendações", LatestRunOutput) },
  });
  registry.registerPath({
    method: "get",
    path: "/api/accounts/{id}/campaign-analyses",
    tags: ["runs"],
    request: { params: accountParams },
    responses: { 200: jsonRes("recorte por campanha do resultado atual", CampaignAnalysesOutput) },
  });
  registry.registerPath({
    method: "get",
    path: "/api/accounts/{id}/runs",
    tags: ["runs"],
    request: {
      params: accountParams,
      query: z.object({
        grades: z.string().optional(),
        since: z.string().optional(),
        until: z.string().optional(),
        limit: z.string().optional(),
        offset: z.string().optional(),
      }),
    },
    responses: { 200: jsonRes("histórico de análises (lista paginada)", RunListOutput) },
  });
  registry.registerPath({
    method: "get",
    path: "/api/accounts/{id}/runs/{runId}",
    tags: ["runs"],
    request: { params: z.object({ id: z.string(), runId: z.string() }) },
    responses: {
      200: jsonRes("detalhe de um run (histórico)", RunDetailOutput),
      404: { description: "análise não encontrada" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/api/dashboard",
    tags: ["dashboard"],
    responses: { 200: jsonRes("painel gerencial cross-conta (4 widgets)", DashboardOutput) },
  });
  registry.registerPath({
    method: "get",
    path: "/api/accounts/panorama",
    tags: ["dashboard"],
    responses: { 200: jsonRes("lista rica de contas (panorama completo)", PanoramaListOutput) },
  });
  registry.registerPath({
    method: "get",
    path: "/api/accounts/{id}/live-metrics",
    tags: ["dashboard"],
    request: { params: accountParams },
    responses: {
      200: jsonRes("KPIs da conta ao vivo (insights_snapshots) + as-of", LiveMetricsOutput),
      404: { description: "conta não encontrada" },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/api/accounts/{id}/refresh-data",
    tags: ["dashboard"],
    request: { params: accountParams },
    responses: {
      202: jsonRes("sync-only enfileirado (atualizar agora)", RefreshDataOutput),
      404: { description: "conta não encontrada" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/api/accounts/{id}/timeline",
    tags: ["timeline"],
    request: {
      params: accountParams,
      query: z.object({
        types: z.string().optional(),
        since: z.string().optional(),
        limit: z.string().optional(),
        offset: z.string().optional(),
      }),
    },
    responses: { 200: jsonRes("feed de auditoria da conta (paginado)", TimelineOutput) },
  });
  registry.registerPath({
    method: "get",
    path: "/api/accounts/{id}/muted-campaigns",
    tags: ["agents"],
    request: { params: accountParams },
    responses: { 200: jsonRes("campanhas silenciadas da conta", MutedCampaignsOutput) },
  });
  registry.registerPath({
    method: "post",
    path: "/api/accounts/{id}/muted-campaigns",
    tags: ["agents"],
    request: { params: accountParams, ...jsonBody(MuteCampaignInput) },
    responses: { 200: jsonRes("campanha silenciada", MutedCampaignsOutput) },
  });
  registry.registerPath({
    method: "delete",
    path: "/api/accounts/{id}/muted-campaigns/{externalId}",
    tags: ["agents"],
    request: { params: z.object({ id: z.string(), externalId: z.string() }) },
    responses: { 200: jsonRes("campanha reativada", MutedCampaignsOutput) },
  });
  registry.registerPath({
    method: "get",
    path: "/api/accounts/{id}/agent/playbook-rules",
    tags: ["agents"],
    request: { params: accountParams },
    responses: { 200: jsonRes("regras de playbook do agente", PlaybookRulesOutput) },
  });
  registry.registerPath({
    method: "post",
    path: "/api/accounts/{id}/agent/playbook-rules",
    tags: ["agents"],
    request: { params: accountParams, ...jsonBody(PlaybookRuleInput) },
    responses: { 200: jsonRes("regra criada", PlaybookRuleOutput) },
  });
  registry.registerPath({
    method: "put",
    path: "/api/accounts/{id}/agent/playbook-rules/{ruleId}",
    tags: ["agents"],
    request: { params: z.object({ id: z.string(), ruleId: z.string() }), ...jsonBody(PlaybookRuleInput) },
    responses: {
      200: jsonRes("regra atualizada", PlaybookRuleOutput),
      404: { description: "regra não encontrada" },
    },
  });
  registry.registerPath({
    method: "delete",
    path: "/api/accounts/{id}/agent/playbook-rules/{ruleId}",
    tags: ["agents"],
    request: { params: z.object({ id: z.string(), ruleId: z.string() }) },
    responses: {
      200: jsonRes("regra removida", OkOutput),
      404: { description: "regra não encontrada" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/api/accounts/{id}/agent/actions/last-run",
    tags: ["agents"],
    request: { params: accountParams },
    responses: { 200: jsonRes("ações aplicadas + sugeridas do último run", LastRunActionsOutput) },
  });
  registry.registerPath({
    method: "post",
    path: "/api/accounts/{id}/agent/actions/{toolCallId}/undo",
    tags: ["agents"],
    request: {
      params: z.object({ id: z.string(), toolCallId: z.string() }),
      ...jsonBody(UndoActionInput),
    },
    responses: {
      200: jsonRes("undo enfileirado", OkOutput),
      400: { description: "prazo expirado / nada a reverter" },
      404: { description: "ação não encontrada" },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/api/recommendations/{id}/feedback",
    tags: ["recommendations"],
    request: { params: z.object({ id: z.string() }), ...jsonBody(FeedbackInput) },
    responses: { 200: jsonRes("feedback registrado", FeedbackOutput) },
  });
  registry.registerPath({
    method: "get",
    path: "/api/agents/{agentId}/learnings",
    tags: ["learnings"],
    request: { params: z.object({ agentId: z.string() }) },
    responses: { 200: jsonRes("aprendizados curados do agente", LearningsList), 404: { description: "agente não encontrado" } },
  });
  registry.registerPath({
    method: "patch",
    path: "/api/agents/{agentId}/learnings/{id}",
    tags: ["learnings"],
    request: { params: z.object({ agentId: z.string(), id: z.string() }), ...jsonBody(EditLearningInput) },
    responses: { 200: jsonRes("aprendizado editado", LearningOk), 404: { description: "não encontrado" } },
  });
  registry.registerPath({
    method: "post",
    path: "/api/agents/{agentId}/learnings/{id}/confirm",
    tags: ["learnings"],
    request: { params: z.object({ agentId: z.string(), id: z.string() }) },
    responses: { 200: jsonRes("aprendizado confirmado", LearningOk), 404: { description: "não encontrado" } },
  });
  registry.registerPath({
    method: "delete",
    path: "/api/agents/{agentId}/learnings/{id}",
    tags: ["learnings"],
    request: { params: z.object({ agentId: z.string(), id: z.string() }) },
    responses: { 200: jsonRes("aprendizado esquecido", LearningOk), 404: { description: "não encontrado" } },
  });
  registry.registerPath({
    method: "post",
    path: "/api/agents/{agentId}/learnings/{id}/accept-threshold",
    tags: ["learnings"],
    request: { params: z.object({ agentId: z.string(), id: z.string() }) },
    responses: { 200: jsonRes("ajuste de comportamento aplicado", LearningOk), 400: { description: "sem proposta / limiar ilegível" }, 404: { description: "não encontrado" } },
  });
  registry.registerPath({
    method: "get",
    path: "/api/approvals",
    tags: ["approvals"],
    responses: { 200: jsonRes("aprovações pendentes da org (cross-conta)", z.array(ApprovalOutput)) },
  });
  registry.registerPath({
    method: "get",
    path: "/api/approvals/revertible",
    tags: ["approvals"],
    responses: {
      200: jsonRes("ações aplicadas ainda acionáveis quanto a reverter, cross-conta", z.array(RevertibleActionOutput)),
    },
  });
  registry.registerPath({
    method: "post",
    path: "/api/approvals/{id}/resolve",
    tags: ["approvals"],
    request: { params: z.object({ id: z.string() }), ...jsonBody(ResolveApprovalInput) },
    responses: {
      200: jsonRes("aprovação resolvida (aprovada = enfileirada; rejeitada = direto)", ResolveApprovalOutput),
      404: { description: "aprovação não encontrada" },
    },
  });
  registry.registerPath({
    method: "patch",
    path: "/api/approvals/{id}/action",
    tags: ["approvals"],
    request: { params: z.object({ id: z.string() }), ...jsonBody(EditApprovalActionInput) },
    responses: {
      200: jsonRes("valor da ação editado (segue pendente até aprovar)", ResolveApprovalOutput),
      400: { description: "ação não editável ou valor inválido" },
      404: { description: "aprovação não encontrada" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/api/drafts/pending",
    tags: ["drafts"],
    responses: { 200: jsonRes("rascunhos de campanha aguardando aprovação (cross-conta)", z.array(DraftApprovalOutput)) },
  });
  registry.registerPath({
    method: "post",
    path: "/api/accounts/{id}/drafts/scale",
    tags: ["drafts"],
    request: { params: z.object({ id: z.string() }), ...jsonBody(ScaleWinnerInput) },
    responses: {
      200: jsonRes("escala proposta (rascunho de duplicação ou ação de budget)", ScaleWinnerOutput),
      404: { description: "conta ou agente não encontrado" },
    },
  });
  registry.registerPath({
    method: "patch",
    path: "/api/accounts/{id}/drafts/{draftId}",
    tags: ["drafts"],
    request: {
      params: z.object({ id: z.string(), draftId: z.string() }),
      ...jsonBody(UpdateDraftInput),
    },
    responses: {
      200: jsonRes("rascunho editado", UpdateDraftOutput),
      422: { description: "edição inválida (mensagem amigável)" },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/api/accounts/{id}/drafts/{draftId}/creative",
    tags: ["drafts"],
    request: {
      params: z.object({ id: z.string(), draftId: z.string() }),
      ...jsonBody(SetDraftCreativeInput),
    },
    responses: {
      200: jsonRes("criativo do rascunho trocado", SetDraftCreativeOutput),
      404: { description: "rascunho não encontrado ou não editável" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/api/accounts/{id}/creatives",
    tags: ["drafts"],
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: jsonRes("biblioteca de criativos da conta", z.array(CreativeAssetOutput)) },
  });
  registry.registerPath({
    method: "get",
    path: "/api/accounts/{id}/serving-creatives",
    tags: ["drafts"],
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: jsonRes("anúncios ao vivo da conta oferecidos como reuse (só vídeo)", z.array(ServingCreativeOutput)) },
  });
  registry.registerPath({
    method: "get",
    path: "/api/accounts/{id}/targeting/geo-search",
    tags: ["drafts"],
    request: { params: z.object({ id: z.string() }), query: z.object({ q: z.string() }) },
    responses: { 200: jsonRes("busca de geo (cidade/região/país) pro editor de público explícito", z.array(GeoSearchResultOutput)) },
  });
  registry.registerPath({
    method: "get",
    path: "/api/accounts/{id}/targeting/interest-search",
    tags: ["drafts"],
    request: { params: z.object({ id: z.string() }), query: z.object({ q: z.string() }) },
    responses: { 200: jsonRes("busca de interesses pro editor de público explícito", z.array(InterestSearchResultOutput)) },
  });
  registry.registerPath({
    method: "get",
    path: "/api/accounts/{id}/targeting/behavior-search",
    tags: ["drafts"],
    request: { params: z.object({ id: z.string() }), query: z.object({ q: z.string() }) },
    responses: { 200: jsonRes("busca de comportamentos pro editor de público explícito", z.array(InterestSearchResultOutput)) },
  });
  registry.registerPath({
    method: "get",
    path: "/api/accounts/{id}/audiences",
    tags: ["drafts"],
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: jsonRes("públicos salvos da conta pro editor (include/exclude)", z.array(AudienceOutput)) },
  });
  registry.registerPath({
    method: "post",
    path: "/api/accounts/{id}/drafts/{draftId}/targeting",
    tags: ["drafts"],
    request: {
      params: z.object({ id: z.string(), draftId: z.string() }),
      ...jsonBody(SetDraftTargetingInput),
    },
    responses: { 200: jsonRes("público do rascunho alternado (reuse × amplo)", SetDraftTargetingOutput) },
  });
  registry.registerPath({
    method: "post",
    path: "/api/accounts/{id}/drafts/{draftId}/delivery-estimate",
    tags: ["drafts"],
    request: {
      params: z.object({ id: z.string(), draftId: z.string() }),
      ...jsonBody(DeliveryEstimateInput),
    },
    responses: { 200: jsonRes("estimativa de alcance do público explícito em edição", DeliveryEstimateOutput) },
  });
  registry.registerPath({
    method: "post",
    path: "/api/accounts/{id}/creatives/upload",
    tags: ["drafts"],
    // request = multipart/form-data (arquivo) — fora do contrato JSON; a web posta FormData.
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: jsonRes("criativo subido (imagem=ready/image_hash; vídeo=pending/video_id)", UploadCreativeOutput),
      404: { description: "conta ou agente não encontrado" },
    },
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
  registry.registerPath({
    method: "get",
    path: "/api/billing/costs",
    tags: ["billing"],
    request: { query: z.object({ since: z.string().optional(), until: z.string().optional() }) },
    responses: { 200: jsonRes("custos do owner (série diária + por conta + por tipo + cap)", CostsOutput) },
  });

  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: "3.1.0",
    info: { title: "CaquiAI API", version: "0.1.0" },
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

/**
 * E2E RUNTIME das travas da Fatia 7 (config por-ação + auto-criação) contra Postgres
 * EFÊMERO (trafego_e2e_cfg) + adapter Meta FALSO (records calls). Prova, em runtime, o que
 * a suíte unitária não cobre ponta-a-ponta: gate de criação barrando, clamp de gasto novo
 * CHEGANDO no adapter, kill-switch, PAUSED-through-adapter na auto-criação, e a corrida de
 * claim (dois applies do MESMO rascunho não duplicam gasto real). NÃO toca Meta nem o DB dev.
 *
 * Rodar: E2E_DATABASE_URL=postgres://postgres:postgres@localhost:5432/trafego_e2e_cfg \
 *   pnpm --filter @trafego/worker exec tsx e2e-config-acao-saga.ts
 */
import { and, eq } from "drizzle-orm";
import {
  createDb,
  orgs,
  platformConnections,
  adAccounts,
  agents,
  guardrailConfigs,
  agentToolBindings,
  campaignDrafts,
} from "@trafego/db";
import { applyDraft, autoApplyProactiveDraft } from "./src/modules/apply/apply-draft.js";
import type { WorkerDeps } from "./src/composition.js";

const URL = process.env["E2E_DATABASE_URL"] ?? "postgres://postgres:postgres@localhost:5432/trafego_e2e_cfg";
const db = createDb(URL);

const ORG = "11111111-1111-1111-1111-111111111111";
const CONN = "22222222-2222-2222-2222-222222222222";
const ACC = "33333333-3333-3333-3333-333333333333";
const AGENT = "44444444-4444-4444-4444-444444444444";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}`, detail !== undefined ? JSON.stringify(detail) : "");
  }
}

interface FakeCall {
  readonly fn: string;
  readonly args: Record<string, unknown>;
}
function makeFakeAds() {
  const calls: FakeCall[] = [];
  let seq = 0;
  const ads = {
    duplicateEntity: async (_r: unknown, input: Record<string, unknown>) => {
      calls.push({ fn: "duplicateEntity", args: input });
      return { copiedId: `copied_${++seq}`, childIds: [] as string[] };
    },
    setEntityBudget: async (_r: unknown, id: string, minor: number) => {
      calls.push({ fn: "setEntityBudget", args: { id, minor } });
    },
    createCampaign: async (_r: unknown, input: Record<string, unknown>) => {
      calls.push({ fn: "createCampaign", args: input });
      return { campaignId: `camp_${++seq}` };
    },
    createAdSet: async (_r: unknown, input: Record<string, unknown>) => {
      calls.push({ fn: "createAdSet", args: input });
      return { adsetId: `adset_${++seq}` };
    },
    createAdCreative: async (_r: unknown, input: Record<string, unknown>) => {
      calls.push({ fn: "createAdCreative", args: input });
      return { creativeId: `cr_${++seq}` };
    },
    createAd: async (_r: unknown, input: Record<string, unknown>) => {
      calls.push({ fn: "createAd", args: input });
      return { adId: `ad_${++seq}` };
    },
  };
  return { ads, calls };
}

function makeDeps(fakeAds: ReturnType<typeof makeFakeAds>["ads"]) {
  const resolves: { id: string; r: Record<string, unknown> }[] = [];
  const deps = {
    db,
    logger: { warn() {}, info() {}, debug() {}, error() {} },
    ports: {
      vault: { decrypt: () => "TESTTOKEN", encrypt: () => ({}) },
      ads: fakeAds,
      metering: { record: async () => {} },
      approval: { resolve: async (id: string, r: Record<string, unknown>) => { resolves.push({ id, r }); } },
    },
  } as unknown as WorkerDeps;
  return { deps, resolves };
}

async function setGuardrail(patch: Record<string, unknown>) {
  await db
    .update(guardrailConfigs)
    .set({ dryRun: false, killSwitch: false, maxNewDailyBudgetMinor: 100000, maxNewCampaignsPerDay: 5, ...patch })
    .where(eq(guardrailConfigs.agentId, AGENT));
}
async function setBinding(toolKey: string, mode: "enabled" | "disabled" | "shadow") {
  await db
    .insert(agentToolBindings)
    .values({ orgId: ORG, agentId: AGENT, toolKey, mode })
    .onConflictDoUpdate({ target: [agentToolBindings.agentId, agentToolBindings.toolKey], set: { mode } });
}
async function clearBinding(toolKey: string) {
  await db.delete(agentToolBindings).where(and(eq(agentToolBindings.agentId, AGENT), eq(agentToolBindings.toolKey, toolKey)));
}

async function insertDraft(over: Record<string, unknown>): Promise<string> {
  const [row] = await db
    .insert(campaignDrafts)
    .values({
      orgId: ORG,
      adAccountId: ACC,
      agentId: AGENT,
      status: "proposed",
      origin: "proactive",
      createdIds: {},
      runId: null,
      ...over,
    } as never)
    .returning({ id: campaignDrafts.id });
  return row!.id;
}

const DUP_SPEC = { version: 1, currency: "BRL", dailyBudgetMinor: 50000, activation: "active" };
const SCRATCH_SPEC = {
  version: 1,
  currency: "BRL",
  dailyBudgetMinor: 3000,
  activation: "active",
  objective: "purchase",
  targeting: { kind: "advantage_plus" },
  variantsCount: 1,
  copyVariants: [{ primaryText: "texto", headline: "titulo" }],
  creative: { assetId: "reuse", format: "image", origin: "reuse", metaImageHash: "HASH123" },
  pageId: "PAGE1",
};

async function seed() {
  await db.insert(orgs).values({ id: ORG, name: "E2E cfg", slug: "e2e-cfg-saga" }).onConflictDoNothing();
  await db.insert(platformConnections).values({ id: CONN, orgId: ORG, platform: "meta", tokenCripto: { v: 1 } as never, tokenStatus: "valid" } as never).onConflictDoNothing();
  await db.insert(adAccounts).values({ id: ACC, orgId: ORG, connectionId: CONN, adAccountId: "1423420276172802", tokenCripto: { v: 1 } as never, status: "active", currency: "BRL" } as never).onConflictDoNothing();
  await db.insert(agents).values({ id: AGENT, orgId: ORG, adAccountId: ACC, autonomyPolicy: { bySource: { playbook: "act_safe", llm: "suggest" } } as never } as never).onConflictDoNothing();
  await db.insert(guardrailConfigs).values({ orgId: ORG, agentId: AGENT, dryRun: false } as never).onConflictDoNothing();
}

async function main() {
  await seed();

  // ── S1: gate de criação (duplicate_scale DISABLED) barra, sem tocar o adapter ──
  console.log("\n▶ S1 — gate: duplicate_scale desligado barra o apply (sem Meta)");
  {
    await setBinding("duplicate_scale", "disabled");
    await setGuardrail({});
    const { ads, calls } = makeFakeAds();
    const { deps } = makeDeps(ads);
    const draftId = await insertDraft({ kind: "duplicate", spec: DUP_SPEC, sourceRef: { level: "adset", id: "src_adset" } });
    const out = await applyDraft(deps, { orgId: ORG, draftId });
    const [row] = await db.select({ status: campaignDrafts.status }).from(campaignDrafts).where(eq(campaignDrafts.id, draftId));
    check("outcome=blocked", out.kind === "blocked", out);
    check("adapter NÃO chamado", calls.length === 0, calls);
    check("draft.status=failed", row?.status === "failed", row);
  }

  // ── S2: clamp de gasto novo CHEGA no adapter (cap < pedido) ──
  console.log("\n▶ S2 — clamp de gasto novo (cap 1000 < 50000 pedido) chega no setEntityBudget");
  {
    await setBinding("duplicate_scale", "enabled");
    await setGuardrail({ maxNewDailyBudgetMinor: 1000 });
    const { ads, calls } = makeFakeAds();
    const { deps } = makeDeps(ads);
    const draftId = await insertDraft({ kind: "duplicate", spec: DUP_SPEC, sourceRef: { level: "adset", id: "src_adset" } });
    const out = await applyDraft(deps, { orgId: ORG, draftId });
    const budgetCall = calls.find((c) => c.fn === "setEntityBudget");
    check("outcome=created", out.kind === "created", out);
    check("duplicateEntity chamado", calls.some((c) => c.fn === "duplicateEntity"));
    check("budget clampado ao cap (1000)", budgetCall?.args["minor"] === 1000, budgetCall);
  }

  // ── S3: kill-switch barra tudo ──
  console.log("\n▶ S3 — kill-switch barra a criação (sem Meta)");
  {
    await setBinding("duplicate_scale", "enabled");
    await setGuardrail({ killSwitch: true });
    const { ads, calls } = makeFakeAds();
    const { deps } = makeDeps(ads);
    const draftId = await insertDraft({ kind: "duplicate", spec: DUP_SPEC, sourceRef: { level: "adset", id: "src_adset" } });
    const out = await applyDraft(deps, { orgId: ORG, draftId });
    check("outcome=blocked (kill switch)", out.kind === "blocked" && /kill/i.test((out as { reason?: string }).reason ?? ""), out);
    check("adapter NÃO chamado", calls.length === 0, calls);
  }

  // ── S4: auto-criação força PAUSED no adapter mesmo com spec.activation=active ──
  console.log("\n▶ S4 — autoApplyProactiveDraft força PAUSED nos create* + resolve approval=approved");
  {
    await setBinding("create_campaign", "enabled");
    await setGuardrail({});
    const { ads, calls } = makeFakeAds();
    const { deps, resolves } = makeDeps(ads);
    const draftId = await insertDraft({ kind: "from_scratch", spec: SCRATCH_SPEC });
    const out = await autoApplyProactiveDraft(deps, { orgId: ORG, draftId, approvalId: "appr-s4" });
    const camp = calls.find((c) => c.fn === "createCampaign");
    const adset = calls.find((c) => c.fn === "createAdSet");
    const ad = calls.find((c) => c.fn === "createAd");
    check("outcome=created", out.kind === "created", out);
    check("createCampaign status=paused (trava, spec era active)", camp?.args["status"] === "paused", camp);
    check("createAdSet status=paused", adset?.args["status"] === "paused", adset);
    check("createAd status=paused", ad?.args["status"] === "paused", ad);
    check("approval resolvida approved", resolves.some((r) => r.id === "appr-s4" && r.r["status"] === "approved"), resolves);
    const [row] = await db.select({ spec: campaignDrafts.spec, status: campaignDrafts.status }).from(campaignDrafts).where(eq(campaignDrafts.id, draftId));
    check("draft persistido activation=paused", (row?.spec as { activation?: string })?.activation === "paused", row?.spec);
    check("draft.status=created", row?.status === "created", row);
  }

  // ── S5: corrida de claim — dois applies do MESMO rascunho não duplicam ──
  console.log("\n▶ S5 — corrida de claim: 2 applies concorrentes do MESMO rascunho criam UMA vez");
  {
    await setBinding("create_campaign", "enabled");
    await setGuardrail({});
    const { ads, calls } = makeFakeAds();
    const { deps } = makeDeps(ads);
    const draftId = await insertDraft({ kind: "from_scratch", spec: SCRATCH_SPEC });
    const [a, b] = await Promise.all([
      applyDraft(deps, { orgId: ORG, draftId }),
      applyDraft(deps, { orgId: ORG, draftId }),
    ]);
    const createdCount = calls.filter((c) => c.fn === "createCampaign").length;
    const outcomes = [a.kind, b.kind].sort();
    check("createCampaign chamado EXATAMENTE 1x", createdCount === 1, { createdCount });
    check("um created + um blocked", outcomes[0] === "blocked" && outcomes[1] === "created", outcomes);
  }

  // ── S6: cap de campanhas novas/dia ──
  console.log("\n▶ S6 — cap de campanhas novas/dia (limite 1, já há 1 criada nas 24h) barra");
  {
    await setBinding("duplicate_scale", "enabled");
    await setGuardrail({ maxNewCampaignsPerDay: 1 });
    // já existe 1 criada hoje (S2/S4/S5 podem ter criado; garante ao menos 1 recente):
    await insertDraft({ kind: "duplicate", spec: DUP_SPEC, sourceRef: { level: "adset", id: "src_adset" }, status: "created", createdIds: { copiedId: "x" } });
    const { ads, calls } = makeFakeAds();
    const { deps } = makeDeps(ads);
    const draftId = await insertDraft({ kind: "duplicate", spec: DUP_SPEC, sourceRef: { level: "adset", id: "src_adset" } });
    const out = await applyDraft(deps, { orgId: ORG, draftId });
    check("outcome=blocked (cap/dia)", out.kind === "blocked" && /limite/i.test((out as { reason?: string }).reason ?? ""), out);
    check("adapter NÃO chamado", calls.length === 0, calls);
  }

  console.log(`\n── resultado: ${pass} passaram, ${fail} falharam ──`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("HARNESS FALHOU:", e);
  process.exit(1);
});

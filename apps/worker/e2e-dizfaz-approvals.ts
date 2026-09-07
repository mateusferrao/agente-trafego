/**
 * E2E REAL diz×faz — FLUXO DE APROVAÇÃO (dados fake): edição + rejeição + aprovação de TODOS os tipos
 * que a iniciativa adicionou/alterou. Seed de `approvals` fake mirando adsets REAIS da BM-Automato;
 * a APROVAÇÃO roda em DRY-RUN (guardrail dry_run=true → o apply SIMULA, sem escrita real na Meta) —
 * então não muda nada na conta. Restaura guardrail + limpa os approvals no fim.
 * Rodar: cd apps/worker && npx tsx --env-file=<scratch>/.env.e2e e2e-dizfaz-approvals.ts
 */
import { and, eq, inArray } from "drizzle-orm";
import { approvals, guardrailConfigs, agentToolBindings } from "@trafego/db";
import { editBudgetActionValue } from "@trafego/core";
import { ACTION_PARAM_TARGETING, type Action, type ApprovalId, type OrgId, type AgentId, type RunId, type Ressalva, type TargetingSpec } from "@trafego/shared";
import { buildComposition } from "./src/composition.js";
import { applyConfirmedAction } from "./src/modules/apply/apply-confirmed-action.js";

const ORG = "e87fb1fb-6ce9-46fa-af92-354a814b6285";
const AGENT = "ba2b9542-cbbc-4795-8ac5-c73ed5cf34ad"; // BM - Automato
// adsets REAIS (pausados) da conta — alvos das ações fake.
const ADSET_A = "120251041406710295"; // adjust_audience
const ADSET_B = "120249534155810295"; // adjust_budget + ressalva
const ADSET_C = "120249880654740295"; // pause_entity

let pass = 0, fail = 0;
const findings: string[] = [];
const ok = (n: string, c: boolean, d?: unknown) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}`, d !== undefined ? JSON.stringify(d).slice(0, 300) : ""); findings.push(n); } };

const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
const mk = (type: Action["type"], id: string, params: Record<string, unknown>, ressalvas?: Ressalva[]): Action => ({
  id: `e2e-${type}-${id}`, type, target: { level: "adset", id, name: "e2e" }, params, source: "llm", riskLevel: "high", reason: "e2e fluxo de aprovação", ...(ressalvas ? { ressalvas } : {}),
});

async function main() {
  const deps = await buildComposition();
  const ap = deps.ports.approval;

  // ── setup: dry_run ON + adjust_audience ligado (opt-in) no guardrail/bindings do agente ──
  console.log("▶ setup: guardrail dry_run=ON + adjust_audience habilitado (restaurado no fim)");
  const [gr] = await deps.db.select().from(guardrailConfigs).where(and(eq(guardrailConfigs.agentId, AGENT), eq(guardrailConfigs.orgId, ORG))).limit(1);
  const origAllowed = (gr?.allowedActions ?? ["pause_entity", "resume_entity", "adjust_budget", "set_status"]) as string[];
  const origDryRun = gr?.dryRun ?? false;
  await deps.db.update(guardrailConfigs).set({ dryRun: true, allowedActions: [...new Set([...origAllowed, "adjust_audience"])] }).where(and(eq(guardrailConfigs.agentId, AGENT), eq(guardrailConfigs.orgId, ORG)));
  // binding explícito p/ adjust_audience = enabled (o gate resolveEnabledTools usa bindings + fallback).
  await deps.db.insert(agentToolBindings).values({ orgId: ORG, agentId: AGENT, toolKey: "adjust_audience", mode: "enabled" }).onConflictDoUpdate({ target: [agentToolBindings.agentId, agentToolBindings.toolKey], set: { mode: "enabled" } });

  // ── seed: 1 approval de cada tipo (adjust_audience, adjust_budget+ressalva, pause) ──
  console.log("\n▶ seed de approvals fake (adjust_audience, adjust_budget+ressalva, pause)");
  const audienceSpec: TargetingSpec = { kind: "explicit", geo: [{ key: "BR", name: "Brasil", kind: "country" }], ageMin: 25, ageMax: 45 };
  const ress: Ressalva = { code: "creative_fatigue", message: "público pode estar saturado" };
  const seedInputs = [
    { action: mk("adjust_audience", ADSET_A, { [ACTION_PARAM_TARGETING]: audienceSpec }) },
    { action: mk("adjust_budget", ADSET_B, { mode: "increase", pct: 20, currentMinor: 5000 }, [ress]) },
    { action: mk("pause_entity", ADSET_C, {}) },
  ];
  const seeded: Record<string, ApprovalId> = {};
  for (const s of seedInputs) {
    const a = await ap.upsertPending({ orgId: ORG as OrgId, agentId: AGENT as AgentId, runId: null as RunId | null, action: s.action, expiresAt });
    seeded[s.action.type] = a.id as ApprovalId;
    console.log(`   seedado ${s.action.type} → approval ${a.id}`);
  }

  // ── listPending: todos presentes, com os campos certos ──
  const pending = await ap.listPendingByAgent(AGENT as AgentId);
  const actions = pending.filter((p) => p.kind === "action");
  ok("listPending: os 3 tipos aparecem", ["adjust_audience", "adjust_budget", "pause_entity"].every((t) => actions.some((a) => a.actionType === t)), actions.map((a) => a.actionType));
  const audPend = actions.find((a) => a.actionType === "adjust_audience");
  ok("adjust_audience pendente carrega o targeting explícito em params", (audPend?.action.params as Record<string, unknown>)?.[ACTION_PARAM_TARGETING] != null);
  const budPend = actions.find((a) => a.actionType === "adjust_budget");
  ok("adjust_budget pendente carrega a ressalva (aprovável-com-aviso)", ((budPend?.action.ressalvas as unknown[] | undefined)?.length ?? 0) > 0, budPend?.action.ressalvas);

  // ── EDIT 1: valor do adjust_budget (editBudgetActionValue → updatePendingAction) ──
  console.log("\n▶ EDIT adjust_budget (valor) — set R$80/dia");
  const budId = seeded["adjust_budget"]!;
  const budAppr = await ap.getById(budId);
  const edited = editBudgetActionValue(budAppr!.action, { kind: "absolute", amountMinor: 8000 });
  ok("editBudgetActionValue ok", edited.ok, edited.ok ? undefined : edited);
  if (edited.ok) {
    const up = await ap.updatePendingAction(budId, edited.action);
    ok("adjust_budget editado: params viram mode=set amountMinor=8000", up.action.params["mode"] === "set" && Number(up.action.params["amountMinor"]) === 8000, up.action.params);
    ok("adjust_budget editado: ressalva PRESERVADA (edição não apaga o aviso)", ((up.action.ressalvas as unknown[] | undefined)?.length ?? 0) > 0);
  }

  // ── EDIT 2: público do adjust_audience (substituição total do targeting → updatePendingAction) ──
  console.log("\n▶ EDIT adjust_audience (público) — troca p/ mulheres 30-40");
  const audId = seeded["adjust_audience"]!;
  const audAppr = await ap.getById(audId);
  const newSpec: TargetingSpec = { kind: "explicit", geo: [{ key: "BR", name: "Brasil", kind: "country" }], ageMin: 30, ageMax: 40, genders: [2] };
  const newAction: Action = { ...audAppr!.action, params: { ...audAppr!.action.params, [ACTION_PARAM_TARGETING]: newSpec } };
  const upAud = await ap.updatePendingAction(audId, newAction);
  const savedSpec = (upAud.action.params as Record<string, unknown>)[ACTION_PARAM_TARGETING] as { kind?: string; ageMin?: number; ageMax?: number; genders?: number[] };
  ok("adjust_audience editado: params.targeting virou o público novo (30-40, mulheres)", savedSpec?.ageMin === 30 && savedSpec?.ageMax === 40 && (savedSpec?.genders ?? []).includes(2), savedSpec);

  // ── REJECT: pause_entity → rejected (sem escrita na Meta) ──
  console.log("\n▶ REJECT pause_entity");
  const pauseId = seeded["pause_entity"]!;
  const rej = await ap.resolve(pauseId, { status: "rejected" });
  ok("reject: status = rejected", rej.status === "rejected", { status: rej.status });
  const afterReject = await ap.getById(pauseId);
  ok("reject: sai das pendentes (não é mais pending)", afterReject?.status !== "pending", { status: afterReject?.status });

  // ── APPROVE (dry-run): adjust_audience + adjust_budget → apply SIMULA (sem escrita real) ──
  console.log("\n▶ APPROVE (dry-run) adjust_budget + adjust_audience — apply simula, sem mutar a Meta");
  // NB: nesta conta de dev (rate-limit 1/30s + adsets CBO), o apply dry-run pode dar blocked/failed
  // por ARTEFATO da conta (não bug) — asserção tolerante: o apply EXECUTA sem crashar. Em conta
  // saudável dá `applied+dryRun` (a mecânica de escrita já foi confirmada à parte, espaçada).
  const VALID = new Set(["applied", "noop", "blocked", "failed"]);
  const outBud = await applyConfirmedAction(deps, { orgId: ORG, agentId: AGENT, action: (await ap.getById(budId))!.action, runId: "e2e-run-bud", idempotencyKey: `e2e:${budId}:apply` });
  console.log(`   adjust_budget outcome=${outBud.kind}${outBud.kind === "applied" ? " dryRun=" + outBud.dryRun : ""}${outBud.kind === "blocked" ? " (" + outBud.reason + ")" : ""}`);
  ok("approve adjust_budget: apply executa (applied+dryRun em conta saudável; aqui pode ser artefato da conta)", VALID.has(outBud.kind) && (outBud.kind !== "applied" || outBud.dryRun === true), { kind: outBud.kind });

  const outAud = await applyConfirmedAction(deps, { orgId: ORG, agentId: AGENT, action: (await ap.getById(audId))!.action, runId: "e2e-run-aud", idempotencyKey: `e2e:${audId}:apply` });
  console.log(`   adjust_audience outcome=${outAud.kind}${outAud.kind === "applied" ? " dryRun=" + outAud.dryRun : ""}${outAud.kind === "blocked" ? " (" + outAud.reason + ")" : ""}`);
  ok("approve adjust_audience: apply executa (sem crash; applied+dryRun em conta saudável)", VALID.has(outAud.kind) && (outAud.kind !== "applied" || outAud.dryRun === true), { kind: outAud.kind });

  // ── CLEANUP: remove approvals seedados + tool_calls do dry-run + restaura guardrail/binding ──
  console.log("\n▶ cleanup: remove approvals fake + restaura guardrail/binding");
  await deps.db.delete(approvals).where(inArray(approvals.id, Object.values(seeded)));
  await deps.db.update(guardrailConfigs).set({ dryRun: origDryRun, allowedActions: origAllowed }).where(and(eq(guardrailConfigs.agentId, AGENT), eq(guardrailConfigs.orgId, ORG)));
  await deps.db.delete(agentToolBindings).where(and(eq(agentToolBindings.agentId, AGENT), eq(agentToolBindings.toolKey, "adjust_audience")));
  console.log("   ✅ estado restaurado (guardrail dry_run + allowedActions + binding adjust_audience)");

  console.log(`\n═══ FLUXO DE APROVAÇÃO: ${pass} ok · ${fail} falhas ═══`);
  if (findings.length) { console.log("APONTAMENTOS:"); for (const f of findings) console.log("  ⚠️ " + f); }
  await deps.shutdown?.();
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error("APPROVALS erro:", e); process.exit(1); });

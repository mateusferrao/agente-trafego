// Store da conta (scoped à rota `accounts/:id` — provido no AccountShell). Dono do
// estado compartilhado entre o cabeçalho (shell) e a aba "Visão geral": conta +
// último run + recomendações + campanhas + pausa. Sinais + métodos; sem template.
// Portado do antigo account-detail-page (que virou shell + abas na Fatia 6a).

import { DestroyRef, Injectable, computed, inject, signal } from "@angular/core";
import { ActivatedRoute } from "@angular/router";
import { toast } from "ngx-sonner";
import { AccountsApiService } from "@core/api/accounts-api.service";
import { AnalysisApiService } from "@core/api/analysis-api.service";
import { DraftsApiService } from "@core/api/drafts-api.service";
import type { AdAccountOutput, CampaignAnalysesOutput, LatestRunOutput } from "@core/api/generated";

type Recommendation = LatestRunOutput["recommendations"][number];
type Campaign = CampaignAnalysesOutput["campaigns"][number];

/** Enquanto o run está nestes estados, seguimos consultando (polling). */
const IN_FLIGHT = new Set(["pending", "running", "waiting_approval"]);
const POLL_INTERVAL_MS = 2500;

@Injectable()
export class AccountContextStore {
  private readonly route = inject(ActivatedRoute);
  private readonly accountsApi = inject(AccountsApiService);
  private readonly analysisApi = inject(AnalysisApiService);
  private readonly draftsApi = inject(DraftsApiService);

  readonly accountId = this.route.snapshot.paramMap.get("id") ?? "";
  private destroyed = false;

  readonly account = signal<AdAccountOutput | null>(null);
  readonly run = signal<LatestRunOutput["run"]>(null);
  readonly recommendations = signal<Recommendation[]>([]);
  readonly campaigns = signal<Campaign[]>([]);
  readonly loading = signal(true);
  readonly analyzing = signal(false);
  readonly paused = signal(false);
  readonly pausing = signal(false);
  readonly votingId = signal<string | null>(null);
  readonly mutingId = signal<string | null>(null);
  /** id da campanha em processo de escala (CTA "escalar este vencedor"). */
  readonly scalingId = signal<string | null>(null);
  /** passo agressivo → o backend PERGUNTA: subir seguro (raisePct) vs duplicar (duplicatePct).
   *  Quando setado, a UI mostra a escolha; a resposta re-chama scaleWinner com `choice`. */
  readonly scaleAsk = signal<{ campaign: Campaign; raisePct: number; duplicatePct: number } | null>(null);
  /** view enxuta do ASK p/ o analysis-detail (IO-free — só o id + as % das 2 saídas). */
  readonly scaleAskView = computed(() => {
    const a = this.scaleAsk();
    return a ? { externalId: a.campaign.externalId, raisePct: a.raisePct, duplicatePct: a.duplicatePct } : null;
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
    });
    this.loadAll();
  }

  accountName(): string {
    return this.account()?.name ?? this.account()?.adAccountId ?? "Conta";
  }
  accountSubtitle(): string {
    const acc = this.account();
    if (!acc) return "Análise da conta";
    return `Conta ${acc.adAccountId}${acc.currency ? ` · ${acc.currency}` : ""}`;
  }

  analyze(): void {
    this.analyzing.set(true);
    this.analysisApi.triggerRun(this.accountId).subscribe({
      next: () => this.poll(),
      error: () => this.analyzing.set(false),
    });
  }

  togglePaused(): void {
    const next = !this.paused();
    this.pausing.set(true);
    this.analysisApi.setPaused(this.accountId, next).subscribe({
      next: (agent) => {
        this.paused.set(agent.paused);
        this.pausing.set(false);
        toast.success(agent.paused ? "Análises pausadas" : "Análises retomadas");
      },
      error: () => this.pausing.set(false),
    });
  }

  vote(event: { id: string; vote: "up" | "down" }): void {
    const rec = this.recommendations().find((r) => r.id === event.id);
    if (rec?.vote === event.vote) return;
    this.votingId.set(event.id);
    this.analysisApi.sendFeedback(event.id, event.vote).subscribe({
      next: () => {
        this.recommendations.update((list) =>
          list.map((r) => (r.id === event.id ? { ...r, vote: event.vote } : r)),
        );
        this.votingId.set(null);
      },
      error: () => this.votingId.set(null),
    });
  }

  toggleMuted(c: Campaign): void {
    this.mutingId.set(c.externalId);
    const req = c.muted
      ? this.analysisApi.unmuteCampaign(this.accountId, c.externalId)
      : this.analysisApi.muteCampaign(this.accountId, c.externalId);
    req.subscribe({
      next: (out) => {
        const mutedSet = new Set(out.campaignIds);
        this.campaigns.update((list) => list.map((x) => ({ ...x, muted: mutedSet.has(x.externalId) })));
        this.mutingId.set(null);
        toast.success(c.muted ? "Campanha reativada" : "Campanha silenciada");
      },
      error: () => this.mutingId.set(null),
    });
  }

  /** CTA "escalar este vencedor". Passo pequeno vira aprovação direta; passo agressivo com
   *  intent aberto → o backend devolve `ask` e a UI mostra as 2 saídas (subir vs duplicar). */
  scaleWinner(c: Campaign): void {
    this.scalingId.set(c.externalId);
    this.draftsApi.scaleWinner(this.accountId, { entityLevel: "campaign", entityId: c.externalId }).subscribe({
      next: (out) => {
        this.scalingId.set(null);
        if (out.move === "ask") {
          this.scaleAsk.set({ campaign: c, raisePct: out.raisePct, duplicatePct: out.duplicatePct });
          return;
        }
        this.notifyScaleProposed(out.move);
      },
      error: () => {
        this.scalingId.set(null);
        toast.error("Não consegui propor a escala agora. Tente de novo em instantes.");
      },
    });
  }

  /** Resposta do usuário ao ASK do passo agressivo (subir seguro vs duplicar). */
  scaleChoose(choice: "raise" | "duplicate"): void {
    const ask = this.scaleAsk();
    if (!ask) return;
    const c = ask.campaign;
    this.scaleAsk.set(null);
    this.scalingId.set(c.externalId);
    this.draftsApi
      .scaleWinner(this.accountId, { entityLevel: "campaign", entityId: c.externalId, choice })
      .subscribe({
        next: (out) => {
          this.scalingId.set(null);
          if (out.move !== "ask") this.notifyScaleProposed(out.move);
        },
        error: () => {
          this.scalingId.set(null);
          toast.error("Não consegui propor a escala agora. Tente de novo em instantes.");
        },
      });
  }

  scaleCancel(): void {
    this.scaleAsk.set(null);
  }

  private notifyScaleProposed(move: "raise_budget" | "duplicate"): void {
    toast.success(
      move === "raise_budget"
        ? "Proposta de escala criada: subir o orçamento. Aprove em Sugeridas."
        : "Proposta de escala criada: duplicar o vencedor. Aprove em Sugeridas.",
    );
  }

  private loadAll(): void {
    this.accountsApi.list().subscribe({
      next: (rows) => this.account.set(rows.find((r) => r.id === this.accountId) ?? null),
      error: () => this.account.set(null),
    });
    this.analysisApi.getAgent(this.accountId, { silent: true }).subscribe({
      next: (agent) => this.paused.set(agent.paused),
      error: () => {},
    });
    this.analysisApi.latestRun(this.accountId).subscribe({
      next: (latest) => {
        this.applyLatest(latest);
        this.loading.set(false);
        if (latest.run && IN_FLIGHT.has(latest.run.status)) {
          this.analyzing.set(true);
          this.poll();
        } else if (latest.run) {
          this.loadCampaigns();
        }
      },
      error: () => this.loading.set(false),
    });
  }

  private loadCampaigns(): void {
    this.analysisApi.campaignAnalyses(this.accountId).subscribe({
      next: (out) => this.campaigns.set(out.campaigns),
      error: () => this.campaigns.set([]),
    });
  }

  private poll(): void {
    if (this.destroyed) return;
    this.analysisApi.latestRun(this.accountId).subscribe({
      next: (latest) => {
        this.applyLatest(latest);
        if (latest.run && IN_FLIGHT.has(latest.run.status)) {
          setTimeout(() => this.poll(), POLL_INTERVAL_MS);
        } else {
          this.analyzing.set(false);
          if (latest.run) this.loadCampaigns();
        }
      },
      error: () => this.analyzing.set(false),
    });
  }

  private applyLatest(latest: LatestRunOutput): void {
    this.run.set(latest.run);
    this.recommendations.set(latest.recommendations);
  }
}

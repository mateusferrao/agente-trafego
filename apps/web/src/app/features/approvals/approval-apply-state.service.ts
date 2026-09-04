import { Injectable, computed, inject, signal } from '@angular/core';
import { ApprovalsApiService } from '@core/api/approvals-api.service';
import type { ApprovalOutcomeOutput } from '@core/api/generated';

/** Polling do desfecho após aprovar (Fatia unificação): o card vira "Aplicando…" e relê o resultado. */
const APPLY_POLL_MS = 1500;
const APPLY_POLL_TIMEOUT_MS = 30_000;

/** Estado local por aprovação: aplicando, timeout ou o desfecho já lido. */
export type ApplyState = 'applying' | 'timeout' | ApprovalOutcomeOutput;

/**
 * Aprovar + acompanhar o desfecho — peça COMPARTILHADA pelas 3 superfícies de aprovação
 * (card de ação, rascunho/ativação, mini-surface). Dono do estado "Aplicando… → desfecho real";
 * cada superfície mantém só o layout dela. Fonte única do comportamento (§13 reuso-primeiro).
 */
@Injectable({ providedIn: 'root' })
export class ApprovalApplyStateService {
  private readonly api = inject(ApprovalsApiService);
  private readonly state = signal<ReadonlyMap<string, ApplyState>>(new Map());

  /** Aprova (enfileira) e passa a acompanhar: "Aplicando…" → desfecho. `onError` limpa o estado da
   *  superfície (ex: reabilitar o card) se o enfileiramento falhar. */
  approve(id: string, onError?: () => void): void {
    this.set(id, 'applying');
    this.api.resolve(id, 'approve').subscribe({
      next: () => this.poll(id, Date.now()),
      error: () => {
        this.clear(id);
        onError?.();
      },
    });
  }

  /** Estado bruto (p/ a superfície decidir botões). */
  stateOf(id: string): ApplyState | undefined {
    return this.state().get(id);
  }

  /** Texto a mostrar: "Aplicando…", timeout honesto ou a frase do desfecho (voz do Roy). Null = nada. */
  label(id: string): string | null {
    const s = this.state().get(id);
    if (s === undefined) return null;
    if (s === 'applying') return 'Aplicando…';
    if (s === 'timeout') return 'Ainda aplicando — te aviso no WhatsApp.';
    // fallback determinístico: nunca deixa o card sem botões E sem texto.
    return s.outcomeMessage ?? 'Pronto.';
  }

  /** Resolvido COM efeito (não-falha) → a superfície esconde os botões (ação decidida). */
  isResolvedNonFailed(id: string): boolean {
    const s = this.state().get(id);
    return typeof s === 'object' && s.applyOutcome !== 'failed';
  }

  /** true enquanto "Aplicando…" (a superfície desabilita os botões). */
  readonly anyApplying = computed(() => [...this.state().values()].some((s) => s === 'applying'));

  clear(id: string): void {
    const next = new Map(this.state());
    next.delete(id);
    this.state.set(next);
  }

  private set(id: string, s: ApplyState): void {
    const next = new Map(this.state());
    next.set(id, s);
    this.state.set(next);
  }

  private poll(id: string, startedAt: number): void {
    if (Date.now() - startedAt > APPLY_POLL_TIMEOUT_MS) {
      this.set(id, 'timeout');
      return;
    }
    this.api.getOne(id).subscribe({
      next: (o) => {
        if (o.applyOutcome !== null) this.set(id, o);
        else setTimeout(() => this.poll(id, startedAt), APPLY_POLL_MS);
      },
      error: () => setTimeout(() => this.poll(id, startedAt), APPLY_POLL_MS),
    });
  }
}

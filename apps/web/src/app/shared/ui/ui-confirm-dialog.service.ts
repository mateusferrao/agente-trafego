import { Injectable, signal } from '@angular/core';

export type ConfirmDialogTone = 'danger' | 'warning' | 'info';

export type ConfirmDialogOptions = {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: ConfirmDialogTone;
};

type ConfirmDialogRequest = Required<
  Pick<ConfirmDialogOptions, 'title' | 'confirmLabel' | 'cancelLabel' | 'tone'>
> &
  Pick<ConfirmDialogOptions, 'description'> & {
    id: string;
    resolve: (confirmed: boolean) => void;
  };

@Injectable({ providedIn: 'root' })
export class UiConfirmDialogService {
  private readonly activeRequest = signal<ConfirmDialogRequest | null>(null);
  private readonly queue: ConfirmDialogRequest[] = [];
  private nextId = 0;

  readonly request = this.activeRequest.asReadonly();

  confirm(options: ConfirmDialogOptions) {
    return new Promise<boolean>((resolve) => {
      const request: ConfirmDialogRequest = {
        id: `confirm-${++this.nextId}`,
        title: options.title,
        description: options.description,
        confirmLabel: options.confirmLabel ?? 'Confirmar',
        cancelLabel: options.cancelLabel ?? 'Cancelar',
        tone: options.tone ?? 'danger',
        resolve,
      };

      if (this.activeRequest()) {
        this.queue.push(request);
        return;
      }

      this.activeRequest.set(request);
    });
  }

  confirmActive() {
    this.resolveActive(true);
  }

  cancelActive() {
    this.resolveActive(false);
  }

  private resolveActive(confirmed: boolean) {
    const request = this.activeRequest();
    if (!request) return;

    this.activeRequest.set(null);
    request.resolve(confirmed);
    this.activeRequest.set(this.queue.shift() ?? null);
  }
}

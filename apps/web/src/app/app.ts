import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { NgxSonnerToaster } from 'ngx-sonner';
import { ThemeStore } from '@core/theme/theme.store';

// Componente raiz. Fino de propósito: monta o router-outlet + o outlet de toasts
// (ngx-sonner), que segue o tema efetivo do app. O layout autenticado vive em
// layouts/app-shell; as telas públicas em layouts/auth-layout.
@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, NgxSonnerToaster],
  template: `
    <router-outlet />
    <ngx-sonner-toaster [theme]="theme.effective()" position="bottom-right" richColors />
  `,
})
export class App {
  protected readonly theme = inject(ThemeStore);
}

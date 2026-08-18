import { ChangeDetectionStrategy, Component, signal } from '@angular/core';

// Onboarding = walkthrough guiado full-screen (fora do app shell). CLAUDE.md §9.
// Passos: (1) colar System User token → validar → listar ad accounts; (2) escolher
// contas; (3) conectar WhatsApp (Evolution) via QR; (4) semear agente por arquétipo.
// Objetivo: zero-config → conectou = funciona (CLAUDE.md §8, §10). Concierge fallback.
//
// TODO(vendoring): usar <ui-step-nav>/<ui-step-pill> e <ui-otp>/<ui-input> de shared/ui.
type OnboardingStep = 'token' | 'accounts' | 'whatsapp' | 'archetype';

interface StepDef {
  readonly id: OnboardingStep;
  readonly label: string;
  readonly hint: string;
}

@Component({
  selector: 'app-onboarding-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="mx-auto flex min-h-screen max-w-2xl flex-col gap-8 px-6 py-16">
      <header class="flex flex-col gap-2">
        <h1 class="font-brand text-3xl font-bold text-ink">Vamos conectar sua operação</h1>
        <p class="max-w-prose text-sm leading-relaxed text-muted">
          Em poucos passos o agente já começa a vigiar suas campanhas. Você cola o token,
          escolhe as contas, conecta o WhatsApp e escolhe um arquétipo — o resto já vem pronto.
        </p>
      </header>

      <ol class="flex flex-col gap-3">
        @for (step of steps; track step.id; let i = $index) {
          <li
            class="flex items-start gap-3 rounded-lg border border-line bg-panel p-4"
            [class.opacity-60]="step.id !== current()"
          >
            <span
              class="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs text-accent-strong"
            >
              {{ i + 1 }}
            </span>
            <div class="flex flex-col gap-0.5">
              <span class="text-sm font-semibold text-ink">{{ step.label }}</span>
              <span class="text-sm text-muted">{{ step.hint }}</span>
            </div>
          </li>
        }
      </ol>

      <!-- Placeholder: cada passo renderiza seu próprio formulário. Nenhuma credencial
           é logada; o token vai cifrado (AES-256-GCM) no backend — CLAUDE.md §12. -->
      <p class="text-xs uppercase tracking-wide text-muted">Stub de onboarding — sem lógica ainda</p>
    </section>
  `,
})
export class OnboardingPage {
  protected readonly steps: readonly StepDef[] = [
    { id: 'token', label: 'Colar System User token', hint: 'Sem OAuth. Validamos e listamos suas contas Meta.' },
    { id: 'accounts', label: 'Escolher contas de anúncio', hint: 'GET /me/adaccounts → você seleciona quais conectar.' },
    { id: 'whatsapp', label: 'Conectar WhatsApp', hint: 'Uma instância Evolution por org, via QR code.' },
    { id: 'archetype', label: 'Escolher arquétipo', hint: 'Conservador ou Otimizador — semeia a config do agente.' },
  ];

  protected readonly current = signal<OnboardingStep>('token');
}

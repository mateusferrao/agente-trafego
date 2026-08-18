import { ChangeDetectionStrategy, Component } from '@angular/core';

// Agentes = SUPERFÍCIE ÚNICA de configuração (CLAUDE.md §10). NÃO é wizard paralelo:
// o arquétipo (Conservador | Otimizador) semeia bons defaults e o usuário edita inline,
// em linguagem de gente. "Opções avançadas" = divulgação progressiva na MESMA página,
// mesmo schema. Zero-config precisa funcionar (CLAUDE.md §8).
//
// Seções (âncoras da superfície única):
//  - Objetivo   → persona/goals do agente + cadência (o que ele persegue e quando roda)
//  - Autonomia  → slider por origem (só avisa → sugere+OK → age no seguro → age sozinho),
//                 playbook × LLM separados (CLAUDE.md §8)
//  - Segurança  → guardrails: blast radius (% budget, nº entidades/dia), budget cap,
//                 dry-run, kill-switch, cap de custo LLM (rede sobre tudo)
//  - Regras     → playbook em linguagem natural com lacunas
//                 ("pausar ad que custa mais de R$ __ por venda") → PlaybookRule
//  - Avançado   → condições compostas, model_config, tool bindings (progressive disclosure)
//
// TODO(vendoring): <ui-section-header>, <ui-form-field>, <ui-range> (slider de autonomia),
// <ui-switch> (dry-run/kill-switch), <ui-toggle-group> (arquétipo), <ui-select-field>.
interface AgentSection {
  readonly id: 'objetivo' | 'autonomia' | 'seguranca' | 'regras' | 'avancado';
  readonly title: string;
  readonly summary: string;
  /** Avançado fica colapsado por padrão (divulgação progressiva). */
  readonly advanced?: boolean;
}

@Component({
  selector: 'app-agents-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex max-w-3xl flex-col gap-8">
      <header class="flex items-start justify-between gap-4">
        <div class="flex flex-col gap-1">
          <h1 class="font-brand text-2xl font-semibold text-ink">Configuração do agente</h1>
          <p class="text-sm text-muted">
            Uma única superfície, semeada pelo arquétipo. Edite só o que quiser — o resto já vem pronto.
          </p>
        </div>
        <!-- Seletor de arquétipo: semeia os defaults de todas as seções abaixo. -->
        <div class="flex items-center gap-1 rounded-md border border-line bg-panel p-1 text-sm">
          <button class="rounded-sm bg-accent-soft px-3 py-1 font-medium text-accent-strong">Conservador</button>
          <button class="rounded-sm px-3 py-1 font-medium text-muted hover:text-ink">Otimizador</button>
        </div>
      </header>

      @for (section of sections; track section.id) {
        <section class="flex flex-col gap-2 rounded-lg border border-line bg-panel p-6">
          <div class="flex items-center gap-2">
            <h2 class="text-base font-semibold text-ink">{{ section.title }}</h2>
            @if (section.advanced) {
              <span class="rounded-sm bg-soft px-2 py-0.5 text-xs uppercase tracking-wide text-muted">
                avançado
              </span>
            }
          </div>
          <p class="text-sm text-muted">{{ section.summary }}</p>
          <!-- Stub: campos reais entram aqui, todos ligados ao mesmo schema do agente. -->
        </section>
      }
    </div>
  `,
})
export class AgentsPage {
  protected readonly sections: readonly AgentSection[] = [
    {
      id: 'objetivo',
      title: 'Objetivo',
      summary: 'O que o agente persegue (persona, metas) e com que cadência ele analisa a conta.',
    },
    {
      id: 'autonomia',
      title: 'Autonomia',
      summary:
        'Do "só avisa" ao "age sozinho no seguro" — definido por origem (regras determinísticas × LLM).',
    },
    {
      id: 'seguranca',
      title: 'Segurança',
      summary:
        'Guardrails que valem sempre: teto de mudança de budget, máximo de entidades/dia, dry-run, kill-switch e cap de custo de LLM.',
    },
    {
      id: 'regras',
      title: 'Regras',
      summary:
        'Playbook em linguagem natural com lacunas — ex.: "pausar ad que custa mais de R$ __ por venda".',
    },
    {
      id: 'avancado',
      title: 'Opções avançadas',
      summary: 'Condições compostas, configuração do modelo e ferramentas habilitadas. Colapsado por padrão.',
      advanced: true,
    },
  ];
}

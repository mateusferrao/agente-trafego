import { DOCUMENT } from '@angular/common';
import { computed, inject, Injectable, signal } from '@angular/core';

export type ThemePreference = 'light' | 'dark' | 'system';
export type EffectiveTheme = 'light' | 'dark';

const STORAGE_KEY = 'trafego.theme';
const THEME_VALUES: readonly ThemePreference[] = ['light', 'dark', 'system'];

/**
 * Preferência de tema (claro/escuro/sistema) persistida em localStorage e aplicada
 * como `data-theme` no `<html>`. O CSS (styles.css) define light no `:root` base e
 * dark em `:root[data-theme='dark']` — então o efetivo "dark" seta o atributo e o
 * efetivo "light" o remove. Ambos os temas são suportados (DESIGN.md §2).
 */
@Injectable({ providedIn: 'root' })
export class ThemeStore {
  private readonly document = inject(DOCUMENT);
  private readonly preferenceSignal = signal<ThemePreference>(this.readStoredPreference());
  private readonly systemPrefersDark = signal(this.matchSystemDark());

  readonly preference = this.preferenceSignal.asReadonly();
  readonly effective = computed<EffectiveTheme>(() => {
    const preference = this.preferenceSignal();
    if (preference === 'system') {
      return this.systemPrefersDark() ? 'dark' : 'light';
    }
    return preference;
  });

  constructor() {
    this.watchSystemPreference();
    this.apply();
  }

  set(preference: ThemePreference): void {
    this.preferenceSignal.set(preference);
    this.persist(preference);
    this.apply();
  }

  /** Aplica o tema efetivo ao DOM. Idempotente — seguro de chamar no boot. */
  apply(): void {
    const root = this.document.documentElement;
    if (this.effective() === 'dark') {
      root.setAttribute('data-theme', 'dark');
    } else {
      root.removeAttribute('data-theme');
    }
  }

  private watchSystemPreference(): void {
    const media = this.systemMedia();
    media?.addEventListener('change', (event) => {
      this.systemPrefersDark.set(event.matches);
      this.apply();
    });
  }

  private readStoredPreference(): ThemePreference {
    try {
      const stored = this.document.defaultView?.localStorage.getItem(STORAGE_KEY);
      return THEME_VALUES.includes(stored as ThemePreference) ? (stored as ThemePreference) : 'system';
    } catch {
      return 'system';
    }
  }

  private persist(preference: ThemePreference): void {
    try {
      this.document.defaultView?.localStorage.setItem(STORAGE_KEY, preference);
    } catch {
      // localStorage indisponível (modo privado etc.) — o tema ainda vale na sessão.
    }
  }

  private matchSystemDark(): boolean {
    return this.systemMedia()?.matches ?? false;
  }

  private systemMedia(): MediaQueryList | null {
    return this.document.defaultView?.matchMedia('(prefers-color-scheme: dark)') ?? null;
  }
}

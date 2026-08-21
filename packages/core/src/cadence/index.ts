import type { CadenceSpec } from "@trafego/shared";

// Deriva o cron 5-campos (minuto hora dia-do-mês mês dia-da-semana) a partir do
// `CadenceSpec` (fonte única). PURA — o `tz` é aplicado pelo scheduler, não aqui.
// Presets fixam minuto=0 (hora-granular) → cron sempre expressável; `raw` = escape.
export function cadenceToCron(spec: CadenceSpec): string {
  switch (spec.kind) {
    case "daily":
      return `0 ${spec.hour} * * *`;
    case "twice_daily": {
      // ordena + dedupe: horas iguais colapsam (equivale a diária); nunca produz
      // uma lista fora de ordem ou repetida no campo hora.
      const hours = [...new Set(spec.hours)].sort((a, b) => a - b);
      return `0 ${hours.join(",")} * * *`;
    }
    case "weekly":
      return `0 ${spec.hour} * * ${spec.weekday}`;
    case "raw":
      return spec.cron;
  }
}

/** Dia da semana (cron dow: 0=domingo … 6=sábado) em PT. */
const WEEKDAY_PT = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"] as const;

/**
 * Resumo LEGÍVEL em PT do `CadenceSpec` (p/ o eco do chat + UI). PURA. `null` = usa o
 * padrão global do sistema. Presets viram frase de gente; `raw` mostra o cron cru.
 */
export function describeCadence(spec: CadenceSpec | null | undefined): string {
  if (!spec) return "padrão do sistema";
  switch (spec.kind) {
    case "daily":
      return `diária às ${spec.hour}h`;
    case "twice_daily": {
      const [a, b] = spec.hours;
      return `2×/dia (${a}h e ${b}h)`;
    }
    case "weekly":
      return `semanal (${WEEKDAY_PT[spec.weekday] ?? "?"} às ${spec.hour}h)`;
    case "raw":
      return `agenda personalizada (${spec.cron})`;
  }
}

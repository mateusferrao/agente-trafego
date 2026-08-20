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

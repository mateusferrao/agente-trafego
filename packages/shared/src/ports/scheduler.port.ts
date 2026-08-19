export interface ScheduleSpec {
  /** id idempotente do scheduler (ex: `analysis:${adAccountId}`). */
  readonly key: string;
  /** fila onde o job recorrente é enfileirado ao disparar. */
  readonly queue: string;
  /** cron ou intervalo em ms. */
  readonly cron?: string;
  readonly everyMs?: number;
  /** timezone p/ avaliar o cron (ex: `America/Sao_Paulo`); default = UTC. */
  readonly tz?: string;
  readonly payload: Readonly<Record<string, unknown>>;
  /** jitter máximo (ms) p/ espalhar (stagger estável por conta) a carga entre contas. */
  readonly jitterMs?: number;
}

export interface JobSpec {
  readonly queue: string;
  readonly name: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly idempotencyKey?: string;
}

/**
 * Borda de agendamento/fila. Adapter MVP = BullMQ/Redis.
 * upsertSchedule é idempotente (job scheduler recorrente por tenant/conta).
 */
export interface SchedulerPort {
  upsertSchedule(spec: ScheduleSpec): Promise<void>;
  removeSchedule(key: string): Promise<void>;
  enqueue(job: JobSpec): Promise<void>;
}

import { Queue, type ConnectionOptions } from "bullmq";
import type { JobSpec, ScheduleSpec, SchedulerPort } from "@trafego/shared/ports";

/**
 * Adapter BullMQ do SchedulerPort. Fatia 0 usa só `enqueue` (produtor). Os
 * schedulers recorrentes (cron/jitter) entram na fatia 3b. Reusa uma Queue por
 * nome (cacheada).
 */
export class BullmqScheduler implements SchedulerPort {
  private readonly connection: ConnectionOptions;
  private readonly queues = new Map<string, Queue>();

  constructor(connection: ConnectionOptions) {
    this.connection = connection;
  }

  private queue(name: string): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: this.connection });
      this.queues.set(name, q);
    }
    return q;
  }

  async enqueue(job: JobSpec): Promise<void> {
    const opts: Parameters<Queue["add"]>[2] = {};
    if (job.idempotencyKey) opts.jobId = job.idempotencyKey;
    if (job.removeOnComplete !== undefined) opts.removeOnComplete = job.removeOnComplete;
    if (job.removeOnFail !== undefined) opts.removeOnFail = job.removeOnFail;
    if (job.delayMs !== undefined) opts.delay = job.delayMs;
    if (job.attempts !== undefined) opts.attempts = job.attempts;
    if (job.backoffMs !== undefined) opts.backoff = { type: "exponential", delay: job.backoffMs };
    // sem opções → passa undefined (mantém o contrato: não força objeto vazio).
    await this.queue(job.queue).add(job.name, job.payload, Object.keys(opts).length ? opts : undefined);
  }

  /**
   * Cria/atualiza um Job Scheduler recorrente (idempotente por `key`). O jitter
   * vira um `offset` ESTÁVEL derivado da key (stagger por conta, não aleatório a
   * cada fire) — espalha a carga entre contas sem re-embaralhar no re-upsert.
   */
  async upsertSchedule(spec: ScheduleSpec): Promise<void> {
    const offset = spec.jitterMs ? stableOffset(spec.key, spec.jitterMs) : undefined;
    const repeat = spec.cron
      ? { pattern: spec.cron, ...(spec.tz ? { tz: spec.tz } : {}), ...(offset ? { offset } : {}) }
      : { every: spec.everyMs ?? 0, ...(offset ? { offset } : {}) };
    await this.queue(spec.queue).upsertJobScheduler(spec.key, repeat, {
      name: spec.key,
      data: spec.payload,
    });
  }

  /** Remove o scheduler recorrente (best-effort em todas as filas conhecidas). */
  async removeSchedule(key: string): Promise<void> {
    await Promise.all(
      [...this.queues.values()].map((q) => q.removeJobScheduler(key).catch(() => false)),
    );
  }

  /** Fecha as queues (shutdown gracioso). */
  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
  }
}

/** Offset determinístico em [0, max) a partir da key (stagger estável por conta). */
export function stableOffset(key: string, max: number): number {
  if (max <= 0) return 0;
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % max;
}

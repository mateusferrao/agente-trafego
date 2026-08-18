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
    await this.queue(job.queue).add(
      job.name,
      job.payload,
      job.idempotencyKey ? { jobId: job.idempotencyKey } : undefined,
    );
  }

  async upsertSchedule(_spec: ScheduleSpec): Promise<void> {
    throw new Error("BullmqScheduler.upsertSchedule: cron recorrente = fatia 3b");
  }

  async removeSchedule(_key: string): Promise<void> {
    throw new Error("BullmqScheduler.removeSchedule: fatia 3b");
  }

  /** Fecha as queues (shutdown gracioso). */
  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
  }
}

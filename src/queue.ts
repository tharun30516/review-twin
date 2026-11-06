import { randomUUID } from "node:crypto";

export type JobStatus = "queued" | "running" | "done" | "failed";
export interface Job<T> { id: string; status: JobStatus; result?: T; error?: string; createdAt: number }

/**
 * In-process job queue with a concurrency cap. Reviews take seconds (GitHub + LLM),
 * so the API accepts the job, returns 202 + an id, and the client polls.
 * Same interface works over Redis (BullMQ) to share work across many API pods.
 */
export class JobQueue<In, Out> {
  private jobs = new Map<string, Job<Out>>();
  private pending: { id: string; input: In }[] = [];
  private running = 0;

  constructor(private worker: (input: In) => Promise<Out>, private concurrency = 4, private ttlMs = 60 * 60_000) {}

  submit(input: In): Job<Out> {
    this.gc();
    const job: Job<Out> = { id: randomUUID(), status: "queued", createdAt: Date.now() };
    this.jobs.set(job.id, job);
    this.pending.push({ id: job.id, input });
    this.pump();
    return job;
  }

  get(id: string): Job<Out> | undefined {
    return this.jobs.get(id);
  }

  stats() {
    return { queued: this.pending.length, running: this.running, stored: this.jobs.size };
  }

  private pump() {
    while (this.running < this.concurrency && this.pending.length) {
      const { id, input } = this.pending.shift()!;
      const job = this.jobs.get(id)!;
      job.status = "running";
      this.running++;
      this.worker(input)
        .then((r) => Object.assign(job, { status: "done", result: r }))
        .catch((e: Error) => Object.assign(job, { status: "failed", error: e.message }))
        .finally(() => {
          this.running--;
          this.pump();
        });
    }
  }

  private gc() {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, j] of this.jobs) if (j.createdAt < cutoff && (j.status === "done" || j.status === "failed")) this.jobs.delete(id);
  }
}

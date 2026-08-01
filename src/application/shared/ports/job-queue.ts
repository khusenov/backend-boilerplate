export interface JobOptions {
  readonly attempts?: number;
  readonly delayMs?: number;
  /**
   * Stable key identifying the unit of work being enqueued. Enqueuing the same job name with
   * the same key twice delivers the job once, within whatever deduplication horizon the adapter
   * documents. Producers that can only offer at-least-once semantics — such as the transactional
   * outbox relay — must supply one so that a replayed batch is a no-op.
   *
   * The key is scoped to the job name, not global, and adapters may impose their own character
   * restrictions on it. Pass an opaque identifier rather than structured text. A repeat enqueue
   * within the horizon must resolve successfully — suppressing a duplicate is not an error
   * condition, and callers are entitled to read a rejection as "not enqueued".
   */
  readonly deduplicationKey?: string;
}

export interface JobQueue {
  enqueue<TPayload>(jobName: string, payload: TPayload, options?: JobOptions): Promise<void>;
}

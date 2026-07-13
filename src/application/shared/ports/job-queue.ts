export interface JobOptions {
  readonly attempts?: number;
  readonly delayMs?: number;
}

export interface JobQueue {
  enqueue<TPayload>(jobName: string, payload: TPayload, options?: JobOptions): Promise<void>;
}

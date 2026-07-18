export interface ScheduleOptions {
  readonly everyMs: number;
}

export interface JobScheduler {
  schedule<TPayload>(jobName: string, payload: TPayload, options: ScheduleOptions): Promise<void>;
}

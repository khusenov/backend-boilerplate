export interface JobHandler<TPayload = unknown> {
  readonly jobName: string;

  handle(payload: TPayload): Promise<void>;
}

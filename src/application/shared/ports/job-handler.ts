export interface JobHandler<TPayload = unknown, TName extends string = string> {
  readonly jobName: TName;

  handle(payload: TPayload): Promise<void>;
}

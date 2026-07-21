export interface RetentionTask {
  readonly resource: string;

  prune(cutoff: Date): Promise<number>;
}

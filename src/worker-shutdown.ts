export interface WorkerShutdownDependencies {
  healthApp: { close(): Promise<unknown> };
  container: { dispose(): Promise<void> };
}

export function createWorkerShutdown({
  healthApp,
  container,
}: WorkerShutdownDependencies): () => Promise<void> {
  return async () => {
    try {
      await healthApp.close();
    } finally {
      await container.dispose();
    }
  };
}

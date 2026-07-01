export interface ContextData {
  correlationId: string;
}

export interface ContextProvider {
  getAll(): Partial<ContextData>;
}

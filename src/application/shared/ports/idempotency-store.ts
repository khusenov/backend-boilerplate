export interface IdempotentResponse {
  status: number;
  body: string;
  fingerprint: string;
}

export type IdempotencyClaim =
  | { readonly outcome: 'claimed' }
  | { readonly outcome: 'in_flight' }
  | { readonly outcome: 'replayed'; readonly response: IdempotentResponse };

export interface IdempotencyStore {
  claim(key: string): Promise<IdempotencyClaim>;
  complete(key: string, response: IdempotentResponse): Promise<void>;
  release(key: string): Promise<void>;
}

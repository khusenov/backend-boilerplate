import { describe, expect, it } from 'vitest';
import { createSystemActor } from './system-actor';

describe('createSystemActor', () => {
  it('carries the given name and returns a frozen actor', () => {
    const actor = createSystemActor('sync-auth');

    expect(actor.kind).toBe('system');
    expect(actor.name).toBe('sync-auth');
    expect(Object.isFrozen(actor)).toBe(true);
  });
});

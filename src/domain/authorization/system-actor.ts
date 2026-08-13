import type { SystemActor } from './actor';

// The only construction site for the actor kind that bypasses every permission check.
// The cast supplies the phantom brand declared in actor.ts. Never derive one from
// request input or from a job payload — see `system-actor-is-entry-point-only`.
export function createSystemActor(name: string): SystemActor {
  return Object.freeze({ kind: 'system', name }) as SystemActor;
}

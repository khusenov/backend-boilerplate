import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CreateRole } from './create-role';
import { Role } from '@/domain/authorization/role-entity';
import type { IdGenerator } from '@/application/shared/ports/id-generator';
import { RoleNameTakenError, UnknownPermissionError } from '@/domain/authorization/role-errors';
import { StaleAggregateError } from '@/domain/shared/concurrency-errors';
import { createUserActor } from '@/domain/authorization/actor';
import { PermissionDeniedError } from '@/domain/authorization/access-policy-errors';
import { PERMISSIONS } from '@/domain/authorization/permission-catalogue';
import { makeFixedClock, makeUnitOfWork } from '@test/unit/support/fakes';

const ACTOR = createUserActor({
  userId: 'actor-1',
  systemRoleKeys: [],
  permissions: [PERMISSIONS.RolesCreate.key],
});

const UNPRIVILEGED_ACTOR = createUserActor({
  userId: 'actor-2',
  systemRoleKeys: [],
  permissions: [],
});

const CREATED_AT = new Date('2026-01-01T00:00:00.000Z');
const NOW = new Date('2026-06-01T12:00:00.000Z');

function makeCreateRole() {
  const { unitOfWork, context } = makeUnitOfWork();
  context.roleRepository.findByName.mockResolvedValue(null);
  context.roleRepository.save.mockResolvedValue(undefined);

  const ids = {
    generate: vi.fn<IdGenerator['generate']>().mockReturnValue('new-role-id'),
  } satisfies IdGenerator;

  const clock = makeFixedClock(NOW);

  const sut = new CreateRole({ unitOfWork, idGenerator: ids, clock });

  return { sut, unitOfWork, roles: context.roleRepository, ids, clock };
}

describe('CreateRole', () => {
  let ctx: ReturnType<typeof makeCreateRole>;

  beforeEach(() => {
    ctx = makeCreateRole();
  });

  it('rejects a permission key that is not in the catalogue', async () => {
    await expect(
      ctx.sut.execute({ name: 'Editor', permissions: ['users.read', 'users.reed'] }, ACTOR),
    ).rejects.toThrow(UnknownPermissionError);
    expect(ctx.roles.save).not.toHaveBeenCalled();
  });

  it('rejects an unknown permission key without opening a transaction', async () => {
    await expect(
      ctx.sut.execute({ name: 'Editor', permissions: ['users.reed'] }, ACTOR),
    ).rejects.toThrow(UnknownPermissionError);
    expect(ctx.unitOfWork.run).not.toHaveBeenCalled();
  });

  it('rejects a name already held by an active role', async () => {
    ctx.roles.findByName.mockResolvedValue(
      Role.create({ id: 'other', name: 'Editor' }, CREATED_AT),
    );

    await expect(ctx.sut.execute({ name: 'Editor' }, ACTOR)).rejects.toThrow(RoleNameTakenError);
    expect(ctx.roles.save).not.toHaveBeenCalled();
  });

  it('checks uniqueness against the trimmed/normalised name', async () => {
    await ctx.sut.execute({ name: '  Editor  ' }, ACTOR);

    expect(ctx.roles.findByName).toHaveBeenCalledWith('Editor');
  });

  it('persists a new role and returns its DTO', async () => {
    const result = await ctx.sut.execute(
      {
        name: 'Editor',
        description: 'Content team',
        permissions: ['users.read', 'users.update'],
      },
      ACTOR,
    );

    expect(ctx.ids.generate).toHaveBeenCalledOnce();
    expect(ctx.roles.save).toHaveBeenCalledOnce();
    expect(result.id).toBe('new-role-id');
    expect(result.name).toBe('Editor');
    expect(result.key).toBeNull();
    expect(result.isSystem).toBe(false);
    expect([...result.permissions].sort()).toEqual(['users.read', 'users.update']);
  });

  it('does the uniqueness check and the write inside one transaction', async () => {
    await ctx.sut.execute({ name: 'Editor' }, ACTOR);

    expect(ctx.unitOfWork.run).toHaveBeenCalledOnce();
  });

  it('propagates a stale-aggregate conflict from the repository', async () => {
    ctx.roles.save.mockRejectedValue(new StaleAggregateError('Role', 'new-role-id'));

    await expect(ctx.sut.execute({ name: 'Editor' }, ACTOR)).rejects.toThrow(StaleAggregateError);
  });

  it('stamps the new role from a single clock reading', async () => {
    await ctx.sut.execute({ name: 'Editor' }, ACTOR);

    const [savedRole] = ctx.roles.save.mock.calls[0]!;
    expect(savedRole.createdAt).toEqual(NOW);
    expect(savedRole.updatedAt).toEqual(NOW);
    expect(ctx.clock.now).toHaveBeenCalledOnce();
  });
});

describe('CreateRole authorization', () => {
  it('denies a caller without roles.create before touching the repository', async () => {
    const ctx = makeCreateRole();

    await expect(ctx.sut.execute({ name: 'auditor' }, UNPRIVILEGED_ACTOR)).rejects.toThrow(
      PermissionDeniedError,
    );

    expect(ctx.roles.findByName).not.toHaveBeenCalled();
    expect(ctx.roles.save).not.toHaveBeenCalled();
  });

  it('denies an unauthorized caller without opening a transaction', async () => {
    const ctx = makeCreateRole();

    await expect(ctx.sut.execute({ name: 'auditor' }, UNPRIVILEGED_ACTOR)).rejects.toThrow(
      PermissionDeniedError,
    );

    expect(ctx.unitOfWork.run).not.toHaveBeenCalled();
  });
});

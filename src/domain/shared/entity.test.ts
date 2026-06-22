import { describe, expect, it } from 'vitest';
import { Entity } from './entity';
import type { EntityProps } from './entity';

interface TestProps extends EntityProps {
  name: string;
}

class TestEntity extends Entity<TestProps> {
  static create(props: TestProps): TestEntity {
    return new TestEntity(props);
  }

  get name(): string {
    return this.props.name;
  }

  touchPublic(): void {
    this.touch();
  }
}

function makeProps(overrides: Partial<EntityProps> = {}): TestProps {
  const now = new Date('2024-01-01T00:00:00Z');
  return {
    id: 'test-id-1',
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    name: 'test',
    ...overrides,
  };
}

describe('Entity', () => {
  describe('getters', () => {
    it('exposes id', () => {
      const entity = TestEntity.create(makeProps({ id: 'abc-123' }));
      expect(entity.id).toBe('abc-123');
    });

    it('exposes createdAt', () => {
      const date = new Date('2024-06-01T00:00:00Z');
      const entity = TestEntity.create(makeProps({ createdAt: date }));
      expect(entity.createdAt).toBe(date);
    });

    it('exposes updatedAt', () => {
      const date = new Date('2024-06-01T00:00:00Z');
      const entity = TestEntity.create(makeProps({ updatedAt: date }));
      expect(entity.updatedAt).toBe(date);
    });

    it('exposes deletedAt as null when not deleted', () => {
      const entity = TestEntity.create(makeProps({ deletedAt: null }));
      expect(entity.deletedAt).toBeNull();
    });

    it('exposes deletedAt as a date when deleted', () => {
      const date = new Date('2024-06-01T00:00:00Z');
      const entity = TestEntity.create(makeProps({ deletedAt: date }));
      expect(entity.deletedAt).toBe(date);
    });

    it('isDeleted returns false when deletedAt is null', () => {
      const entity = TestEntity.create(makeProps({ deletedAt: null }));
      expect(entity.isDeleted).toBe(false);
    });

    it('isDeleted returns true when deletedAt is set', () => {
      const entity = TestEntity.create(makeProps({ deletedAt: new Date() }));
      expect(entity.isDeleted).toBe(true);
    });
  });

  describe('equals', () => {
    it('returns true for the same instance', () => {
      const entity = TestEntity.create(makeProps());
      expect(entity.equals(entity)).toBe(true);
    });

    it('returns true for two entities with the same id and type', () => {
      const a = TestEntity.create(makeProps({ id: 'same-id' }));
      const b = TestEntity.create(makeProps({ id: 'same-id' }));
      expect(a.equals(b)).toBe(true);
    });

    it('returns false for entities with different ids', () => {
      const a = TestEntity.create(makeProps({ id: 'id-1' }));
      const b = TestEntity.create(makeProps({ id: 'id-2' }));
      expect(a.equals(b)).toBe(false);
    });

    it('returns false when compared with undefined', () => {
      const entity = TestEntity.create(makeProps());
      expect(entity.equals(undefined)).toBe(false);
    });

    it('returns false when compared with a non-Entity object', () => {
      const entity = TestEntity.create(makeProps());
      expect(entity.equals({ id: 'test-id-1' } as unknown as TestEntity)).toBe(false);
    });

    it('returns false for entities of different classes with the same id', () => {
      class OtherEntity extends Entity<TestProps> {
        static create(props: TestProps): OtherEntity {
          return new OtherEntity(props);
        }
      }

      const a = TestEntity.create(makeProps({ id: 'same-id' }));
      const b = OtherEntity.create(makeProps({ id: 'same-id' }));
      expect(a.equals(b)).toBe(false);
    });
  });

  describe('touch', () => {
    it('updates updatedAt to a later time', () => {
      const original = new Date('2024-01-01T00:00:00Z');
      const entity = TestEntity.create(makeProps({ updatedAt: original }));
      entity.touchPublic();
      expect(entity.updatedAt.getTime()).toBeGreaterThanOrEqual(original.getTime());
    });
  });

  describe('softDelete', () => {
    it('sets deletedAt and marks entity as deleted', () => {
      const entity = TestEntity.create(makeProps());
      entity.softDelete();
      expect(entity.isDeleted).toBe(true);
      expect(entity.deletedAt).toBeInstanceOf(Date);
    });

    it('updates updatedAt when soft-deleting', () => {
      const original = new Date('2024-01-01T00:00:00Z');
      const entity = TestEntity.create(makeProps({ updatedAt: original }));
      entity.softDelete();
      expect(entity.updatedAt.getTime()).toBeGreaterThanOrEqual(original.getTime());
    });

    it('is idempotent — calling twice does not change deletedAt', () => {
      const entity = TestEntity.create(makeProps());
      entity.softDelete();
      const firstDeletedAt = entity.deletedAt;
      entity.softDelete();
      expect(entity.deletedAt).toBe(firstDeletedAt);
    });
  });

  describe('restore', () => {
    it('clears deletedAt and marks entity as not deleted', () => {
      const entity = TestEntity.create(makeProps({ deletedAt: new Date() }));
      entity.restore();
      expect(entity.isDeleted).toBe(false);
      expect(entity.deletedAt).toBeNull();
    });

    it('updates updatedAt when restoring', () => {
      const original = new Date('2024-01-01T00:00:00Z');
      const entity = TestEntity.create(makeProps({ updatedAt: original, deletedAt: new Date() }));
      entity.restore();
      expect(entity.updatedAt.getTime()).toBeGreaterThanOrEqual(original.getTime());
    });

    it('is idempotent — calling on a non-deleted entity is a no-op', () => {
      const original = new Date('2024-01-01T00:00:00Z');
      const entity = TestEntity.create(makeProps({ updatedAt: original }));
      entity.restore();
      expect(entity.updatedAt).toBe(original);
      expect(entity.deletedAt).toBeNull();
    });
  });
});

import { describe, expect, it } from 'vitest';
import { ValueObject } from './value-object';

interface NameProps {
  first: string;
  last: string;
}

class Name extends ValueObject<NameProps> {
  static of(first: string, last: string): Name {
    return new Name({ first, last });
  }
}

class Label extends ValueObject<NameProps> {
  static of(first: string, last: string): Label {
    return new Label({ first, last });
  }
}

interface MomentProps {
  at: Date;
}

class Moment extends ValueObject<MomentProps> {
  static of(at: Date): Moment {
    return new Moment({ at });
  }
}

interface WrapperProps {
  name: Name;
}

class Wrapper extends ValueObject<WrapperProps> {
  static of(name: Name): Wrapper {
    return new Wrapper({ name });
  }
}

interface TagProps {
  value: string;
  note?: string;
}

class Tag extends ValueObject<TagProps> {
  static of(value: string, note?: string): Tag {
    return note === undefined ? new Tag({ value }) : new Tag({ value, note });
  }
}

describe('ValueObject', () => {
  describe('equals', () => {
    it('returns true for two instances with equal props', () => {
      expect(Name.of('Ada', 'Lovelace').equals(Name.of('Ada', 'Lovelace'))).toBe(true);
    });

    it('returns false for instances with different props', () => {
      expect(Name.of('Ada', 'Lovelace').equals(Name.of('Grace', 'Hopper'))).toBe(false);
    });

    it('returns true for the same reference', () => {
      const name = Name.of('Ada', 'Lovelace');
      expect(name.equals(name)).toBe(true);
    });

    it('returns false when compared with undefined', () => {
      expect(Name.of('Ada', 'Lovelace').equals(undefined)).toBe(false);
    });

    it('returns false for different subclasses that share a prop shape', () => {
      expect(Name.of('Ada', 'Lovelace').equals(Label.of('Ada', 'Lovelace'))).toBe(false);
    });

    it('compares Date props by value, not reference', () => {
      const a = Moment.of(new Date('2026-01-01T00:00:00.000Z'));
      const b = Moment.of(new Date('2026-01-01T00:00:00.000Z'));
      expect(a.equals(b)).toBe(true);
    });

    it('returns false for Date props with different timestamps', () => {
      const a = Moment.of(new Date('2026-01-01T00:00:00.000Z'));
      const b = Moment.of(new Date('2026-06-01T00:00:00.000Z'));
      expect(a.equals(b)).toBe(false);
    });

    it('compares nested value-object props recursively', () => {
      const a = Wrapper.of(Name.of('Ada', 'Lovelace'));
      const b = Wrapper.of(Name.of('Ada', 'Lovelace'));
      expect(a.equals(b)).toBe(true);
    });

    it('returns false for nested value objects with different inner values', () => {
      const a = Wrapper.of(Name.of('Ada', 'Lovelace'));
      const b = Wrapper.of(Name.of('Grace', 'Hopper'));
      expect(a.equals(b)).toBe(false);
    });

    it('returns false when one instance omits an optional prop', () => {
      expect(Tag.of('x').equals(Tag.of('x', 'note'))).toBe(false);
    });
  });

  describe('immutability', () => {
    it('freezes props so they cannot be mutated', () => {
      const name = Name.of('Ada', 'Lovelace');
      const exposed = name as unknown as { props: NameProps };
      expect(Object.isFrozen(exposed.props)).toBe(true);
    });
  });
});

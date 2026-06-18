import { ValidationError } from '@/shared/errors';

export class InvalidEmailError extends ValidationError {
  constructor(email: string) {
    super(`Invalid email address: ${email}`, { code: 'INVALID_EMAIL' });
  }
}

export class Email {
  private constructor(public readonly value: string) {}

  static create(raw: string): Email {
    const normalized = raw.trim().toLowerCase();
    const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized);
    if (!valid) throw new InvalidEmailError(raw);
    return new Email(normalized);
  }

  equals(other?: Email): boolean {
    if (other === null || other === undefined) return false;
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}

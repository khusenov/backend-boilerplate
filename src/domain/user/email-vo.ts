import { ValidationError } from '@/shared/errors';
import { ValueObject } from '@/domain/shared/value-object';

export class InvalidEmailError extends ValidationError {
  constructor(email: string) {
    super(`Invalid email address: ${email}`, { code: 'INVALID_EMAIL' });
  }
}

interface EmailProps {
  value: string;
}

export class Email extends ValueObject<EmailProps> {
  private constructor(props: EmailProps) {
    super(props);
  }

  static create(raw: string): Email {
    const normalized = raw.trim().toLowerCase();
    const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized);
    if (!valid) throw new InvalidEmailError(raw);
    return new Email({ value: normalized });
  }

  get value(): string {
    return this.props.value;
  }

  override toString(): string {
    return this.props.value;
  }
}

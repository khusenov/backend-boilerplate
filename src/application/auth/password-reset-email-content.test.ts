import { describe, expect, it } from 'vitest';
import { renderPasswordResetEmail } from './password-reset-email-content';

const RESET_URL = 'http://localhost:3000/reset-password?token=abc123';

describe('renderPasswordResetEmail', () => {
  it('carries a non-empty subject', () => {
    expect(renderPasswordResetEmail(RESET_URL).subject).not.toBe('');
  });

  it('puts the url in the plain-text body', () => {
    expect(renderPasswordResetEmail(RESET_URL).text).toContain(RESET_URL);
  });

  it('puts the url in the html body', () => {
    expect(renderPasswordResetEmail(RESET_URL).html).toContain(RESET_URL);
  });

  it('is pure — the same url renders identical content', () => {
    expect(renderPasswordResetEmail(RESET_URL)).toEqual(renderPasswordResetEmail(RESET_URL));
  });

  it('keeps the subject free of the url, since subjects leak into notifications', () => {
    expect(renderPasswordResetEmail(RESET_URL).subject).not.toContain(RESET_URL);
  });
});

import { describe, expect, it } from 'vitest';
import { renderVerificationEmail } from './verification-email-content';

describe('renderVerificationEmail', () => {
  it('carries a non-empty subject', () => {
    expect(renderVerificationEmail('123456').subject).not.toBe('');
  });

  it('puts the code in the plain-text body', () => {
    expect(renderVerificationEmail('123456').text).toContain('123456');
  });

  it('puts the code in the html body', () => {
    expect(renderVerificationEmail('123456').html).toContain('123456');
  });

  it('preserves a zero-padded code verbatim', () => {
    const content = renderVerificationEmail('000042');

    expect(content.text).toContain('000042');
    expect(content.html).toContain('000042');
  });

  it('is pure — the same code renders identical content', () => {
    expect(renderVerificationEmail('123456')).toEqual(renderVerificationEmail('123456'));
  });

  it('keeps the subject free of the code, since subjects leak into notifications', () => {
    expect(renderVerificationEmail('123456').subject).not.toContain('123456');
  });
});

import { describe, it, expect } from 'vitest';
import { pino, type DestinationStream } from 'pino';
import { createLoggerOptions, REDACT_PATHS, REDACT_CENSOR } from './logger-options';

function makeSink(): { lines: string[]; stream: DestinationStream } {
  const lines: string[] = [];
  return {
    lines,
    stream: {
      write: (chunk: string) => {
        lines.push(chunk);
      },
    },
  };
}

function logAndParse(payload: Record<string, unknown>): Record<string, unknown> {
  const { lines, stream } = makeSink();
  pino(createLoggerOptions('info'), stream).info(payload, 'test');
  const line = lines[0];
  if (line === undefined) throw new Error('expected a serialized log line');
  return JSON.parse(line) as Record<string, unknown>;
}

describe('createLoggerOptions', () => {
  it('sets the provided level', () => {
    expect(createLoggerOptions('debug').level).toBe('debug');
  });

  it('wires redaction from the shared registry', () => {
    const redact = createLoggerOptions('info').redact as { paths: string[]; censor: string };
    expect(redact.censor).toBe(REDACT_CENSOR);
    expect(redact.paths).toEqual([...REDACT_PATHS]);
  });
});

describe('redaction behaviour', () => {
  it('censors an authorization header nested under a request container', () => {
    const logged = logAndParse({ req: { headers: { authorization: 'Bearer super-secret' } } });
    const req = logged.req as { headers: { authorization: string } };
    expect(req.headers.authorization).toBe(REDACT_CENSOR);
  });

  it('censors a top-level authorization header', () => {
    const logged = logAndParse({ headers: { authorization: 'Bearer top-level' } });
    const headers = logged.headers as { authorization: string };
    expect(headers.authorization).toBe(REDACT_CENSOR);
  });

  it('censors a set-cookie value on a response-shaped payload', () => {
    const logged = logAndParse({ res: { headers: { 'set-cookie': 'sid=SECRET' } } });
    const res = logged.res as { headers: Record<string, string> };
    expect(res.headers['set-cookie']).toBe(REDACT_CENSOR);
  });

  it('censors top-level credential fields', () => {
    const logged = logAndParse({ password: 'hunter2', token: 'tok_live_1', secret: 'shhh' });
    expect(logged.password).toBe(REDACT_CENSOR);
    expect(logged.token).toBe(REDACT_CENSOR);
    expect(logged.secret).toBe(REDACT_CENSOR);
  });

  it('censors credential fields nested one level deep', () => {
    const logged = logAndParse({ body: { password: 'hunter2' } });
    const body = logged.body as { password: string };
    expect(body.password).toBe(REDACT_CENSOR);
  });

  it('never emits the raw secret value in the serialized line', () => {
    const { lines, stream } = makeSink();
    pino(createLoggerOptions('info'), stream).info(
      { req: { headers: { authorization: 'Bearer leaked-value' } } },
      'test',
    );
    const line = lines[0];
    expect(line).toBeDefined();
    expect(line).not.toContain('leaked-value');
  });

  it('leaves non-sensitive fields untouched', () => {
    const logged = logAndParse({ userId: 'u_1', correlationId: 'c_1' });
    expect(logged.userId).toBe('u_1');
    expect(logged.correlationId).toBe('c_1');
  });
});

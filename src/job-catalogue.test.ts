import { readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JOB_NAMES } from '@/job-catalogue';

const GENERATED_DIRECTORY = 'generated';
const EXPORTED_STRING_CONSTANT = /export const ([A-Z0-9_]+)\s*=\s*'([^']+)'/g;
const HANDLER_JOB_NAME = /readonly jobName(?:\s*:[^=]+)?\s*=\s*([^;]+);/g;

function sourceFilesUnder(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.test.ts') &&
        !entry.parentPath.split(sep).includes(GENERATED_DIRECTORY),
    )
    .map((entry) => join(entry.parentPath, entry.name));
}

function stringConstantsIn(sources: string[]): Map<string, string> {
  return new Map(
    sources
      .flatMap((source) => [...source.matchAll(EXPORTED_STRING_CONSTANT)])
      .map(([, name = '', value = '']) => [name, value]),
  );
}

function declaredJobNamesIn(sources: string[], constants: Map<string, string>): string[] {
  return sources
    .flatMap((source) => [...source.matchAll(HANDLER_JOB_NAME)])
    .map(([, expression = '']) => expression.trim())
    .map((expression) =>
      expression.startsWith("'")
        ? expression.slice(1, -1)
        : (constants.get(expression) ?? expression),
    );
}

describe('JOB_NAMES', () => {
  it('lists the job name of every handler in the codebase', () => {
    const sources = sourceFilesUnder(import.meta.dirname).map((path) => readFileSync(path, 'utf8'));

    expect(declaredJobNamesIn(sources, stringConstantsIn(sources)).sort()).toEqual(
      [...JOB_NAMES].sort(),
    );
  });
});

import { describe, expect, it } from 'vitest';
import { createPage, normalizePageQuery } from './pagination';

describe('normalizePageQuery', () => {
  it('returns defaults when no input is given', () => {
    expect(normalizePageQuery({})).toEqual({ page: 1, pageSize: 10 });
  });

  it('returns the provided page and pageSize', () => {
    expect(normalizePageQuery({ page: 3, pageSize: 25 })).toEqual({ page: 3, pageSize: 25 });
  });

  it('clamps page to 1 when 0 is provided', () => {
    expect(normalizePageQuery({ page: 0 })).toEqual({ page: 1, pageSize: 10 });
  });

  it('clamps page to 1 when a negative number is provided', () => {
    expect(normalizePageQuery({ page: -5 })).toEqual({ page: 1, pageSize: 10 });
  });

  it('clamps pageSize to 1 when 0 is provided', () => {
    expect(normalizePageQuery({ pageSize: 0 })).toEqual({ page: 1, pageSize: 1 });
  });

  it('clamps pageSize to 100 when a value above the maximum is provided', () => {
    expect(normalizePageQuery({ pageSize: 200 })).toEqual({ page: 1, pageSize: 100 });
  });

  it('truncates fractional page values', () => {
    expect(normalizePageQuery({ page: 2.9 })).toEqual({ page: 2, pageSize: 10 });
  });

  it('truncates fractional pageSize values', () => {
    expect(normalizePageQuery({ pageSize: 15.7 })).toEqual({ page: 1, pageSize: 15 });
  });
});

describe('createPage', () => {
  it('returns structured page metadata', () => {
    const result = createPage(['a', 'b'], 20, { page: 1, pageSize: 10 });

    expect(result).toEqual({
      items: ['a', 'b'],
      page: 1,
      pageSize: 10,
      total: 20,
      hasNext: true,
      hasPrev: false,
    });
  });

  it('sets hasNext to false on the last page', () => {
    const result = createPage(['a'], 10, { page: 2, pageSize: 5 });

    expect(result.hasNext).toBe(false);
  });

  it('sets hasPrev to true for pages beyond the first', () => {
    const result = createPage(['a'], 10, { page: 2, pageSize: 5 });

    expect(result.hasPrev).toBe(true);
  });

  it('sets hasPrev to false on the first page', () => {
    const result = createPage(['a'], 10, { page: 1, pageSize: 5 });

    expect(result.hasPrev).toBe(false);
  });

  it('handles an empty result set', () => {
    const result = createPage([], 0, { page: 1, pageSize: 10 });

    expect(result).toEqual({
      items: [],
      page: 1,
      pageSize: 10,
      total: 0,
      hasNext: false,
      hasPrev: false,
    });
  });

  it('sets hasNext to false when total is exactly one full page', () => {
    const result = createPage(['a', 'b', 'c'], 3, { page: 1, pageSize: 3 });

    expect(result.hasNext).toBe(false);
  });
});

export interface PageQuery {
  page: number;
  pageSize: number;
}

export interface PageQueryInput {
  page?: number | undefined;
  pageSize?: number | undefined;
}

export interface PageSlice<T> {
  items: T[];
  total: number;
}

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  hasNext: boolean;
  hasPrev: boolean;
}

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 100;

export function normalizePageQuery(input: PageQueryInput): PageQuery {
  const page = Math.max(1, Math.trunc(input.page ?? DEFAULT_PAGE));
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Math.trunc(input.pageSize ?? DEFAULT_PAGE_SIZE)),
  );
  return { page, pageSize };
}

export function createPage<T>(items: T[], total: number, query: PageQuery): Page<T> {
  const totalPages = Math.ceil(total / query.pageSize);
  return {
    items,
    page: query.page,
    pageSize: query.pageSize,
    total,
    hasNext: query.page < totalPages,
    hasPrev: query.page > 1,
  };
}

import type { Response } from 'express';

const toSnakeKey = (key: string) =>
  key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

export function toSnakeCase(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => toSnakeCase(entry));
  }

  if (value && typeof value === 'object') {
    const plain = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(plain).map(([key, entry]) => [toSnakeKey(key), toSnakeCase(entry)]),
    );
  }

  return value;
}

export function payrollResponse<T>(data: T) {
  return { success: true, data: toSnakeCase(data) };
}

export function payrollPaginated<T>(
  rows: T[],
  total: number,
  page: number,
  perPage: number,
) {
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  return {
    current_page: page,
    data: rows,
    last_page: lastPage,
    per_page: perPage,
    total,
    from: total === 0 ? null : (page - 1) * perPage + 1,
    to: total === 0 ? null : Math.min(page * perPage, total),
    next_page_url: page < lastPage ? '' : null,
    prev_page_url: page > 1 ? '' : null,
  };
}

export function sendPayrollError(res: Response, error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : fallback;
  return res.status(400).json({ message });
}

export function sendPayrollNotFound(res: Response, message: string) {
  return res.status(404).json({ message });
}
